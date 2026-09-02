import { Controller, Get, Res } from '@nestjs/common';
import { Public } from '../../common/auth.guard';
import { ApiExcludeEndpoint, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { HealthResponse, ReadinessResponse } from '@velnox/shared';
import { HealthService } from './health.service';

/**
 * Probes live outside the /api/v1 prefix: they are infrastructure endpoints for
 * Docker and orchestrators, not part of the versioned public API, and they must
 * keep working across API version changes.
 */
@Public()
@ApiTags('health')
@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('healthz')
  @ApiExcludeEndpoint()
  liveness(): HealthResponse {
    return { status: 'ok', uptimeSeconds: this.health.uptimeSeconds() };
  }

  @Get('readyz')
  @ApiExcludeEndpoint()
  async readiness(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponse> {
    const result = await this.health.readiness();
    // 503 when not ready, so a load balancer stops sending traffic without
    // needing to parse the body. 'degraded' still serves: it means reduced
    // capability, not inability.
    res.status(result.status === 'down' ? 503 : 200);
    return result;
  }

  /** Served at /api/v1/health — the global prefix applies to this route. */
  @Get('health')
  @ApiOperation({
    summary: 'Service health',
    description:
      'Lightweight health signal for the frontend. Use /readyz for orchestration decisions.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        uptimeSeconds: { type: 'integer', example: 3600 },
      },
    },
  })
  apiHealth(): HealthResponse {
    return { status: 'ok', uptimeSeconds: this.health.uptimeSeconds() };
  }
}
