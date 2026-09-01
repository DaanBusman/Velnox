import { hostname } from 'node:os';
import type { Job } from 'bullmq';

export interface PingJobData {
  requestedAt: string;
}

export interface PingJobResult {
  processedBy: string;
  durationMs: number;
  message: string;
}

/**
 * Phase 1 queue self-test.
 *
 * Its only job is to prove that work submitted by the API is actually executed
 * by this process — the acceptance criterion for the Phase 1 queue. It takes a
 * visible amount of time on purpose, so the UI shows a real transition through
 * `waiting` and `active` rather than a state that is `completed` before the
 * first poll.
 *
 * Phase 5 replaces this with the playbook runner. Nothing here is load-bearing.
 */
export async function processPing(
  job: Job<PingJobData, PingJobResult>,
  options: { delayMs?: number } = {},
): Promise<PingJobResult> {
  const started = Date.now();
  const delayMs = options.delayMs ?? 1_500;

  await job.updateProgress(10);
  await sleep(delayMs / 2);
  await job.updateProgress(60);
  await sleep(delayMs / 2);
  await job.updateProgress(100);

  return {
    processedBy: hostname(),
    durationMs: Date.now() - started,
    message: 'Queue round trip completed: the API enqueued this job and the worker executed it.',
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
