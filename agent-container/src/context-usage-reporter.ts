import { randomUUID } from 'node:crypto';
import { contextBreakdownSchema, type ContextBreakdown } from './context-breakdown-schema';
import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';

/**
 * The context's size as the CLI counts it, against the window it
 * auto-compacts at. `settled` marks a size a turn end or a compaction left,
 * which the host saves; other sizes are mid-turn and only go out.
 */
export interface ContextUsageFrame {
  revision?: string;
  measuredAt?: string;
  breakdown?: ContextBreakdown;
  breakdownKind?: 'full';
  type: 'context_usage';
  totalTokens: number;
  contextWindow: number;
  settled: boolean;
}

type ContextMovingMessage = { type: string; subtype?: string; parent_tool_use_id?: string | null };

/**
 * Whether the CLI's count moved with this message, and if so whether the
 * size is settled. `null` when the count did not move.
 */
export function contextUsageChange(message: ContextMovingMessage): { settled: boolean } | null {
  if (message.type === 'result') return { settled: true };
  if (message.type === 'system' && message.subtype === 'compact_boundary') return { settled: true };
  if (message.type === 'system' && message.subtype === 'init') return { settled: false };
  // A subagent's calls fill its own context, not the main loop's.
  if (message.type === 'assistant' && !message.parent_tool_use_id) return { settled: false };
  return null;
}

/**
 * Mid-turn updates need only totals. At turn end or compaction, capture the
 * full SDK count while the query still owns that context. A later revision
 * supersedes an in-flight measurement.
 */
export class ContextUsageReporter {
  revision: string = randomUUID();
  private lastSettled?: ContextUsageFrame;

  get settledFrame(): ContextUsageFrame | undefined {
    return this.lastSettled?.revision === this.revision ? this.lastSettled : undefined;
  }

  private reading = false;
  private pending: boolean | undefined;
  private warned = false;

  constructor(
    private readonly read: (detail: 'summary' | 'full') => Promise<SDKControlGetContextUsageResponse | undefined>,
    private readonly send: (frame: ContextUsageFrame) => void,
  ) {}

  refresh(settled: boolean): void {
    this.revision = randomUUID();
    if (this.reading) {
      this.pending = settled;
      return;
    }
    void this.readAndSend(settled);
  }

  private async readAndSend(settled: boolean): Promise<void> {
    this.reading = true;
    const revision = this.revision;
    try {
      const frame = await this.measure(settled, revision);
      if (frame && revision === this.revision) {
        if (settled) this.lastSettled = frame;
        this.send(frame);
      }
    } catch (error) {
      this.warn(error);
    } finally {
      this.reading = false;
    }
    const next = this.pending;
    this.pending = undefined;
    if (next !== undefined) void this.readAndSend(next);
  }

  private async measure(settled: boolean, revision: string): Promise<ContextUsageFrame | undefined> {
    if (settled) {
      try {
        const usage = await this.read('full');
        if (!usage) return;
        const breakdown = contextBreakdownSchema.parse(usage);
        return {
          type: 'context_usage', settled, totalTokens: breakdown.totalTokens, contextWindow: breakdown.rawMaxTokens,
          revision, measuredAt: new Date().toISOString(), breakdownKind: 'full', breakdown,
        };
      } catch (error) {
        // If the provider cannot count the categories, keep the composer's
        // totals without recording estimated rows as a full measurement.
        this.warn(error);
        if (revision !== this.revision) return;
      }
    }
    const usage = await this.read('summary');
    if (usage) return { type: 'context_usage', settled, totalTokens: usage.totalTokens, contextWindow: usage.rawMaxTokens };
  }

  private warn(error: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn('[ContextUsage] getContextUsage failed:', error);
  }
}
