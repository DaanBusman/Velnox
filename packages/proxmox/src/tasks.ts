import type { ProxmoxClient, TaskStatus } from './client';

/**
 * UPIDs — Proxmox's identifier for a long-running task.
 *
 * Every mutating API call returns one of these instead of waiting. It looks like:
 *
 *     UPID:pve1:0000C8D1:0AB3F2E1:65D3A1B0:vzdump:100:root@pam:
 *
 * The fields are node, pid, pstart, starttime, type, id, user — colon separated,
 * with a trailing colon. Parsing it matters because the node name inside it is
 * the only way to know which node to ask about a task's progress, and a cluster
 * will happily hand you a UPID for a node other than the one you asked.
 *
 * Nothing in phase 4 starts a task. This exists now because the update and
 * upgrade phases are entirely built on it, and because a poller written against
 * a real UPID today is a poller that does not need inventing during the phase
 * that has to reboot somebody's hypervisor.
 */

export interface Upid {
  raw: string;
  node: string;
  pid: number;
  pstart: number;
  startTime: Date;
  type: string;
  /** What the task is about: a VMID, a storage name, or empty. */
  id: string;
  user: string;
}

export class InvalidUpidError extends Error {
  constructor(value: string) {
    super(`Not a UPID: ${value.slice(0, 120)}`);
    this.name = 'InvalidUpidError';
  }
}

/**
 * Split a UPID.
 *
 * The user field contains an `@` and the id field can be empty, so this splits
 * on position rather than searching — a UPID has exactly nine colon-separated
 * fields including the empty one after the trailing colon.
 */
export function parseUpid(value: string): Upid {
  if (!value.startsWith('UPID:')) throw new InvalidUpidError(value);

  const parts = value.split(':');
  // UPID, node, pid, pstart, starttime, type, id, user, and the empty tail.
  if (parts.length < 9) throw new InvalidUpidError(value);

  const [, node, pid, pstart, starttime, type, id, user] = parts;

  if (!node || !pid || !pstart || !starttime || !type || user === undefined) {
    throw new InvalidUpidError(value);
  }

  const pidNumber = Number.parseInt(pid, 16);
  const pstartNumber = Number.parseInt(pstart, 16);
  const startSeconds = Number.parseInt(starttime, 16);

  if (!Number.isFinite(pidNumber) || !Number.isFinite(startSeconds)) {
    throw new InvalidUpidError(value);
  }

  return {
    raw: value,
    node,
    pid: pidNumber,
    pstart: pstartNumber,
    startTime: new Date(startSeconds * 1000),
    type,
    id: id ?? '',
    user,
  };
}

export interface TaskOutcome {
  upid: string;
  node: string;
  /** Proxmox's own word for success. Anything else is a failure. */
  exitStatus: string;
  succeeded: boolean;
  status: TaskStatus;
  durationMs: number;
}

export interface PollOptions {
  /** How often to ask. Proxmox is cheap to poll; the network usually is not. */
  intervalMs?: number;
  /** Give up after this long and say so, rather than waiting for ever. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called on every poll, so a job can stream progress without owning the loop. */
  onPoll?: (status: TaskStatus) => void;
}

export class TaskTimeoutError extends Error {
  constructor(
    readonly upid: string,
    readonly waitedMs: number,
  ) {
    super(`Task ${upid} was still running after ${Math.round(waitedMs / 1000)}s`);
    this.name = 'TaskTimeoutError';
  }
}

export class TaskCancelledError extends Error {
  constructor(readonly upid: string) {
    super(`Stopped waiting for ${upid}`);
    this.name = 'TaskCancelledError';
  }
}

/** Proxmox says `OK` for success. Everything else — including `WARNINGS: 3` — is not. */
export const taskSucceeded = (exitStatus: string | undefined): boolean => exitStatus === 'OK';

/**
 * Wait for a task to finish.
 *
 * Polling rather than a stream, because Proxmox offers no push and a long-poll
 * on a management network is a connection that dies silently. The timeout is
 * required in spirit: a caller that waits for ever is a job that can never be
 * reconciled, and phase 5's crash recovery depends on every wait having an end.
 */
export async function waitForTask(
  client: ProxmoxClient,
  upid: string,
  options: PollOptions = {},
): Promise<TaskOutcome> {
  const parsed = parseUpid(upid);
  const interval = options.intervalMs ?? 2_000;
  const timeout = options.timeoutMs ?? 30 * 60 * 1000;
  const started = Date.now();

  for (;;) {
    if (options.signal?.aborted) throw new TaskCancelledError(upid);

    const status = await client.taskStatus(parsed.node, upid);
    options.onPoll?.(status);

    if (status.status === 'stopped') {
      const exitStatus = status.exitstatus ?? 'unknown';
      return {
        upid,
        node: parsed.node,
        exitStatus,
        succeeded: taskSucceeded(status.exitstatus),
        status,
        durationMs: Date.now() - started,
      };
    }

    const waited = Date.now() - started;
    if (waited >= timeout) throw new TaskTimeoutError(upid, waited);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, interval);
      options.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new TaskCancelledError(upid));
        },
        { once: true },
      );
    });
  }
}
