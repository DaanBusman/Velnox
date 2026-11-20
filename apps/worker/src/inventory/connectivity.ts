import { connect } from 'node:net';
import { withSystemScope, type VelnoxPrismaClient } from '@velnox/db';
import {
  ERROR_CODES,
  rootRedactor,
  unreachableReasonFrom,
  unreachableToken,
  type UnreachableReason,
} from '@velnox/shared';

/**
 * Is each cluster's API port answering — asked every two seconds (0.7.23).
 *
 * Before this, the only thing that noticed a cluster coming back was the next
 * scheduled discovery run, and that only moves on success: a cluster that was
 * off when its run came round stayed "could not be reached" for the rest of the
 * interval — thirty minutes by default — while the node itself had long been
 * up and answering. Read now fixed it at once, which is how it was found.
 *
 * So every cluster's endpoint gets a TCP connect every two seconds, and the
 * answer is used for two transitions only:
 *
 * - **Back.** A cluster marked failed whose port answers again is read at once,
 *   as if someone had pressed Read now. The run decides the state, with the
 *   credential and the pinned certificate, exactly as before: a port that
 *   accepts a connection proves nothing about who is listening.
 * - **Gone.** A cluster marked connected whose port has stopped answering twice
 *   in a row is marked failed straight away, with the reason the socket gave —
 *   no route, refused, no connection in time — in the words a run would use.
 *   The inventory stays as it was; only the state and the error change, the
 *   same as a failed run. And a run is asked for at once, whose longer
 *   patience has the last word on why: the check's own timeout is short, and a
 *   short timeout can end before the operating system has said "no route".
 *
 * A plain TCP connect and nothing more: no TLS, no request, no credential. It
 * leaves no line in `pveproxy`'s access log, costs the node a SYN and a FIN,
 * and every two seconds that is still nothing — a TLS handshake and a request
 * would be a log line every two seconds per Velnox on every cluster.
 *
 * Kept in this process: the state below is "what did the last few checks say",
 * which a restart may forget. A restarted worker treats every failed cluster
 * whose port answers as just come back, and reads it once.
 */

export const CONNECTIVITY_INTERVAL_MS = 2_000;
/** How often `tick` runs: finer than the interval, so a check is never more than this late. */
export const CONNECTIVITY_TICK_MS = 500;
/**
 * Shorter than a run's 20 s: this asks whether anything answers, not waits for
 * a busy API. Longer than the three seconds Linux takes to give up on ARP for
 * an address on its own network that has gone: at three, the timeout and
 * "no route" raced, and a switched-off node was reported as "no connection in
 * time" — the wrong place to look.
 */
export const CONNECTIVITY_TIMEOUT_MS = 5_000;
/** Checks in a row that must fail before a connected cluster is marked failed. */
export const OFFLINE_AFTER_FAILURES = 2;
/**
 * A cluster its last run could not reach, whose port answers anyway — an API
 * that accepts connections and then hangs — is read again this often, not
 * every two seconds. One that failed for any other reason — a refused
 * credential, a certificate that is not the pinned one — is read again only
 * when its port comes back: retrying a refused password every two minutes is
 * how an account gets locked.
 */
export const REREAD_FAILED_MS = 2 * 60_000;
/** The list of clusters is read again this often: new and removed clusters are picked up within it. */
const LIST_TTL_MS = 10_000;

export type ConnectOutcome =
  | { ok: true }
  | { ok: false; reason: UnreachableReason; detail: string };

/** Open a TCP connection and close it again. Never throws. */
export function tcpConnect(host: string, port: number, timeoutMs = CONNECTIVITY_TIMEOUT_MS) {
  return new Promise<ConnectOutcome>((resolve) => {
    let settled = false;
    const socket = connect({ host, port });
    const finish = (outcome: ConnectOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          reason: 'connect_timeout',
          detail: `no connection to ${host}:${port} within ${timeoutMs / 1000} s`,
        }),
      timeoutMs,
    );
    socket.once('connect', () => {
      socket.end();
      finish({ ok: true });
    });
    socket.once('error', (error) =>
      finish({ ok: false, reason: unreachableReasonFrom(error), detail: error.message }),
    );
  });
}

export interface CheckedCluster {
  id: string;
  tenantId: string;
  siteId: string | null;
  endpointHost: string;
  endpointPort: number;
  connectionState: 'PENDING' | 'CONNECTED' | 'FAILED';
  lastErrorCode: string | null;
}

/** What the last checks of one cluster said. */
export interface CheckState {
  /** Failed checks in a row. */
  failures: number;
  /** The last verdict: answering, not answering, or not known yet. */
  up: boolean | null;
  /** When this process last asked for a run of it. */
  readAt: number | null;
}

export type CheckAction =
  | { kind: 'none' }
  | { kind: 'read' }
  | { kind: 'mark_failed'; detail: string };

export const freshState = (): CheckState => ({ failures: 0, up: null, readAt: null });

/**
 * What one check's answer means for one cluster, as a pure function. Updates
 * `state` in place.
 */
