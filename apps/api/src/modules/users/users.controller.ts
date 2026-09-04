import { Controller, Get, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ERROR_CODES, PERMISSIONS, VelnoxError } from '@velnox/shared';
import { RequirePermission } from '../../common/auth.guard';
import { UsersService } from './users.service';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequirePermission(PERMISSIONS.usersRead)
  @Get()
  @ApiOperation({
    summary: 'List user accounts',
    description:
      'An MSP-root principal sees every account; anyone else sees only their own tenant. ' +
      'Password hashes, MFA seeds and recovery codes are not part of this response and are not ' +
      'returned by any endpoint.',
  })
  async list(@Req() request: Request) {
    const principal = request.velnoxPrincipal;
    if (!principal) throw new VelnoxError(ERROR_CODES.authSessionExpired, { status: 401 });

    /*
     * Tenant scoping comes from the principal, never from the request.
     *
     * A tenant id taken from a query parameter would let any authenticated user
     * read another customer's account list by editing a URL. Proper per-tenant
     * delegation arrives with multi-tenancy; until then the rule is the strict
     * one, not the permissive one.
     */
    return {
      users: await this.users.list(principal.isMspRoot ? null : principal.user.tenantId),
    };
  }
}
