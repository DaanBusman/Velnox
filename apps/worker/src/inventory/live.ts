import type { Redis } from 'ioredis';
import { withSystemScope } from '@velnox/db';
import type { ProxmoxClient } from '@velnox/proxmox';
import { LIVE_WATCH_KEY, rootRedactor } from '@velnox/shared';
import { clientFor, type InventoryContext } from './inventory.processor';
import { persistLive } from './persist';

/** How often the watch list is read. The shortest interval a viewer can choose is 2 s. */
export const LIVE_TICK_MS = 1_000;
/** A client is reused for this long, so a ticket is not fetched every two seconds. */
const CLIENT_TTL_MS = 5 * 60_000;
/** After a failed read, a cluster waits this long before the next. */
const FAILURE_BACKOFF_MS = 30_000;

/**
 * The clusters being watched, and how often: the shortest interval any viewer
 * of each asked for. Members are `<clusterId>:<seconds>`; anything else is
 * ignored rather than trusted.
 */
export function watchedIntervals(members: string[]): Map<string, number> {
  const wanted = new Map<string, number>();
  for (const member of members) {
    const match = /^([0-9a-f-]{36}):(\d{1,3})$/i.exec(member);
    if (!match) continue;
    const seconds = Number(match[2]);
    if (seconds < 2) continue;
    const id = match[1]!.toLowerCase();
    wanted.set(id, Math.min(wanted.get(id) ?? Infinity, seconds));
  }
  return wanted;
}

/**
 * Live status for the clusters someone is looking at.
 *
 * Driven by what viewers ask for, not by a schedule: the API records each
 * watched cluster with the viewer's refresh interval and a lapse time, and this
 * reads a cluster's `/cluster/resources` — one call — as often as its most
 * eager viewer refreshes, at most one read in flight per cluster. A cluster
 * nobody is watching costs nothing. A read that fails backs off; marking the
 * cluster failed stays discovery's decision.
 */
export class LivePoller {
  private readonly last = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly clients = new Map<string, { client: ProxmoxClient; until: number }>();

  constructor(
    private readonly context: InventoryContext,
    private readonly redis: Redis,
  ) {}

  async tick(now = Date.now()): Promise<void> {
    await this.redis.zremrangebyscore(LIVE_WATCH_KEY, '-inf', now);
    const members = await this.redis.zrangebyscore(LIVE_WATCH_KEY, now, '+inf');
    const wanted = watchedIntervals(members);

    for (const [clusterId, seconds] of wanted) {
      if (this.inFlight.has(clusterId)) continue;
      if (now - (this.last.get(clusterId) ?? 0) < seconds * 1000) continue;
      this.last.set(clusterId, now);
      this.inFlight.add(clusterId);
      void this.read(clusterId).finally(() => this.inFlight.delete(clusterId));
    }

    for (const [clusterId, entry] of this.clients) {
      if (entry.until < now || !wanted.has(clusterId)) {
        entry.client.close();
        this.clients.delete(clusterId);
      }
    }
  }

  private async read(clusterId: string): Promise<void> {
    try {
      await withSystemScope('live status is read for whoever is watching', async () => {
        const client = await this.client(clusterId);
        const resources = await client.clusterResources();
        const cluster = await this.context.prisma.cluster.findUnique({
          where: { id: clusterId },
          select: { id: true, tenantId: true },
        });
        if (!cluster) return;
        await persistLive(this.context.prisma, cluster, resources, new Date());
      });
    } catch (error) {
      this.clients.get(clusterId)?.client.close();
      this.clients.delete(clusterId);
      this.last.set(clusterId, Date.now() + FAILURE_BACKOFF_MS);
      this.context.log({ clusterId, err: rootRedactor.value(error) }, 'Reading live status failed');
    }
  }

  private async client(clusterId: string): Promise<ProxmoxClient> {
    const cached = this.clients.get(clusterId);
    if (cached && cached.until > Date.now()) return cached.client;
    const { client } = await clientFor(this.context, clusterId);
    this.clients.set(clusterId, { client, until: Date.now() + CLIENT_TTL_MS });
    return client;
  }

  close(): void {
    for (const entry of this.clients.values()) entry.client.close();
    this.clients.clear();
  }
}
