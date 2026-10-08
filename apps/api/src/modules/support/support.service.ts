import { Injectable } from '@nestjs/common';
import type { Prisma } from '@velnox/db';
import { ERROR_CODES, VelnoxError } from '@velnox/shared';
import { PrismaService } from '../infrastructure/prisma.service';

/** The longest Proxmox tasks are kept, the owner's limit. */
export const SUPPORT_RETENTION_MAX_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;
const BATCH = 500;

export interface SupportExportQuery {
  /** The tenants to export; null exports every tenant (MSP staff only). */
  tenantIds: string[] | null;
  from: Date;
  to: Date;
}

/**
 * Support logs: what Velnox did for a tenant, and what happened on its nodes.
 *
 * One file, JSON Lines, one record per line with a `kind`: each job with its
 * steps and output right after it, then discovery runs, then the Proxmox tasks
 * of the tenant's nodes — `origin` says whether Velnox started a task or
 * someone outside Velnox did. Job output and discovery problems were redacted
 * when they were written; nothing here decrypts anything.
 */
@Injectable()
export class SupportService {
  constructor(private readonly prisma: PrismaService) {}

  async retentionDays(): Promise<number> {
    const settings = await this.prisma.client.systemSettings.findUnique({
      where: { id: 1 },
      select: { supportLogRetentionDays: true },
    });
    return settings?.supportLogRetentionDays ?? SUPPORT_RETENTION_MAX_DAYS;
  }

  async setRetentionDays(days: number): Promise<number> {
    if (!Number.isInteger(days) || days < 1 || days > SUPPORT_RETENTION_MAX_DAYS) {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 400,
        message: `Between 1 and ${SUPPORT_RETENTION_MAX_DAYS} days`,
        params: { field: 'retentionDays' },
      });
    }
    await this.prisma.client.systemSettings.update({
      where: { id: 1 },
      data: { supportLogRetentionDays: days },
    });
    return days;
  }

  /** The default period: as far back as Proxmox tasks are kept. */
  async defaultFrom(now = new Date()): Promise<Date> {
    return new Date(now.getTime() - (await this.retentionDays()) * DAY_MS);
  }

  async export(
    query: SupportExportQuery,
    write: (chunk: string) => Promise<void>,
  ): Promise<number> {
    const tenant = query.tenantIds ? { tenantId: { in: query.tenantIds } } : {};
    let count = 0;
    const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;

    // Jobs, each followed by its steps and its output.
    let cursor: string | undefined;
    for (;;) {
      const jobs = await this.prisma.client.job.findMany({
        where: { ...tenant, queuedAt: { gte: query.from, lt: query.to } },
        include: {
          tenant: { select: { name: true } },
          createdBy: { select: { email: true } },
          steps: { orderBy: { sequence: 'asc' } },
        },
        orderBy: { id: 'asc' },
        take: 100,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (jobs.length === 0) break;
      for (const job of jobs) {
        let chunk = line({
          kind: 'job',
          at: job.queuedAt.toISOString(),
          tenant: job.tenant.name,
          id: job.id,
          type: job.type,
          status: job.status,
          by: job.createdBy?.email ?? null,
          startedAt: job.startedAt?.toISOString() ?? null,
          finishedAt: job.finishedAt?.toISOString() ?? null,
          errorCode: job.errorCode,
          errorDetail: job.errorMessage,
          targetKind: job.targetKind,
          targetIds: job.targetIds,
        });
        for (const step of job.steps) {
          chunk += line({
            kind: 'job_step',
            at: (step.startedAt ?? job.queuedAt).toISOString(),
            jobId: job.id,
            step: step.stepKey,
            status: step.status,
            attempt: step.attempt,
            finishedAt: step.finishedAt?.toISOString() ?? null,
            error: step.error,
          });
        }
        await write(chunk);
        count += 1 + job.steps.length;
        count += await this.writeJobLogs(job.id, write);
      }
      cursor = jobs[jobs.length - 1]!.id;
    }

    // Discovery runs.
    count += await this.page(
      (after) =>
        this.prisma.client.discoveryRun.findMany({
          where: { ...tenant, startedAt: { gte: query.from, lt: query.to } },
          include: { cluster: { select: { name: true, tenant: { select: { name: true } } } } },
          orderBy: { id: 'asc' },
          take: BATCH,
          ...(after ? { cursor: { id: after }, skip: 1 } : {}),
        }),
      (run) => ({
        kind: 'discovery_run',
        at: run.startedAt.toISOString(),
        tenant: run.cluster.tenant.name,
        cluster: run.cluster.name,
        state: run.state,
        durationMs: run.durationMs,
        nodes: run.nodesSeen,
        guests: run.workloadsSeen,
        problems: run.problems,
        errorCode: run.errorCode,
        errorDetail: run.errorDetail,
      }),
      write,
    );

    // The Proxmox task history.
    count += await this.page(
      (after) =>
        this.prisma.client.proxmoxTask.findMany({
          where: { ...tenant, startedAt: { gte: query.from, lt: query.to } },
          include: { cluster: { select: { name: true, tenant: { select: { name: true } } } } },
          orderBy: { id: 'asc' },
          take: BATCH,
          ...(after ? { cursor: { id: after }, skip: 1 } : {}),
        }),
      (task) => ({
        kind: 'proxmox_task',
        at: task.startedAt.toISOString(),
        tenant: task.cluster.tenant.name,
        cluster: task.cluster.name,
        node: task.node,
        type: task.type,
        object: task.objectId,
        user: task.user,
        origin: task.origin,
        startedOutsideVelnox: task.origin === 'OUTSIDE_VELNOX',
        status: task.status,
        endedAt: task.endedAt?.toISOString() ?? null,
        upid: task.upid,
      }),
      write,
    );

    return count;
  }

  private async writeJobLogs(jobId: string, write: (chunk: string) => Promise<void>) {
    let count = 0;
    let after: bigint | undefined;
    for (;;) {
      const lines = await this.prisma.client.jobLog.findMany({
        where: { jobId, ...(after !== undefined ? { id: { gt: after } } : {}) },
        orderBy: { id: 'asc' },
        take: BATCH,
      });
      if (lines.length === 0) return count;
      await write(
        lines
          .map(
            (log) =>
              `${JSON.stringify({
                kind: 'job_log',
                at: log.at.toISOString(),
                jobId,
                step: log.stepKey,
                stream: log.stream,
                text: log.content,
                truncated: log.truncated,
              })}\n`,
          )
          .join(''),
      );
      count += lines.length;
      after = lines[lines.length - 1]!.id;
    }
  }

  private async page<T extends { id: string }>(
    read: (after: string | undefined) => Prisma.PrismaPromise<T[]>,
    shape: (row: T) => Record<string, unknown>,
    write: (chunk: string) => Promise<void>,
  ): Promise<number> {
    let count = 0;
    let after: string | undefined;
    for (;;) {
      const rows = await read(after);
      if (rows.length === 0) return count;
      await write(rows.map((row) => `${JSON.stringify(shape(row))}\n`).join(''));
      count += rows.length;
      after = rows[rows.length - 1]!.id;
    }
  }
}
