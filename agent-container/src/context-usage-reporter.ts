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
 * Reads the CLI's `/context` summary (no token-count API calls) and sends it
 * on. One read at a time: a request during a read runs once after it, so a
 * burst of frames costs one more read, not one each.
 */
export class ContextUsageReporter {
  revision: string = randomUUID();
  private lastSettled?: ContextUsageFrame;

  get settledFrame(): ContextUsageFrame | undefined {
    return this.lastSettled?.revision === this.revision ? this.lastSettled : undefined;
  }

  private reading = false;
  private pending: { settled: boolean } | null = null;
  private warned = false;

  constructor(
    private readonly read: () => Promise<SDKControlGetContextUsageResponse | undefined>,
    private readonly send: (frame: ContextUsageFrame) => void,
  ) {}

  refresh(settled: boolean): void {
    this.revision = randomUUID();
    if (this.reading) {
      // The read after this one must still be saved if any request was settled.
      this.pending = { settled: settled || this.pending?.settled === true };
      return;
    }
    void this.readAndSend(settled);
  }

  private async readAndSend(settled: boolean): Promise<void> {
    this.reading = true;
    const revision = this.revision;
    try {
      const usage = await this.read();
      if (usage) {
        // Only settled snapshots cross the wire with rows. The host saves the
        // public totals and displayable detail separately.
        const projected = settled ? contextBreakdownSchema.safeParse(usage) : undefined;
        const frame: ContextUsageFrame = {
          type: 'context_usage', totalTokens: usage.totalTokens, contextWindow: usage.rawMaxTokens, settled,
          ...(projected?.success && { revision, measuredAt: new Date().toISOString(), breakdown: projected.data }),
        };
        if (settled) this.lastSettled = frame;
        this.send(frame);
      }
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        console.warn('[ContextUsage] getContextUsage failed:', error);
      }
    } finally {
      this.reading = false;
    }
    const next = this.pending;
    this.pending = null;
    if (next) void this.readAndSend(next.settled);
  }
}
