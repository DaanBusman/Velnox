import { Controller, Query, Req, Sse, SseSignal, type MessageEvent } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { z } from 'zod';
import { CHANGE_TOPICS, LIVE_REFRESH_CHOICES } from '@velnox/shared';
import { zodQuery } from '../../common/zod-validation.pipe';
import { actorOf } from '../../common/actor';
import { ChangesService } from './changes.service';

/** A comma-separated list, as an EventSource URL can only carry a query string. */
const commaList = (maxLength: number) =>
  z
    .string()
    .trim()
    .max(maxLength)
    .optional()
    .transform((value) => (value ? [...new Set(value.split(',').filter(Boolean))] : []));

const streamSchema = z.object({
  topics: commaList(100).pipe(z.array(z.enum(CHANGE_TOPICS)).min(1).max(CHANGE_TOPICS.length)),
  clusters: commaList(200 * 37).pipe(z.array(z.uuid()).max(200)),
  refresh: z.coerce
    .number()
    .int()
    .refine((n) => (LIVE_REFRESH_CHOICES as readonly number[]).includes(n))
    .optional(),
});

@ApiTags('changes')
@Controller('changes')
export class ChangesController {
  constructor(private readonly changes: ChangesService) {}

  /**
   * "Something changed", for an open screen to refresh on.
   *
   * No permission of its own: every change is passed on only to a viewer who
   * may read what changed, at its scope (see `mayHear`), and the stream carries
   * no data — the screen reads that through the endpoints that check it.
   */
  @Sse()
  @ApiOperation({
    summary: 'Server-sent "something changed" signals for an open screen',
    description:
      'Topics: inventory, jobs. With clusters and refresh, also keeps live status read for those clusters while open.',
  })
  stream(
    @Query(zodQuery(streamSchema)) query: z.infer<typeof streamSchema>,
    @Req() request: Request,
    @SseSignal() signal: AbortSignal,
  ): Promise<Observable<MessageEvent>> {
    return this.changes.stream(actorOf(request), query, signal);
  }
}
