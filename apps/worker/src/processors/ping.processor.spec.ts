import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { processPing, type PingJobData, type PingJobResult } from './ping.processor';

function fakeJob(): { job: Job<PingJobData, PingJobResult>; progress: number[] } {
  const progress: number[] = [];
  const job = {
    id: 'test-1',
    name: 'system.ping',
    data: { requestedAt: new Date().toISOString() },
    updateProgress: vi.fn(async (value: number) => {
      progress.push(value);
    }),
  } as unknown as Job<PingJobData, PingJobResult>;
  return { job, progress };
}

describe('processPing', () => {
  it('reports progress monotonically and finishes at 100', async () => {
    const { job, progress } = fakeJob();
    await processPing(job, { delayMs: 0 });

    expect(progress.at(-1)).toBe(100);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
  });

  it('returns the host that executed it, which is what proves the round trip', async () => {
    const { job } = fakeJob();
    const result = await processPing(job, { delayMs: 0 });

    expect(result.processedBy).toBeTruthy();
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.message).toContain('worker executed it');
  });

  it('actually waits for the configured delay', async () => {
    const { job } = fakeJob();
    const started = Date.now();
    await processPing(job, { delayMs: 60 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });
});
