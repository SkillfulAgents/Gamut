import { describe, it, expect, vi } from 'vitest';
import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { ContextUsageReporter, contextUsageChange, type ContextUsageFrame } from './context-usage-reporter';

function summary(totalTokens: number, rawMaxTokens = 1_000_000): SDKControlGetContextUsageResponse {
  return { totalTokens, maxTokens: rawMaxTokens, rawMaxTokens } as SDKControlGetContextUsageResponse;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('contextUsageChange', () => {
  it('marks turn ends and compactions settled', () => {
    expect(contextUsageChange({ type: 'result', subtype: 'success' })).toEqual({ settled: true });
    expect(contextUsageChange({ type: 'system', subtype: 'compact_boundary' })).toEqual({ settled: true });
  });

  it('marks a main-loop call and a query start mid-turn', () => {
    expect(contextUsageChange({ type: 'assistant', parent_tool_use_id: null })).toEqual({ settled: false });
    expect(contextUsageChange({ type: 'system', subtype: 'init' })).toEqual({ settled: false });
  });

  it('ignores subagent calls and frames that do not move the count', () => {
    expect(contextUsageChange({ type: 'assistant', parent_tool_use_id: 'toolu_1' })).toBeNull();
    expect(contextUsageChange({ type: 'stream_event' })).toBeNull();
    expect(contextUsageChange({ type: 'user' })).toBeNull();
    expect(contextUsageChange({ type: 'system', subtype: 'status' })).toBeNull();
  });
});

describe('ContextUsageReporter', () => {
  it('requests only summary totals mid-turn', async () => {
    const send = vi.fn();
    const read = vi.fn(async () => summary(64_041));
    const reporter = new ContextUsageReporter(read, send);
    reporter.refresh(false);
    await flush();
    expect(read).toHaveBeenCalledExactlyOnceWith('summary');
    expect(send).toHaveBeenCalledWith({ type: 'context_usage', totalTokens: 64_041, contextWindow: 1_000_000, settled: false });
  });

  it('captures full rows automatically and replays them only for their revision', async () => {
    const counted = {
      ...summary(400, 2000), percentage: 20,
      categories: [{ name: 'Messages', kind: 'used', tokens: 400, color: 'blue' }],
    } as SDKControlGetContextUsageResponse;
    const send = vi.fn();
    const read = vi.fn(async (detail: 'summary' | 'full') => detail === 'full' ? counted : summary(350, 2000));
    const reporter = new ContextUsageReporter(read, send);
    reporter.refresh(true);
    await flush();
    expect(read).toHaveBeenCalledExactlyOnceWith('full');
    expect(reporter.settledFrame).toMatchObject({
      breakdownKind: 'full', totalTokens: 400, revision: reporter.revision, measuredAt: expect.any(String),
      breakdown: { categories: [{ name: 'Messages', kind: 'used', tokens: 400 }] },
    });
    reporter.refresh(false);
    expect(reporter.settledFrame).toBeUndefined();
    await flush();
    expect(send.mock.calls[1][0].totalTokens).toBe(350);
    expect(send.mock.calls[1][0].breakdown).toBeUndefined();
  });

  it('drops a superseded full count and reads the latest revision once', async () => {
    const first = deferred<SDKControlGetContextUsageResponse>();
    const read = vi.fn((detail: 'summary' | 'full') => detail === 'full' ? first.promise : Promise.resolve(summary(32_166)));
    const sent: ContextUsageFrame[] = [];
    const reporter = new ContextUsageReporter(read, frame => sent.push(frame));
    reporter.refresh(true);
    reporter.refresh(false);
    reporter.refresh(true);
    reporter.refresh(false);
    first.resolve({ ...summary(400), categories: [], percentage: 4 });
    await flush();
    expect(read.mock.calls).toEqual([['full'], ['summary']]);
    expect(sent).toEqual([{ type: 'context_usage', totalTokens: 32_166, contextWindow: 1_000_000, settled: false }]);
    expect(reporter.settledFrame).toBeUndefined();
  });

  it('keeps totals if a full count fails and retries full detail at the next turn end', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const read = vi.fn<(detail: 'full' | 'summary') => Promise<SDKControlGetContextUsageResponse | undefined>>()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('count unavailable'))
        .mockResolvedValueOnce(summary(2_717))
        .mockResolvedValueOnce({ ...summary(4_000), percentage: 2, categories: [] });
      const send = vi.fn();
      const reporter = new ContextUsageReporter(read, send);
      for (let i = 0; i < 3; i++) {
        reporter.refresh(true);
        await flush();
      }
      expect(read.mock.calls).toEqual([['full'], ['full'], ['summary'], ['full']]);
      expect(send.mock.calls[0][0]).toEqual({ type: 'context_usage', totalTokens: 2_717, contextWindow: 1_000_000, settled: true });
      expect(send.mock.calls[1][0]).toMatchObject({ breakdownKind: 'full', totalTokens: 4_000 });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
