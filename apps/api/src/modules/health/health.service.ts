import { Injectable } from '@nestjs/common';
import {
  migrationStatus,
  pingDatabase,
  readMigrationState,
  type MigrationState,
} from '@velnox/db';
import {
  REDIS_KEYS,
  WORKER_HEARTBEAT_MAX_AGE_MS,
  type CheckDetail,
  type CheckStatus,
  type DependencyCheck,
  type ReadinessResponse,
} from '@velnox/shared';
import { PrismaService } from '../infrastructure/prisma.service';
import { RedisService } from '../infrastructure/redis.service';

/**
 * Liveness and readiness.
 *
 * `/healthz` answers "is this process alive" and must not touch a dependency —
 * an orchestrator restarting the API because Redis is briefly unavailable turns
 * a small problem into a large one.
 *
 * `/readyz` answers "should this process receive traffic" and does check
 * dependencies, including whether the database schema matches what this build
 * expects.
 */
@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  uptimeSeconds(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  async readiness(): Promise<ReadinessResponse> {
    const [database, redis, worker, migrations] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkWorker(),
      this.checkMigrations(),
    ]);

    const checks = [database, redis, worker];
    const statuses = [...checks.map((c) => c.status), migrations.status];

    const overall: CheckStatus = statuses.includes('down')
      ? 'down'
      : statuses.includes('degraded')
        ? 'degraded'
        : 'ok';

    return { status: overall, checks, migrations: migrations.detail };
  }

  private async checkDatabase(): Promise<DependencyCheck> {
    try {
      const latencyMs = await pingDatabase(this.prisma.client);
      return { name: 'database', status: 'ok', latencyMs };
    } catch (error) {
      return { name: 'database', status: 'down', detail: describe(error) };
    }
  }

  private async checkRedis(): Promise<DependencyCheck> {
    try {
      const latencyMs = await this.redis.ping();
      return { name: 'redis', status: 'ok', latencyMs };
    } catch (error) {
      return { name: 'redis', status: 'down', detail: describe(error) };
    }
  }

  /**
   * The worker has no listening port, so its liveness is reported through a
   * heartbeat key it refreshes in Redis. A missing or stale heartbeat is
   * `degraded`, not `down`: the API can still serve reads and accept work, and
   * failing readiness here would take the whole UI offline over a background
   * worker restart.
   */
  private async checkWorker(): Promise<DependencyCheck> {
    try {
      const raw = await this.redis.client.get(REDIS_KEYS.workerHeartbeat);
      if (!raw) {
        return { name: 'worker', status: 'degraded', detail: { code: 'noHeartbeat' } };
      }
      const age = Date.now() - Number(raw);
      if (!Number.isFinite(age)) {
        return { name: 'worker', status: 'degraded', detail: { code: 'heartbeatInvalid' } };
      }
      const seconds = Math.max(0, Math.round(age / 1000));
      if (age > WORKER_HEARTBEAT_MAX_AGE_MS) {
        return {
          name: 'worker',
          status: 'degraded',
          detail: { code: 'heartbeatStale', params: { seconds } },
        };
      }
      // Deliberately not reported as latencyMs: that field means round-trip time,
      // and heartbeat age is a different measurement. Reporting one as the other
      // would read as "the worker took 2.5 seconds to answer".
      return { name: 'worker', status: 'ok', detail: { code: 'heartbeatAge', params: { seconds } } };
    } catch (error) {
      return { name: 'worker', status: 'degraded', detail: describe(error) };
    }
  }

  private async checkMigrations(): Promise<{
    status: CheckStatus;
    detail: ReadinessResponse['migrations'];
  }> {
    try {
      const state: MigrationState = await readMigrationState(this.prisma.client);
      const status = migrationStatus(state);
      return {
        status,
        detail: {
          status,
          applied: state.applied.length,
          expected: state.expected.length,
          pending: state.pending,
          unknown: state.unknown,
        },
      };
    } catch {
      // The table does not exist yet, or the database is unreachable. Either way
      // this build must not serve traffic against it.
      return {
        status: 'down',
        detail: { status: 'down', applied: 0, expected: 0, pending: [], unknown: [] },
      };
    }
  }
}

/**
 * Short, safe description of a failure. Full detail goes to the log, redacted.
 *
 * The wrapper is translated; the message itself is not, because it is verbatim
 * output from a driver or the operating system — translating it would make it
 * wrong, and a support engineer needs to be able to search for it as written.
 */
function describe(error: unknown): CheckDetail {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
  return { code: 'connectionFailed', params: { message } };
}
