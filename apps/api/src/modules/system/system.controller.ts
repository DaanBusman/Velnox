import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type {
  PingJobAcceptedResponse,
  PingJobStatusResponse,
  SourceOfferResponse,
  SystemInfoResponse,
} from '@velnox/shared';
import { SystemService } from './system.service';

@ApiTags('system')
@Controller('system')
export class SystemController {
  constructor(private readonly system: SystemService) {}

  @Get('info')
  @ApiOperation({
    summary: 'Installation information',
    description:
      'Product name, version, supported locales and which subsystems exist in this build. ' +
      'The frontend uses `features` to decide what to show, so an unfinished subsystem is ' +
      'absent rather than present and broken.',
  })
  info(): Promise<SystemInfoResponse> {
    return this.system.info();
  }

  @Get('source')
  @ApiOperation({
    summary: 'Corresponding Source offer (AGPL section 13)',
    description:
      'Where to obtain the source of the exact build that is running, together with its commit. ' +
      'Velnox is AGPLv3: anyone interacting with a modified version over a network must be able ' +
      'to obtain that version’s source. Available to every user, not only administrators.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        product: { type: 'string', example: 'Velnox' },
        version: { type: 'string', example: '0.1.0' },
        commit: { type: 'string', example: 'a1b2c3d' },
        license: { type: 'string', example: 'AGPL-3.0-or-later' },
        url: { type: 'string', example: 'https://github.com/velnox-foundation/velnox' },
        modified: { type: 'boolean', example: false },
      },
    },
  })
  source(): Promise<SourceOfferResponse> {
    return this.system.source();
  }

  /**
   * Phase 1 only, behind VELNOX_DEV_ENDPOINTS. Returns 404 when disabled.
   * Phase 5 replaces this with the real job system, under RBAC.
   */
  @Post('selftest/queue')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Queue self-test (Phase 1 diagnostic)',
    description:
      'Enqueues a job for the worker so the api -> Redis -> worker path can be observed ' +
      'end to end. Disabled unless VELNOX_DEV_ENDPOINTS is set. Removed in Phase 2.',
  })
  startQueueSelfTest(): Promise<PingJobAcceptedResponse> {
    return this.system.startQueueSelfTest();
  }

  @Get('selftest/queue/:jobId')
  @ApiOperation({ summary: 'Queue self-test status (Phase 1 diagnostic)' })
  @ApiParam({ name: 'jobId', description: 'Id returned when the self-test was started' })
  queueSelfTestStatus(@Param('jobId') jobId: string): Promise<PingJobStatusResponse> {
    return this.system.queueSelfTestStatus(jobId);
  }
}
