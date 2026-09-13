import { describe, expect, it, vi } from 'vitest';
import { InvalidUpidError, parseUpid, taskSucceeded, waitForTask } from './tasks';
import type { ProxmoxClient, TaskStatus } from './client';

/**
 * UPID parsing, and waiting for a task.
 *
 * Nothing in phase 4 starts a task. This is here now because phases 6 to 9 are
 * built entirely on it, and the node name inside a UPID is the only way to know
 * which node to ask about progress — a cluster will hand you a UPID for a node
 * other than the one you called.
 */

const UPID = 'UPID:pve1:0000C8D1:0AB3F2E1:65D3A1B0:vzdump:100:root@pam:';

describe('parsing a UPID', () => {
  it('reads the node, which is the field that matters', () => {
    expect(parseUpid(UPID).node).toBe('pve1');
  });

  it('reads the rest of it', () => {
    const upid = parseUpid(UPID);
    expect(upid.pid).toBe(0xc8d1);
    expect(upid.type).toBe('vzdump');
    expect(upid.id).toBe('100');
    expect(upid.user).toBe('root@pam');
    expect(upid.startTime.toISOString()).toBe('2024-02-19T18:45:04.000Z');
  });

  it('handles an empty id, which is normal for a task about nothing in particular', () => {
    const upid = parseUpid('UPID:pve2:00001234:00005678:65D3A1B0:srvreload::root@pam:');
    expect(upid.id).toBe('');
    expect(upid.type).toBe('srvreload');
    expect(upid.user).toBe('root@pam');
  });

  it('handles a user with a token id, which contains a second separator', () => {
    // `root@pam!velnox` is what an API token's tasks are attributed to, and the
    // `!` is not a field separator — splitting on anything but position gets
    // this wrong.
    const upid = parseUpid('UPID:pve1:00001234:00005678:65D3A1B0:aptupdate::root@pam!velnox:');
    expect(upid.user).toBe('root@pam!velnox');
  });

  it('refuses anything that is not one', () => {
    expect(() => parseUpid('')).toThrow(InvalidUpidError);
    expect(() => parseUpid('UPID:pve1')).toThrow(InvalidUpidError);
    expect(() => parseUpid('OK')).toThrow(InvalidUpidError);
  });
});

describe('what counts as success', () => {
  it('is exactly OK', () => {
    expect(taskSucceeded('OK')).toBe(true);
  });

  it('is not a warning', () => {
    // `WARNINGS: 3` is a completed task that did something it wants read. A
    // rolling update that treats it as success continues to the next node.
    expect(taskSucceeded('WARNINGS: 3')).toBe(false);
    expect(taskSucceeded(undefined)).toBe(false);
    expect(taskSucceeded('')).toBe(false);
  });
});

describe('waiting for a task', () => {
  const clientReturning = (statuses: TaskStatus[]): ProxmoxClient => {
    const queue = [...statuses];
    return {
      taskStatus: vi.fn(async () => queue.shift() ?? statuses[statuses.length - 1]!),
    } as unknown as ProxmoxClient;
  };

  it('polls until the task stops, and asks the node named in the UPID', async () => {
    const client = clientReturning([
      { upid: UPID, node: 'pve1', status: 'running' },
      { upid: UPID, node: 'pve1', status: 'running' },
      { upid: UPID, node: 'pve1', status: 'stopped', exitstatus: 'OK' },
    ]);

    const outcome = await waitForTask(client, UPID, { intervalMs: 1 });

    expect(outcome.succeeded).toBe(true);
    expect(outcome.exitStatus).toBe('OK');
    expect(client.taskStatus).toHaveBeenCalledTimes(3);
    expect(client.taskStatus).toHaveBeenCalledWith('pve1', UPID);
  });

  it('reports a failure as a result, not as an exception', async () => {
    // A task that failed is a fact about the cluster. Throwing would make the
    // caller unable to tell it apart from Velnox failing to ask.
    const client = clientReturning([
      {
        upid: UPID,
        node: 'pve1',
        status: 'stopped',
        exitstatus: 'command failed with exit code 1',
      },
    ]);

    const outcome = await waitForTask(client, UPID, { intervalMs: 1 });
    expect(outcome.succeeded).toBe(false);
    expect(outcome.exitStatus).toBe('command failed with exit code 1');
  });

  it('gives up rather than waiting for ever', async () => {
    const client = clientReturning([{ upid: UPID, node: 'pve1', status: 'running' }]);
    await expect(waitForTask(client, UPID, { intervalMs: 1, timeoutMs: 5 })).rejects.toThrow(
      /still running/,
    );
  });

  it('stops when told to', async () => {
    const controller = new AbortController();
    const client = clientReturning([{ upid: UPID, node: 'pve1', status: 'running' }]);

    const waiting = waitForTask(client, UPID, { intervalMs: 5, signal: controller.signal });
    controller.abort();

    await expect(waiting).rejects.toThrow(/Stopped waiting/);
  });

  it('reports progress on every poll', async () => {
    const seen: string[] = [];
    const client = clientReturning([
      { upid: UPID, node: 'pve1', status: 'running' },
      { upid: UPID, node: 'pve1', status: 'stopped', exitstatus: 'OK' },
    ]);

    await waitForTask(client, UPID, { intervalMs: 1, onPoll: (s) => seen.push(s.status) });
    expect(seen).toEqual(['running', 'stopped']);
  });
});
