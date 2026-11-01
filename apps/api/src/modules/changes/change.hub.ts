import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { redisConnection, type ApiConfig } from '@velnox/config';
import { withSystemScope } from '@velnox/db';
import { CHANGE_CHANNEL, CHANGE_TOPICS, type ChangeMessage } from '@velnox/shared';
import { API_CONFIG } from '../../config/config.module';
import { PrismaService } from '../infrastructure/prisma.service';

type Listener = (change: ChangeMessage) => void;

/** Jobs whose tenant is remembered, so a busy job is looked up once, not per event. */
const JOB_TENANTS_KEPT = 2_000;

/**
 * Fans "something changed" out from Redis to the screens listening for it.
 *
 * Two sources, one subscriber connection per API process, opened on first use
 * (as JobStreamHub does, for the same reasons):
 *
 * - **Inventory**, which the worker publishes on CHANGE_CHANNEL with the
 *   cluster's tenant and site.
 * - **Jobs**, from the per-job event channels every job already publishes on.
 *   Those carry no tenant, and a screen may only hear of a job in a tenant it
 *   can read jobs in, so the hub looks the tenant up — once per job, kept.
 *
 * What reaches a listener is the scope of the change, for the stream to filter
 * on. It never leaves the API as is.
 */
@Injectable()
export class ChangeHub implements OnModuleDestroy {
  private subscriber: Redis | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly jobTenants = new Map<string, string>();

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly prisma: PrismaService,
  ) {}

  /** Start receiving changes. Returns the function that stops it. */
  listen(listener: Listener): () => void {
    this.ensureSubscribed();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: ChangeMessage): void {
    for (const listener of this.listeners) listener(change);
  }

  private ensureSubscribed(): void {
    if (this.subscriber) return;

    const subscriber = new Redis({
      ...redisConnection(this.config),
      // Reconnect indefinitely: giving up would leave every open screen on its
      // fallback interval for as long as the API runs.
      maxRetriesPerRequest: null,
      retryStrategy: (times) => Math.min(times * 200, 5_000),
    });
    subscriber.on('error', () => undefined);

    subscriber.on('message', (channel, raw) => {
      if (channel !== CHANGE_CHANNEL || this.listeners.size === 0) return;
      const change = parseChange(raw);
      if (change) this.emit(change);
    });

    subscriber.on('pmessage', (_pattern, channel, _raw) => {
      if (this.listeners.size === 0) return;
      const jobId = /^velnox:job:([0-9a-f-]{36}):events$/i.exec(channel)?.[1];
      if (!jobId) return;
      void this.tenantOfJob(jobId).then((tenantId) => {
        if (tenantId) this.emit({ topic: 'jobs', tenantId, siteId: null, clusterId: null });
      });
    });

    void subscriber.subscribe(CHANGE_CHANNEL);
    void subscriber.psubscribe('velnox:job:*:events');
    this.subscriber = subscriber;
  }

  private async tenantOfJob(jobId: string): Promise<string | null> {
    const known = this.jobTenants.get(jobId);
    if (known) return known;

    const job = await withSystemScope('a job event names its job, not its tenant', () =>
      this.prisma.client.job.findUnique({ where: { id: jobId }, select: { tenantId: true } }),
    ).catch(() => null);
    if (!job) return null;

    if (this.jobTenants.size >= JOB_TENANTS_KEPT) {
      // Maps keep insertion order: the first key is the longest remembered.
      const oldest = this.jobTenants.keys().next().value;
      if (oldest !== undefined) this.jobTenants.delete(oldest);
    }
    this.jobTenants.set(jobId, job.tenantId);
    return job.tenantId;
  }

  onModuleDestroy(): void {
    this.subscriber?.disconnect();
    this.listeners.clear();
  }
}

const UUID = /^[0-9a-f-]{36}$/i;

/** A change message as published, or null for anything that is not one. */
export function parseChange(raw: string): ChangeMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const optionalId = (x: unknown) => x === null || (typeof x === 'string' && UUID.test(x));
  if (
    !(CHANGE_TOPICS as readonly unknown[]).includes(v.topic) ||
    typeof v.tenantId !== 'string' ||
    !UUID.test(v.tenantId) ||
    !optionalId(v.siteId) ||
    !optionalId(v.clusterId)
  ) {
    return null;
  }
  return {
    topic: v.topic as ChangeMessage['topic'],
    tenantId: v.tenantId,
    siteId: (v.siteId as string | null) ?? null,
    clusterId: (v.clusterId as string | null) ?? null,
  };
}
