import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { tap, type Observable } from 'rxjs';
import {
  LIVE_REFRESH_CHOICES,
  LIVE_REFRESH_HEADER,
  LIVE_WATCH_KEY,
  LIVE_WATCH_MIN_TTL_SECONDS,
} from '@velnox/shared';
import { RedisService } from '../infrastructure/redis.service';

/** Most clusters one read records; a list longer than this is not "watching". */
const MAX_CLUSTERS = 200;

/**
 * The clusters a response is about: a cluster list's ids, and the cluster of
 * every node, guest or storage in it — or of the single node or cluster read.
 */
export function clustersIn(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const ids = new Set<string>();
  const record = body as Record<string, unknown>;
  const add = (value: unknown) => {
    if (typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)) ids.add(value.toLowerCase());
  };
  if (Array.isArray(record.clusters)) {
    for (const cluster of record.clusters) add((cluster as { id?: unknown })?.id);
  }
  for (const key of ['nodes', 'workloads', 'storages']) {
    const list = record[key];
    if (Array.isArray(list))
      for (const row of list) add((row as { clusterId?: unknown })?.clusterId);
  }
  add(record.clusterId);
  if ('connectionState' in record) add(record.id);
  return [...ids].slice(0, MAX_CLUSTERS);
}

/**
 * Records that someone is looking at these clusters, and how often their screen
 * refreshes, so the worker keeps their light status current (LivePoller).
 *
 * The interval comes from the web server, which reads the viewer's own refresh
 * preference; anything but an offered value — including "off" — records
 * nothing. Only clusters in the response are recorded, so nobody can make
 * Velnox watch a cluster they cannot read. Never in the way of the response:
 * a failure to record is dropped.
 */
@Injectable()
export class LiveWatchInterceptor implements NestInterceptor {
  constructor(private readonly redis: RedisService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const seconds = Number(request.header(LIVE_REFRESH_HEADER));
    if (!(LIVE_REFRESH_CHOICES as readonly number[]).includes(seconds)) return next.handle();

    return next.handle().pipe(
      tap((body) => {
        const clusters = clustersIn(body);
        if (clusters.length === 0) return;
        const lapse = Date.now() + Math.max(seconds * 3, LIVE_WATCH_MIN_TTL_SECONDS) * 1000;
        const args = clusters.flatMap((id) => [lapse, `${id}:${seconds}`]);
        void this.redis.client.zadd(LIVE_WATCH_KEY, ...args).catch(() => undefined);
      }),
    );
  }
}
