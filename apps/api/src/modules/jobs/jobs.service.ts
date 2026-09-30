import { Injectable, type MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import { appendJobEvent, type JobChange, type JobEventWrite, type Prisma } from '@velnox/db';
import {
  ACTIVE_JOB_STATUSES,
  ERROR_CODES,
  JOB_EVENT_KEYS,
  JOB_TYPES,
  PERMISSIONS,
  VelnoxError,
  assertTransition,
  isAllowed,
  isTerminal,
  jobCancelKey,
  jobEventChannel,
  parseSelftestParams,
  rootRedactor,
  type ApprovalSummary,
  type JobDetail,
  type JobEventMessage,
  type JobLogLine,
  type JobStatus,
  type JobSummary,
  type Permission,
} from '@velnox/shared';
import { assertAllowedAt, type Actor } from '../../common/actor';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { PrismaService } from '../infrastructure/prisma.service';
import { QueueService } from '../infrastructure/queue.service';
import { RedisService } from '../infrastructure/redis.service';
import { JobStreamHub } from './job-stream.hub';

/**
 * Jobs, from the API's side.
 *
 * The API creates jobs, reads them, and makes the decisions a person makes:
 * cancel, retry, approve, reject. It never runs one (ADR-009). The split of who
 * may move a job where is strict, and it is what makes the conditional writes
 * below sufficient:
 *
 * - QUEUED and WAITING_APPROVAL belong to nobody, and the API may move them —
 *   cancelled before starting, approved back onto the queue, rejected.
 * - PREFLIGHT, RUNNING and VALIDATING belong to one worker. The API does not
 *   touch their status. Cancelling one sets a flag, and the worker honours it at
 *   the next step boundary.
 *
 * Every status change is conditional on the status the API read. If a worker
 * claimed the job in between, the write misses and the API takes the path for a
 * running job instead.
 */

/** What may create a job of each type. */
/**
 * The permission each job type needs, checked at the job's tenant.
 *
 * For the library jobs this is the half that touches a tenant. Fetching,
 * verifying and copying into the library also need `library.manage`, which
 * LibraryService checks before it asks for the job — the library is not any
 * tenant's, so there is no tenant to check it at here.
 */
const CREATE_PERMISSION: Record<string, Permission> = {
  [JOB_TYPES.selftest]: PERMISSIONS.systemManage,
  [JOB_TYPES.libraryFetch]: PERMISSIONS.libraryManage,
  [JOB_TYPES.libraryVerify]: PERMISSIONS.libraryManage,
  [JOB_TYPES.libraryPush]: PERMISSIONS.clustersManage,
  [JOB_TYPES.libraryPull]: PERMISSIONS.clustersManage,
  [JOB_TYPES.libraryClusterDelete]: PERMISSIONS.clustersManage,
  [JOB_TYPES.vmProvision]: PERMISSIONS.workloadsProvision,
};

/**
 * Types whose failure leaves a failed library item behind. A retry would be a
 * new job pointed at an item that is no longer waiting for it; the way back is
 * adding the file again, which the library screen offers.
 */
const NOT_RETRYABLE_TYPES = new Set<string>([
  JOB_TYPES.libraryFetch,
  JOB_TYPES.libraryVerify,
  JOB_TYPES.libraryPull,
]);

/** How long a cancellation flag outlives the request, in seconds. */
const CANCEL_FLAG_TTL = 24 * 60 * 60;

/** Sent on an open stream this often, so proxies and browsers keep it open. */
const STREAM_HEARTBEAT_MS = 15_000;

/** Largest replay on connect. A job with more events than this is streamed from its tail. */
const REPLAY_LIMIT = 5_000;

const RETRYABLE: JobStatus[] = ['FAILED', 'CANCELLED', 'ROLLED_BACK'];

const jobInclude = {
  tenant: { select: { name: true } },
  createdBy: { select: { id: true, email: true } },
} satisfies Prisma.JobInclude;

type JobRow = Prisma.JobGetPayload<{ include: typeof jobInclude }>;

@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly hub: JobStreamHub,
  ) {}

  // -------------------------------------------------------------------------
  // Creating
  // -------------------------------------------------------------------------

  /**
   * Start a self-test job.
   *
   * It holds a concurrency key like any mutating job would: `cluster:<id>` when
   * pointed at a cluster, which proves the guarantee a real change relies on
   * without touching the cluster, or `selftest:<lane>` for a key of its own.
   */
  async createSelftest(
    input: { clusterId?: string | null; lane?: string | null; params?: unknown },
    actor: Actor,
  ): Promise<JobDetail> {
    const params = parseSelftestParams(input.params ?? {});

    let tenantId = actor.tenantId;
    let concurrencyKey: string | null = null;
    let target = '';
    let targetKind: string | null = null;
    let targetIds: string[] = [];

    if (input.clusterId) {
      const cluster = await this.prisma.client.cluster.findUnique({
        where: { id: input.clusterId },
        select: { id: true, name: true, tenantId: true },
      });
      if (!cluster) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
      tenantId = cluster.tenantId;
      concurrencyKey = `cluster:${cluster.id}`;
      target = cluster.name;
      targetKind = 'cluster';
      targetIds = [cluster.id];
    } else if (input.lane) {
      concurrencyKey = `selftest:${input.lane}`;
      target = input.lane;
    }

    return this.create(
      {
        tenantId,
        type: JOB_TYPES.selftest,
        params: params as unknown as Prisma.InputJsonValue,
        concurrencyKey,
        concurrencyLabel: target,
        targetKind,
        targetIds,
        parentJobId: null,
      },
      actor,
    );
  }

  async create(
    input: {
      tenantId: string;
      type: string;
      params: Prisma.InputJsonValue;
      concurrencyKey: string | null;
      concurrencyLabel: string;
      targetKind: string | null;
      targetIds: string[];
      parentJobId: string | null;
    },
    actor: Actor,
  ): Promise<JobDetail> {
    const permission = CREATE_PERMISSION[input.type];
    if (!permission) {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 400,
        message: `No job type "${input.type}"`,
      });
    }
    assertAllowedAt(actor, permission, { tenantId: input.tenantId });

    // Say who holds the key before trying, because "somebody" is not an answer.
    // The partial unique index below is what actually decides; this only lets
    // the refusal name the job that is in the way.
    if (input.concurrencyKey) {
      const holder = await this.prisma.client.job.findFirst({
        where: { concurrencyKey: input.concurrencyKey, status: { in: [...ACTIVE_JOB_STATUSES] } },
        select: { id: true },
      });
      if (holder) throw this.concurrentRun(input.concurrencyLabel, holder.id);
    }

    let job: { id: string };
    try {
      job = await this.prisma.client.job.create({
        data: {
          tenantId: input.tenantId,
          type: input.type,
          params: input.params,
          concurrencyKey: input.concurrencyKey,
          targetKind: input.targetKind,
          targetIds: input.targetIds,
          parentJobId: input.parentJobId,
          createdByUserId: actor.id,
        },
        select: { id: true },
      });
    } catch (error) {
      // Lost a race with another request between the check and the insert.
      if ((error as { code?: unknown } | null)?.code === 'P2002') {
        throw this.concurrentRun(input.concurrencyLabel, null);
      }
      throw error;
    }

    await this.event(job.id, {
      level: 'INFO',
      key: JOB_EVENT_KEYS.queued,
      message: `Queued by ${actor.email}`,
      data: { by: actor.email },
    });

    try {
      await this.queue.enqueueJob(job.id);
    } catch (error) {
      // A job the queue never received would sit in QUEUED for ever, looking
      // like it is about to start. Failing it says what actually happened.
      await this.event(
        job.id,
        { level: 'ERROR', key: JOB_EVENT_KEYS.failed, message: 'The queue did not accept the job' },
        {
          guard: { status: 'QUEUED' },
          data: {
            status: 'FAILED',
            errorCode: ERROR_CODES.generic,
            errorMessage: 'The queue did not accept the job',
            finishedAt: new Date(),
          },
        },
      );
      throw error;
    }

    await this.audit.record({
      action: input.parentJobId ? AUDIT_ACTIONS.jobRetried : AUDIT_ACTIONS.jobCreated,
      result: 'SUCCESS',
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: input.tenantId,
      resourceType: 'job',
      resourceId: job.id,
      resourceLabel: input.type,
      metadata: { type: input.type, concurrencyKey: input.concurrencyKey, parentJobId: input.parentJobId },
    });

    return this.get(job.id, actor);
  }

  private concurrentRun(target: string, holder: string | null): VelnoxError {
    return new VelnoxError(ERROR_CODES.jobConcurrentRun, {
      status: 409,
      message: 'Another job holds this concurrency key',
      params: { target, jobId: holder },
    });
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(
    filter: { status?: JobStatus; type?: string; tenantId?: string; limit: number },
    actor: Actor,
  ): Promise<JobSummary[]> {
    const rows = await this.prisma.client.job.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.type ? { type: filter.type } : {}),
        ...(filter.tenantId ? { tenantId: filter.tenantId } : {}),
      },
      include: jobInclude,
      orderBy: { queuedAt: 'desc' },
      take: filter.limit,
    });

    // The data layer already limits this to tenants the actor can reach at
    // all. Reaching a tenant is not the same as holding jobs.read there, so
    // each row is checked for that permission too.
    return rows
      .filter((row) => isAllowed(actor.grants, PERMISSIONS.jobsRead, { tenantId: row.tenantId }))
      .map(summarise);
  }

  async get(id: string, actor: Actor): Promise<JobDetail> {
    const job = await this.visible(id, actor, PERMISSIONS.jobsRead);

    const [steps, approvals, retries] = await Promise.all([
      this.prisma.client.jobStep.findMany({ where: { jobId: id }, orderBy: { sequence: 'asc' } }),
      this.prisma.client.approval.findMany({ where: { jobId: id }, orderBy: { requestedAt: 'asc' } }),
      this.prisma.client.job.findMany({
        where: { parentJobId: id },
        select: { id: true, status: true, queuedAt: true },
        orderBy: { queuedAt: 'asc' },
      }),
    ]);

    const deciders = await this.emails(
      approvals.map((approval) => approval.decidedByUserId).filter((value): value is string => !!value),
    );

    return {
      ...summarise(job),
      params: (job.params ?? {}) as Record<string, unknown>,
      steps: steps.map((step) => ({
        key: step.stepKey,
        phase: step.phase,
        sequence: step.sequence,
        status: step.status,
        attempt: step.attempt,
        startedAt: step.startedAt?.toISOString() ?? null,
        finishedAt: step.finishedAt?.toISOString() ?? null,
        error: step.error,
      })),
      approvals: approvals.map(
        (approval): ApprovalSummary => ({
          id: approval.id,
          stepKey: approval.stepKey,
          requiredPermission: approval.requiredPermission,
          reason: approval.reason,
          changeSet: (approval.changeSet ?? {}) as Record<string, unknown>,
          requireDifferentApprover: approval.requireDifferentApprover,
          requestedAt: approval.requestedAt.toISOString(),
          decidedAt: approval.decidedAt?.toISOString() ?? null,
          decision: approval.decision,
          decidedBy: approval.decidedByUserId ? (deciders.get(approval.decidedByUserId) ?? null) : null,
          decisionNote: approval.decisionNote,
        }),
      ),
      retries: retries.map((retry) => ({
        id: retry.id,
        status: retry.status,
        queuedAt: retry.queuedAt.toISOString(),
      })),
    };
  }

  async logs(id: string, after: string | null, limit: number, actor: Actor): Promise<JobLogLine[]> {
    await this.visible(id, actor, PERMISSIONS.jobsRead);
    const rows = await this.prisma.client.jobLog.findMany({
      where: { jobId: id, ...(after ? { id: { gt: BigInt(after) } } : {}) },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id.toString(),
      stepKey: row.stepKey,
      stream: row.stream,
      at: row.at.toISOString(),
      content: row.content,
      truncated: row.truncated,
    }));
  }

  async events(id: string, after: number, limit: number, actor: Actor): Promise<JobEventMessage[]> {
    await this.visible(id, actor, PERMISSIONS.jobsRead);
    const rows = await this.prisma.client.jobEvent.findMany({
      where: { jobId: id, seq: { gt: after } },
      orderBy: { seq: 'asc' },
      take: limit,
    });
    return rows.map((row) => toMessage(id, row));
  }

  /**
   * The live stream.
   *
   * Order of operations is the whole design. The listener is attached **before**
   * the history is read, and buffers until the history has been sent: an event
   * published between "read history" and "start listening" would otherwise
   * fall into the gap and never arrive. Sequence numbers make the overlap
   * harmless — anything already sent is dropped.
   *
   * The stream ends after the event that makes the job final, with a `done`
   * event first. A browser's EventSource reconnects on its own whenever a
   * connection closes, so the client must close it on `done`; and a reconnect
   * to a job that is already finished gets `done` straight away rather than an
   * open stream that will never say anything.
   */
  async stream(
    id: string,
    lastSeq: number,
    actor: Actor,
    signal?: AbortSignal,
  ): Promise<Observable<MessageEvent>> {
    const job = await this.visible(id, actor, PERMISSIONS.jobsRead);

    const buffered: JobEventMessage[] = [];
    let sink: ((event: JobEventMessage) => void) | null = null;
    const stopListening = this.hub.listen(id, (event) => (sink ? sink(event) : buffered.push(event)));

    let history: JobEventMessage[];
    try {
      history = (
        await this.prisma.client.jobEvent.findMany({
          where: { jobId: id, seq: { gt: lastSeq } },
          orderBy: { seq: 'desc' },
          take: REPLAY_LIMIT,
        })
      )
        .reverse()
        .map((row) => toMessage(id, row));
    } catch (error) {
      stopListening();
      throw error;
    }

    signal?.addEventListener('abort', stopListening, { once: true });

    return new Observable<MessageEvent>((subscriber) => {
      let last = lastSeq;
      let finished = false;

      /*
       * Every message that is not a comment carries an id, and the id is always
       * a real sequence number. Nest stamps any message *without* an id with a
       * per-connection counter of its own — 1, 2, 3 — and the browser keeps
       * whichever id it saw last, so an unnumbered `done` or heartbeat would
       * reset its place in the stream to a number that means nothing. Found by
       * verify-jobs.sh, whose sequence check saw ids that were not the job's.
       */
      const finish = (status: JobStatus) => {
        if (finished) return;
        finished = true;
        subscriber.next({ id: String(last), type: 'done', data: { status } });
        subscriber.complete();
      };

      const send = (event: JobEventMessage) => {
        if (finished || event.seq <= last) return;
        last = event.seq;
        subscriber.next({ id: String(event.seq), type: 'job', data: event });
        if (isTerminal(event.status)) finish(event.status);
      };

      for (const event of history) send(event);
      for (const event of buffered.sort((a, b) => a.seq - b.seq)) send(event);
      sink = send;

      // Nothing newer than what the browser already has, and the job is done:
      // there is nothing left to wait for.
      if (!finished && isTerminal(job.status) && last >= job.eventSeq) finish(job.status);

      // A comment: browsers ignore it, proxies see traffic, and Nest gives it no
      // id — so it cannot move the browser's place in the stream.
      const heartbeat = setInterval(() => {
        subscriber.next({ comment: 'keepalive' });
      }, STREAM_HEARTBEAT_MS);

      return () => {
        clearInterval(heartbeat);
        stopListening();
      };
    });
  }

  // -------------------------------------------------------------------------
  // Deciding
  // -------------------------------------------------------------------------

  async cancel(id: string, actor: Actor): Promise<JobDetail> {
    const job = await this.visible(id, actor, PERMISSIONS.jobsCancel);
    const status = job.status as JobStatus;

    if (isTerminal(status)) {
      throw new VelnoxError(ERROR_CODES.jobAlreadyFinished, { status: 409, params: { status } });
    }

    // Not started, or parked: nobody holds it, so the API finishes it here.
    if (status === 'QUEUED' || status === 'WAITING_APPROVAL') {
      assertTransition(status, 'CANCELLED');
      const now = new Date();
      const moved = await this.event(
        id,
        {
          level: 'WARN',
          key: JOB_EVENT_KEYS.cancelled,
          message:
            status === 'QUEUED'
              ? `Cancelled by ${actor.email} before it started`
              : `Cancelled by ${actor.email} while waiting for approval`,
          data: { by: actor.email, interrupted: false },
        },
        {
          guard: { status },
          data: {
            status: 'CANCELLED',
            finishedAt: now,
            cancelRequestedAt: now,
            cancelRequestedBy: actor.id,
            currentStep: null,
          },
        },
      );

      if (moved) {
        await this.prisma.client.jobStep.updateMany({
          where: { jobId: id, status: { in: ['PENDING', 'RUNNING'] } },
          data: { status: 'SKIPPED' },
        });
        await this.queue.dequeueJob(id).catch(() => undefined);
        await this.recordDecision(AUDIT_ACTIONS.jobCancelled, job, actor, { from: status });
        return this.get(id, actor);
      }
      // A worker claimed it between the read and the write. It is running now,
      // so it is cancelled the way a running job is.
    }

    // Running: ask, and let the worker stop at the next safe point. The flag in
    // Redis is the fast path; the column is the record, and survives a flush.
    const requested = await this.prisma.client.job.updateMany({
      where: { id, cancelRequestedAt: null, status: { notIn: ['SUCCEEDED', 'PARTIALLY_SUCCEEDED', 'FAILED', 'ROLLED_BACK', 'CANCELLED'] } },
      data: { cancelRequestedAt: new Date(), cancelRequestedBy: actor.id },
    });
    await this.redis.client.set(jobCancelKey(id), actor.id, 'EX', CANCEL_FLAG_TTL);

    if (requested.count > 0) {
      await this.event(id, {
        level: 'WARN',
        key: JOB_EVENT_KEYS.cancelRequested,
        message: `Cancellation requested by ${actor.email}; the job stops at the next safe point`,
        data: { by: actor.email },
      });
      await this.recordDecision(AUDIT_ACTIONS.jobCancelRequested, job, actor, { from: job.status });
    }

    return this.get(id, actor);
  }

  async retry(id: string, actor: Actor): Promise<JobDetail> {
    const job = await this.visible(id, actor, PERMISSIONS.jobsRead);
    if (!RETRYABLE.includes(job.status as JobStatus)) {
      throw new VelnoxError(ERROR_CODES.jobNotRetryable, { status: 409, params: { status: job.status } });
    }
    if (NOT_RETRYABLE_TYPES.has(job.type)) {
      throw new VelnoxError(ERROR_CODES.jobNotRetryableType, { status: 409 });
    }

    return this.create(
      {
        tenantId: job.tenantId,
        type: job.type,
        params: (job.params ?? {}) as Prisma.InputJsonValue,
        concurrencyKey: job.concurrencyKey,
        concurrencyLabel: job.concurrencyKey ?? '',
        targetKind: job.targetKind,
        targetIds: job.targetIds,
        parentJobId: job.id,
      },
      actor,
    );
  }

  async decide(
    id: string,
    decision: 'APPROVED' | 'REJECTED',
    note: string | null,
    actor: Actor,
  ): Promise<JobDetail> {
    const job = await this.visible(id, actor, PERMISSIONS.jobsApprove);
    const status = job.status as JobStatus;

    if (isTerminal(status)) {
      throw new VelnoxError(ERROR_CODES.jobAlreadyFinished, { status: 409, params: { status } });
    }
    if (status !== 'WAITING_APPROVAL') {
      throw new VelnoxError(ERROR_CODES.jobNotWaitingApproval, { status: 409 });
    }

    const approval = await this.prisma.client.approval.findFirst({
      where: { jobId: id, decision: null },
      orderBy: { requestedAt: 'desc' },
    });
    if (!approval) throw new VelnoxError(ERROR_CODES.jobNotWaitingApproval, { status: 409 });

    // The gate names the permission it needs, which may be narrower than
    // jobs.approve — an upgrade gate asks for the right to run upgrades.
    assertAllowedAt(actor, approval.requiredPermission as Permission, { tenantId: job.tenantId });

    // Four-eyes governs *approving*. The point is that nobody pushes their own
    // change through alone; declining your own request is withdrawing it, which
    // the requester could do anyway by cancelling. Found by verify-jobs.sh.
    if (
      decision === 'APPROVED' &&
      approval.requireDifferentApprover &&
      job.createdByUserId === actor.id
    ) {
      throw new VelnoxError(ERROR_CODES.authzFourEyes, { status: 403 });
    }

    const decided = await this.prisma.client.approval.updateMany({
      where: { id: approval.id, decision: null },
      data: {
        decision,
        decidedAt: new Date(),
        decidedByUserId: actor.id,
        decisionNote: note ? rootRedactor.text(note) : null,
      },
    });
    // Somebody else decided in the meantime; theirs stands.
    if (decided.count === 0) throw new VelnoxError(ERROR_CODES.jobNotWaitingApproval, { status: 409 });

    if (decision === 'APPROVED') {
      assertTransition('WAITING_APPROVAL', 'QUEUED');
      await this.event(
        id,
        {
          level: 'INFO',
          key: JOB_EVENT_KEYS.approved,
          stepKey: approval.stepKey,
          message: `Approved by ${actor.email}`,
          data: { by: actor.email },
        },
        { guard: { status: 'WAITING_APPROVAL' }, data: { status: 'QUEUED' } },
      );
      await this.queue.enqueueJob(id);
      await this.recordDecision(AUDIT_ACTIONS.jobApproved, job, actor, { step: approval.stepKey });
    } else {
      assertTransition('WAITING_APPROVAL', 'FAILED');
      await this.event(
        id,
        {
          level: 'ERROR',
          key: JOB_EVENT_KEYS.rejected,
          stepKey: approval.stepKey,
          message: `Rejected by ${actor.email}`,
          data: { by: actor.email },
        },
        {
          guard: { status: 'WAITING_APPROVAL' },
          data: {
            status: 'FAILED',
            errorCode: ERROR_CODES.jobRejected,
            errorMessage: `Rejected at ${approval.stepKey}`,
            finishedAt: new Date(),
            currentStep: null,
          },
        },
      );
      await this.prisma.client.jobStep.updateMany({
        where: { jobId: id, status: { in: ['PENDING', 'RUNNING'] } },
        data: { status: 'SKIPPED' },
      });
      await this.recordDecision(AUDIT_ACTIONS.jobRejected, job, actor, { step: approval.stepKey });
    }

    return this.get(id, actor);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * The job, if the actor may see it and holds `permission` at its tenant.
   *
   * A job in a tenant outside the actor's reach is filtered out by the data
   * layer and reads as not found, which is what it should look like: the
   * existence of another customer's job is not something to confirm.
   */
  private async visible(id: string, actor: Actor, permission: Permission): Promise<JobRow> {
    const job = await this.prisma.client.job.findUnique({ where: { id }, include: jobInclude });
    if (!job) throw new VelnoxError(ERROR_CODES.jobNotFound, { status: 404 });
    assertAllowedAt(actor, permission, { tenantId: job.tenantId });
    return job;
  }

  /** Append an event (redacted), then publish it. */
  private async event(id: string, event: JobEventWrite, change?: JobChange): Promise<boolean> {
    const clean: JobEventWrite = {
      ...event,
      message: rootRedactor.text(event.message),
      data: (rootRedactor.value(event.data ?? {}) ?? {}) as JobEventWrite['data'],
    };
    const written = await appendJobEvent(this.prisma.client, id, clean, change);
    if (!written) return false;

    const message: JobEventMessage = {
      jobId: id,
      seq: written.seq,
      at: written.at.toISOString(),
      level: clean.level,
      key: clean.key,
      stepKey: clean.stepKey ?? null,
      message: clean.message,
      data: clean.data ?? {},
      status: written.status as JobStatus,
      progressPct: written.progressPct,
    };
    await this.redis.client.publish(jobEventChannel(id), JSON.stringify(message)).catch(() => undefined);
    return true;
  }

  private async recordDecision(
    action: string,
    job: JobRow,
    actor: Actor,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      action,
      result: 'SUCCESS',
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: job.tenantId,
      resourceType: 'job',
      resourceId: job.id,
      resourceLabel: job.type,
      metadata,
    });
  }

  private async emails(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const users = await this.prisma.client.user.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, email: true },
    });
    return new Map(users.map((user) => [user.id, user.email]));
  }
}

