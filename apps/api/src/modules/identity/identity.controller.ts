import { Body, Controller, Get, HttpCode, Post, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { ERROR_CODES, PERMISSIONS, VelnoxError } from '@velnox/shared';
import { zodBody } from '../../common/zod-validation.pipe';
import { RequirePermission } from '../../common/auth.guard';
import { IdentityService } from './identity.service';

const updateSchema = z.object({
  enabled: z.boolean().optional(),
  // Rejected here as well as in the discovery check, so a plain-HTTP URL is
  // never stored in the first place.
  discoveryUrl: z.string().url().startsWith('https://').max(2048).nullable().optional(),
  issuer: z.string().url().max(2048).nullable().optional(),
  clientId: z.string().trim().min(1).max(200).nullable().optional(),
  clientSecret: z.string().max(2048).nullable().optional(),
  allowedEmailDomains: z.array(z.string().trim().toLowerCase().min(1).max(253)).max(50).optional(),
  autoProvision: z.boolean().optional(),
});

@ApiTags('identity')
@Controller('identity-providers/oidc')
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  @RequirePermission(PERMISSIONS.systemManage)
  @Get()
  @ApiOperation({
    summary: 'The Microsoft Entra ID configuration',
    description:
      'The client secret is never included. `signInAvailable` reports whether signing in through ' +
      'this provider actually works in this build, which is a different question from whether it ' +
      'is configured.',
  })
  view() {
    return this.identity.view();
  }

  @RequirePermission(PERMISSIONS.systemManage)
  @Put()
  @ApiOperation({
    summary: 'Update the configuration',
    description:
      'The client secret is written to the credential store and cannot be read back. Omitting it ' +
      'leaves the stored one alone; sending null removes it.',
  })
  update(
    @Body(zodBody(updateSchema)) body: z.infer<typeof updateSchema>,
    @Req() request: Request,
  ) {
    return this.identity.update(body, actorOf(request));
  }

  @RequirePermission(PERMISSIONS.systemManage)
  @Post('test')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Check the configuration against the provider',
    description:
      'Fetches the discovery document and validates it. The result is recorded, so the interface ' +
      'can report what was actually observed rather than that a form was filled in.',
  })
  test(@Req() request: Request) {
    return this.identity.testConnection(actorOf(request));
  }
}

function actorOf(request: Request) {
  const principal = request.velnoxPrincipal;
  if (!principal) throw new VelnoxError(ERROR_CODES.authSessionExpired, { status: 401 });
  return {
    id: principal.user.id,
    email: principal.user.email,
    tenantId: principal.user.tenantId,
  };
}
