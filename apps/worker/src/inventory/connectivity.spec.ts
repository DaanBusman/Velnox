import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_CODES, unreachableReasonOf } from '@velnox/shared';
import {
  ConnectivityChecker,
  OFFLINE_AFTER_FAILURES,
  REREAD_FAILED_MS,
  decide,
  freshState,
  tcpConnect,
  type ConnectOutcome,
} from './connectivity';

/**
 * The connectivity check (0.7.23): what one answer means, and the socket.
 *
 * The bug this exists for: a cluster that was off when its scheduled run came
 * round stayed "could not be reached" for the rest of the interval — thirty
 * minutes — after the node was back, until someone pressed Read now.
 */

const UP: ConnectOutcome = { ok: true };
const DOWN: ConnectOutcome = {
  ok: false,
  reason: 'no_route',
  detail: 'connect EHOSTUNREACH 192.0.2.1:8006',
};
const failed = {
  endpointHost: '192.0.2.1',
  connectionState: 'FAILED' as const,
  lastErrorCode: ERROR_CODES.clusterUnreachable,
};
const connected = { ...failed, connectionState: 'CONNECTED' as const, lastErrorCode: null };

describe('decide: a cluster coming back', () => {
  it('reads a failed cluster the first time its port answers', () => {
    const state = freshState();
    expect(decide(state, failed, DOWN, 0).kind).toBe('none');
    expect(decide(state, failed, DOWN, 2_000).kind).toBe('none');
    expect(decide(state, failed, UP, 4_000)).toEqual({ kind: 'read' });
  });

  it('reads it once, not on every answer while that run is under way', () => {
    const state = freshState();
    expect(decide(state, failed, UP, 0).kind).toBe('read');
    expect(decide(state, failed, UP, 2_000).kind).toBe('none');
    expect(decide(state, failed, UP, REREAD_FAILED_MS - 1).kind).toBe('none');
  });

  it('reads an unreachable-but-answering cluster again after a while: a hung API', () => {
    const state = freshState();
    decide(state, failed, UP, 0);
    expect(decide(state, failed, UP, REREAD_FAILED_MS).kind).toBe('read');
  });

  it('does not keep retrying a refused credential: only when the port comes back', () => {
    const auth = { ...failed, lastErrorCode: ERROR_CODES.clusterAuthFailed };
    const state = freshState();
    expect(decide(state, auth, UP, 0).kind).toBe('read');
    expect(decide(state, auth, UP, REREAD_FAILED_MS * 10).kind).toBe('none');
    for (let i = 0; i < OFFLINE_AFTER_FAILURES; i += 1) decide(state, auth, DOWN, 1);
    expect(decide(state, auth, UP, REREAD_FAILED_MS * 11).kind).toBe('read');
  });

  it('leaves connected and pending clusters alone when they answer', () => {
    expect(decide(freshState(), connected, UP, 0).kind).toBe('none');
    expect(
      decide(freshState(), { ...connected, connectionState: 'PENDING' }, UP, 0).kind,
    ).toBe('none');
  });
});

describe('decide: a cluster going away', () => {
  it('marks a connected cluster failed after two missed checks, not one', () => {
    const state = freshState();
    expect(decide(state, connected, DOWN, 0).kind).toBe('none');
    const action = decide(state, connected, DOWN, 2_000);
    expect(action.kind).toBe('mark_failed');
    // In the words a run would write, so the screen explains it the same way.
    expect(action.kind === 'mark_failed' && unreachableReasonOf(action.detail)).toBe('no_route');
  });

  it('marks it once per outage', () => {
    const state = freshState();
    decide(state, connected, DOWN, 0);
    decide(state, connected, DOWN, 2_000);
    expect(decide(state, connected, DOWN, 4_000).kind).toBe('none');
  });

  it('forgives a single missed check', () => {
    const state = freshState();
    decide(state, connected, DOWN, 0);
    decide(state, connected, UP, 2_000);
    expect(decide(state, connected, DOWN, 4_000).kind).toBe('none');
  });

  it('does not mark a pending cluster: the add form settles that', () => {
    const state = freshState();
    const pending = { ...connected, connectionState: 'PENDING' as const };
    decide(state, pending, DOWN, 0);
    expect(decide(state, pending, DOWN, 2_000).kind).toBe('none');
  });
});

describe('ConnectivityChecker: a transition is decided on the state now', () => {
  it('marks a cluster gone even when its list entry still says failed', async () => {
    // The list was read while the cluster was failed; a run has since read it
    // back to connected. The first build trusted the list, did nothing, and
    // spent the transition: the cluster stayed "connected" while gone.
    const updates: unknown[] = [];
    const reads: string[] = [];
    const row = {
      id: 'c1',
      tenantId: 't1',
      siteId: null,
      endpointHost: 'pve.example',
      endpointPort: 8006,
      connectionState: 'FAILED' as const,
      lastErrorCode: ERROR_CODES.clusterUnreachable,
    };
    const prisma = {
      cluster: {
        findMany: async () => [{ ...row }],
        findUnique: async () => ({ connectionState: 'CONNECTED', lastErrorCode: null }),
        updateMany: async (args: unknown) => {
          updates.push(args);
          return { count: 1 };
        },
      },
    };
    let answering = true;
    const checker = new ConnectivityChecker({
      prisma: prisma as never,
      read: async (_id, jobId) => void reads.push(jobId),
      log: () => undefined,
      connect: async () => (answering ? UP : DOWN),
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

    let now = 1_000_000;
    await checker.tick(now);
    await settle();
    answering = false;
    for (let i = 0; i < OFFLINE_AFTER_FAILURES; i += 1) {
      now += 2_000;
      await checker.tick(now);
      await settle();
    }
    expect(updates).toHaveLength(1);
    expect(reads.some((id) => id.includes(':silent-'))).toBe(true);
  });
});

describe('tcpConnect', () => {
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('answers when something listens', async () => {
    expect(await tcpConnect('127.0.0.1', port)).toEqual({ ok: true });
  });

  it('names a refused connection', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const free = (closed.address() as { port: number }).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const outcome = await tcpConnect('127.0.0.1', free);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe('refused');
  });

  it('gives up within its timeout', async () => {
    // TEST-NET-1 is never routed; whether that shows as a timeout or no route
    // depends on the machine, and both are a "no" within the limit.
    const started = Date.now();
    const outcome = await tcpConnect('192.0.2.1', 8006, 300);
    expect(outcome.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