function summarise(job: JobRow): JobSummary {
  return {
    id: job.id,
    tenantId: job.tenantId,
    tenantName: job.tenant.name,
    type: job.type,
    status: job.status,
    progressPct: job.progressPct,
    currentStep: job.currentStep,
    queuedAt: job.queuedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    errorCode: job.errorCode,
    errorParams: isParams(job.errorParams) ? job.errorParams : null,
    errorDetail: job.errorMessage,
    createdBy: job.createdBy ? { id: job.createdBy.id, email: job.createdBy.email } : null,
    targetKind: job.targetKind,
    targetIds: job.targetIds,
    concurrencyKey: job.concurrencyKey,
    parentJobId: job.parentJobId,
    cancelRequested: job.cancelRequestedAt !== null,
    eventSeq: job.eventSeq,
  };
}

function toMessage(
  jobId: string,
  row: {
    seq: number;
    at: Date;
    level: string;
    eventKey: string;
    stepKey: string | null;
    message: string;
    data: Prisma.JsonValue;
    status: string;
    progressPct: number | null;
  },
): JobEventMessage {
  return {
    jobId,
    seq: row.seq,
    at: row.at.toISOString(),
    level: row.level as JobEventMessage['level'],
    key: row.eventKey,
    stepKey: row.stepKey,
    message: row.message,
    data: (row.data ?? {}) as JobEventMessage['data'],
    status: row.status as JobStatus,
    progressPct: row.progressPct,
  };
}

/** Stored params are JSON; only a flat record of plain values is passed on. */
function isParams(value: unknown): value is Record<string, string | number | boolean | null> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => entry === null || ['string', 'number', 'boolean'].includes(typeof entry))
  );
}
