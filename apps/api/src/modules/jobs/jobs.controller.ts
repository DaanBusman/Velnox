import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Sse,
  SseSignal,
  type MessageEvent,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { z } from 'zod';
import { JOB_STATUSES, PERMISSIONS, SELFTEST_LIMITS } from '@velnox/shared';
import { RequirePermission, RequirePermissionSomewhere } from '../../common/auth.guard';
import { zodBody, zodQuery } from '../../common/zod-validation.pipe';
import { actorOf } from '../../common/actor';
import { JobsService } from './jobs.service';

const uuidParam = new ParseUUIDPipe({ version: '4' });

const listSchema = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  type: z.string().trim().max(80).optional(),
  tenantId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const selftestSchema = z
  .object({
    /** Hold `cluster:<id>`, the key a real change to that cluster would hold. */
    clusterId: z.string().uuid().nullish(),
    /** Or a key of its own, `selftest:<lane>`. */
    lane: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lowercase letters, digits and hyphens')
      .nullish(),
    steps: z.number().int().min(SELFTEST_LIMITS.steps.min).max(SELFTEST_LIMITS.steps.max).optional(),
    secondsPerStep: z
      .number()
      .int()
      .min(SELFTEST_LIMITS.secondsPerStep.min)
      .max(SELFTEST_LIMITS.secondsPerStep.max)
      .optional(),
    failAtStep: z.number().int().min(1).nullish(),
    approvalBeforeStep: z.number().int().min(1).nullish(),
    requireDifferentApprover: z.boolean().optional(),
  })
  .refine((value) => !(value.clusterId && value.lane), {
    message: 'A cluster or a lane, not both',
  });

const afterSeqSchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

const afterLogSchema = z.object({
  after: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

const decisionSchema = z.object({
  note: z.string().trim().max(2000).nullish(),
});

/**
 * Jobs.
 *
 * Reading needs `jobs.read` somewhere, then at the job's own tenant — the
 * service checks the second, because the tenant is only known once the job has
 * been read. Cancelling needs `jobs.cancel`, deciding an approval needs
 * `jobs.approve` plus whatever permission the gate itself names.
 */
@ApiTags('jobs')
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @RequirePermissionSomewhere(PERMISSIONS.jobsRead)
  @Get()
  @ApiOperation({ summary: 'List jobs, newest first' })
  list(@Query(zodQuery(listSchema)) query: z.infer<typeof listSchema>, @Req() request: Request) {
    return this.jobs.list(query, actorOf(request)).then((jobs) => ({ jobs }));
  }

  @RequirePermission(PERMISSIONS.systemManage)
  @Post('selftest')
  @ApiOperation({
    summary: 'Start a self-test job',
    description:
      'A job that only takes time and reports on itself, for proving the job system against a ' +
      'running installation. Touches no infrastructure.',
  })
  selftest(@Body(zodBody(selftestSchema)) body: z.infer<typeof selftestSchema>, @Req() request: Request) {
    const { clusterId, lane, ...params } = body;
    return this.jobs.createSelftest({ clusterId, lane, params }, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.jobsRead)
  @Get(':id')
  get(@Param('id', uuidParam) id: string, @Req() request: Request) {
    return this.jobs.get(id, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.jobsRead)
  @Get(':id/events')
  @ApiOperation({ summary: 'Events after a sequence number' })
  events(
    @Param('id', uuidParam) id: string,
    @Query(zodQuery(afterSeqSchema)) query: z.infer<typeof afterSeqSchema>,
    @Req() request: Request,
  ) {
    return this.jobs
      .events(id, query.after, query.limit, actorOf(request))
      .then((events) => ({ events }));
  }

  @RequirePermissionSomewhere(PERMISSIONS.jobsRead)
  @Get(':id/logs')
  logs(
    @Param('id', uuidParam) id: string,
    @Query(zodQuery(afterLogSchema)) query: z.infer<typeof afterLogSchema>,
    @Req() request: Request,
  ) {
    return this.jobs
      .logs(id, query.after ?? null, query.limit, actorOf(request))
      .then((lines) => ({ lines }));
  }

  /**
   * Live events.
   *
   * A reconnecting browser sends `Last-Event-ID` on its own; `?after=` is the
   * same thing for the first connection, when the page already rendered some
   * history and wants only what comes next.
   */
  @RequirePermissionSomewhere(PERMISSIONS.jobsRead)
  @Sse(':id/stream')
  stream(
    @Param('id', uuidParam) id: string,
    @Query(zodQuery(afterSeqSchema)) query: z.infer<typeof afterSeqSchema>,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Req() request: Request,
    @SseSignal() signal: AbortSignal,
  ): Promise<Observable<MessageEvent>> {
    const fromHeader = Number.parseInt(lastEventId ?? '', 10);
    const after = Number.isFinite(fromHeader) && fromHeader >= 0 ? fromHeader : query.after;
    return this.jobs.stream(id, after, actorOf(request), signal);
  }

  @RequirePermissionSomewhere(PERMISSIONS.jobsCancel)
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id', uuidParam) id: string, @Req() request: Request) {
    return this.jobs.cancel(id, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.jobsRead)
  @Post(':id/retry')
  @ApiOperation({
    summary: 'Start a new job with the same parameters',
    description: 'The new job names this one as its parent. This job is not changed.',
  })
  retry(@Param('id', uuidParam) id: string, @Req() request: Request) {
    return this.jobs.retry(id, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.jobsApprove)
  @Post(':id/approve')
  @HttpCode(200)
  approve(
    @Param('id', uuidParam) id: string,
    @Body(zodBody(decisionSchema)) body: z.infer<typeof decisionSchema>,
    @Req() request: Request,
  ) {
    return this.jobs.decide(id, 'APPROVED', body.note ?? null, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.jobsApprove)
  @Post(':id/reject')
  @HttpCode(200)
  reject(
    @Param('id', uuidParam) id: string,
    @Body(zodBody(decisionSchema)) body: z.infer<typeof decisionSchema>,
    @Req() request: Request,
  ) {
    return this.jobs.decide(id, 'REJECTED', body.note ?? null, actorOf(request));
  }
}
