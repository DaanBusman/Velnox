import { Injectable, type MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  CHANGE_STREAM_MAX_SECONDS,
  LIVE_WATCH_KEY,
  LIVE_WATCH_MIN_TTL_SECONDS,
  PERMISSIONS,
  isAllowed,
  type ChangeEvent,
  type ChangeMessage,
  type ChangeTopic,
  type Grant,
} from '@velnox/shared';
import type { Actor } from '../../common/actor';
import { PrismaService } from '../infrastructure/prisma.service';
import { RedisService } from '../infrastructure/redis.service';
import { ChangeHub } from './change.hub';

/** Changes are gathered for this long and sent once: a busy job is one signal a second. */
const COALESCE_MS = 1_000;
/** A comment, so proxies see traffic on a quiet stream. */
const HEARTBEAT_MS = 15_000;
/** How often an open stream renews its watch on the clusters on screen. */
const WATCH_RENEW_MS = 5_000;
/** What the browser waits before reconnecting a stream the API ended. */
const RECONNECT_MS = 3_000;

/** Reading any of these on a cluster is seeing its inventory change. */
const INVENTORY_READS = [
  PERMISSIONS.clustersRead,
  PERMISSIONS.nodesRead,
  PERMISSIONS.workloadsRead,
] as const;

/**
 * Whether these grants may hear of this change: the same permission, at the
 * same scope, that reading what changed would need. A job is checked at its
 * tenant, as the job list checks it.
 */
export function mayHear(grants: readonly Grant[], change: ChangeMessage): boolean {
  if (change.topic === 'jobs') {
    return isAllowed(grants, PERMISSIONS.jobsRead, { tenantId: change.tenantId });
  }
  const scope = { tenantId: change.tenantId, siteId: change.siteId, clusterId: change.clusterId };
  return INVENTORY_READS.some((permission) => isAllowed(grants, permission, scope));
}

export interface ChangeStreamQuery {
  topics: ChangeTopic[];
  clusters: string[];
  refresh?: number | undefined;
}

@Injectable()
export class ChangesService {
  constructor(
    private readonly hub: ChangeHub,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * One screen's stream of "something changed".
   *
   * While it is open it also keeps the worker reading live status for the
   * clusters on that screen, which until now only the screen's own refreshes
   * did: a screen that refreshes only when something changes would otherwise
   * stop the very reads that tell it so. Only clusters this actor may read are
   * watched; the rest of the list is ignored, not refused, as the interceptor
   * that records watches from responses does.
   */
  async stream(
    actor: Actor,
    query: ChangeStreamQuery,
    signal?: AbortSignal,
  ): Promise<Observable<MessageEvent>> {
    const watched = await this.readableClusters(actor, query.clusters);
    const topics = new Set(query.topics);

    return new Observable<MessageEvent>((subscriber) => {
      const pending = new Map<string, ChangeEvent>();

      const stopListening = this.hub.listen((change) => {
        if (!topics.has(change.topic) || !mayHear(actor.grants, change)) return;
        const event: ChangeEvent = { topic: change.topic, clusterId: change.clusterId };
        pending.set(`${event.topic}:${event.clusterId ?? ''}`, event);
      });

      const flush = setInterval(() => {
        for (const event of pending.values()) subscriber.next({ type: 'change', data: event });
        pending.clear();
      }, COALESCE_MS);

      const heartbeat = setInterval(() => subscriber.next({ comment: 'keepalive' }), HEARTBEAT_MS);

      const watch = () => {
        if (!query.refresh || watched.length === 0) return;
        const lapse =
          Date.now() + Math.max(query.refresh * 3, LIVE_WATCH_MIN_TTL_SECONDS) * 1000;
        const args = watched.flatMap((id) => [lapse, `${id}:${query.refresh}`]);
        void this.redis.client.zadd(LIVE_WATCH_KEY, ...args).catch(() => undefined);
      };
      watch();
      const renew = setInterval(watch, WATCH_RENEW_MS);

      // Ended on a schedule so the browser reconnects, and is authenticated
      // and its permissions read again (CHANGE_STREAM_MAX_SECONDS).
      const lifetime = setTimeout(() => subscriber.complete(), CHANGE_STREAM_MAX_SECONDS * 1000);

      subscriber.next({
        type: 'ready',
        data: { topics: [...topics], watching: watched.length },
        retry: RECONNECT_MS,
      });

      const stop = () => {
        clearInterval(flush);
        clearInterval(heartbeat);
        clearInterval(renew);
        clearTimeout(lifetime);
        stopListening();
      };
      signal?.addEventListener('abort', stop, { once: true });
      return stop;
    });
  }

  private async readableClusters(actor: Actor, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.client.cluster.findMany({
      where: { id: { in: ids } },
      select: { id: true, tenantId: true, siteId: true },
    });
    return rows
      .filter((row) =>
        INVENTORY_READS.some((permission) =>
          isAllowed(actor.grants, permission, {
            tenantId: row.tenantId,
            siteId: row.siteId,
            clusterId: row.id,
          }),
        ),
      )
      .map((row) => row.id);
  }
}
