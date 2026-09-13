import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { PERMISSIONS } from '@velnox/shared';
import { RequirePermissionSomewhere } from '../../common/auth.guard';
import { zodQuery } from '../../common/zod-validation.pipe';
import { UsersService } from './users.service';

const listSchema = z.object({ tenantId: z.string().uuid().optional() });

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequirePermissionSomewhere(PERMISSIONS.usersRead)
  @Get()
  @ApiOperation({
    summary: 'List user accounts',
    description:
      'Scoped to what the caller may reach, and optionally narrowed further to one tenant. ' +
      'Password hashes, MFA seeds and recovery codes are not part of this response and are not ' +
      'returned by any endpoint.',
  })
  async list(@Query(zodQuery(listSchema)) query: z.infer<typeof listSchema>) {
    /*
     * No tenant argument derived from the principal any more.
     *
     * Phase 2 passed `isMspRoot ? null : ownTenant` from here, which was the
     * right rule written in the wrong place: every list endpoint had to remember
     * it, and forgetting was a cross-tenant read. The Prisma tenancy extension
     * now applies it underneath, so `tenantId` here can only narrow — an id the
     * caller cannot reach returns nothing rather than someone else's accounts.
     */
    return { users: await this.users.list(query.tenantId ?? null) };
  }
}