export function decide(
  state: CheckState,
  cluster: Pick<CheckedCluster, 'endpointHost' | 'connectionState' | 'lastErrorCode'>,
  outcome: ConnectOutcome,
  now: number,
): CheckAction {
  if (outcome.ok) {
    const wasDown = state.up !== true;
    state.failures = 0;
    state.up = true;
    // Pending is the add-a-cluster form's to settle, and connected needs nothing.
    if (cluster.connectionState !== 'FAILED') return { kind: 'none' };
    const again =
      cluster.lastErrorCode === ERROR_CODES.clusterUnreachable &&
      (state.readAt === null || now - state.readAt >= REREAD_FAILED_MS);
    if (wasDown || again) {
      state.readAt = now;
      return { kind: 'read' };
    }
    return { kind: 'none' };
  }

  state.failures += 1;
  if (state.failures < OFFLINE_AFTER_FAILURES) return { kind: 'none' };
  const wasUp = state.up !== false;
  state.up = false;
  if (cluster.connectionState !== 'CONNECTED' || !wasUp) return { kind: 'none' };
  // The same words a run would write, so the screen explains it the same way.
  return {
    kind: 'mark_failed',
    detail: `Could not reach ${cluster.endpointHost} ${unreachableToken(outcome.reason)}: ${outcome.detail}`,
  };
}

export interface ConnectivityDeps {
  prisma: VelnoxPrismaClient;
  /** Queue a discovery run. The job id is the caller's to make unique. */
  read: (clusterId: string, jobId: string) => Promise<void>;
  changed?: (cluster: { id: string; tenantId: string; siteId: string | null }) => Promise<void>;
  log: (fields: Record<string, unknown>, message: string) => void;
  connect?: typeof tcpConnect;
}

/** Drives the checks. `tick` runs twice a second; each cluster is checked every two. */
export class ConnectivityChecker {
  private clusters: CheckedCluster[] = [];
  private listedAt = 0;
  private readonly states = new Map<string, CheckState>();
  private readonly startedAt = new Map<string, number>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: ConnectivityDeps) {}

  async tick(now = Date.now()): Promise<void> {
    if (now - this.listedAt >= LIST_TTL_MS) {
      // Awaited inside the scope, not returned from it: a Prisma query runs when
      // it is awaited, and returned unawaited it ran outside the scope and was
      // refused — every tick, silently, in the first build of this.
      this.clusters = await withSystemScope('connectivity checks belong to no request', async () =>
        await this.deps.prisma.cluster.findMany({
          // Without a credential there is nothing a run could do with the answer.
          where: { credentialId: { not: null } },
          select: {
            id: true,
            tenantId: true,
            siteId: true,
            endpointHost: true,
            endpointPort: true,
            connectionState: true,
            lastErrorCode: true,
          },
        }),
      );
      this.listedAt = now;
      const ids = new Set(this.clusters.map((cluster) => cluster.id));
      for (const id of this.states.keys()) {
        if (!ids.has(id)) {
          this.states.delete(id);
          this.startedAt.delete(id);
        }
      }
    }

    for (const cluster of this.clusters) {
      if (this.inFlight.has(cluster.id)) continue;
      if (now - (this.startedAt.get(cluster.id) ?? 0) < CONNECTIVITY_INTERVAL_MS) continue;
      this.startedAt.set(cluster.id, now);
      this.inFlight.add(cluster.id);
      void this.check(cluster).finally(() => this.inFlight.delete(cluster.id));
    }
  }

  private async check(cluster: CheckedCluster): Promise<void> {
    try {
      const outcome = await (this.deps.connect ?? tcpConnect)(
        cluster.endpointHost,
        cluster.endpointPort,
      );
      const state = this.states.get(cluster.id) ?? freshState();
      this.states.set(cluster.id, state);
      const now = Date.now();
      const action = decide(state, cluster, outcome, now);

      if (action.kind === 'read') {
        await this.deps.read(cluster.id, `discover:${cluster.id}:answering-${now}`);
        this.deps.log({ clusterId: cluster.id }, 'Cluster answers again; reading it');
      } else if (action.kind === 'mark_failed') {
        const marked = await withSystemScope('connectivity checks belong to no request', async () =>
          await this.deps.prisma.cluster.updateMany({
            // Only if a run has not decided otherwise in the meantime.
            where: { id: cluster.id, connectionState: 'CONNECTED' },
            data: {
              connectionState: 'FAILED',
              lastErrorCode: ERROR_CODES.clusterUnreachable,
              lastErrorDetail: rootRedactor.text(action.detail).slice(0, 1000),
            },
          }),
        );
        if (marked.count > 0) {
          // Seen at once, not at the next list read.
          cluster.connectionState = 'FAILED';
          cluster.lastErrorCode = ERROR_CODES.clusterUnreachable;
          await this.deps.changed?.(cluster);
          this.deps.log({ clusterId: cluster.id, detail: action.detail }, 'Cluster stopped answering');
          // The run's twenty seconds and its retries name the reason exactly,
          // and write it over the check's.
          await this.deps.read(cluster.id, `discover:${cluster.id}:silent-${now}`);
        }
      }
    } catch (error) {
      this.deps.log({ clusterId: cluster.id, err: rootRedactor.value(error) }, 'Connectivity check failed');
    }
  }
}
