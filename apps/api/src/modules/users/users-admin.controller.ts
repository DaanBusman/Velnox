import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { ERROR_CODES, PERMISSIONS, VelnoxError } from '@velnox/shared';
import { PASSWORD_MIN_LENGTH } from '@velnox/crypto';
import { zodBody } from '../../common/zod-validation.pipe';
import { RequirePermission } from '../../common/auth.guard';
import { UserAdminService, type Actor } from './user-admin.service';

const createSchema = z.object({
  email: z.string().email().max(320),
  displayName: z.string().trim().min(2).max(120),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(256),
});

const statusSchema = z.object({ status: z.enum(['ACTIVE', 'DISABLED']) });
const assignSchema = z.object({ roleId: z.string().uuid() });

/**
 * Every id in a path is a uuid, and anything else is rejected before it can
 * reach the database.
 *
 * Without this a malformed id produced a Prisma conversion error, which the
 * filter turned into a 500 carrying an internal message — an operator typo
 * reported as a server fault. Observed, then fixed.
 */
const uuidParam = new ParseUUIDPipe({ version: '4' });

@ApiTags('users')
@Controller('users')
export class UsersAdminController {
  constructor(private readonly users: UserAdminService) {}

  @RequirePermission(PERMISSIONS.usersManage)
  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create an account',
    description:
      'Velnox sends no email, so there is no invitation: an administrator sets an initial ' +
      'password and passes it on out of band. The password is held to the same strength rule as ' +
      'every other one.',
  })
  create(@Body(zodBody(createSchema)) body: z.infer<typeof createSchema>, @Req() request: Request) {
    return this.users.create(body, actorOf(request));
  }

  @RequirePermission(PERMISSIONS.usersManage)
  @Patch(':id/status')
  @ApiOperation({
    summary: 'Enable or disable an account',
    description:
      'Disabling revokes every session the account holds. Without that it would keep working ' +
      'until its tokens expired, which is hours of access after someone decided it should stop.',
  })
  setStatus(
    @Param('id', uuidParam) id: string,
    @Body(zodBody(statusSchema)) body: z.infer<typeof statusSchema>,
    @Req() request: Request,
  ) {
    return this.users.setStatus(id, body.status, actorOf(request));
  }

  @RequirePermission(PERMISSIONS.rolesManage)
  @Post(':id/role-assignments')
  @HttpCode(201)
  @ApiOperation({ summary: 'Grant a role to an account' })
  assignRole(
    @Param('id', uuidParam) id: string,
    @Body(zodBody(assignSchema)) body: z.infer<typeof assignSchema>,
    @Req() request: Request,
  ) {
    return this.users.assignRole(id, body.roleId, actorOf(request));
  }

  @RequirePermission(PERMISSIONS.rolesManage)
  @Delete(':id/role-assignments/:assignmentId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Take a role away from an account' })
  async revokeRole(
    @Param('id', uuidParam) id: string,
    @Param('assignmentId', uuidParam) assignmentId: string,
    @Req() request: Request,
  ) {
    await this.users.revokeRole(id, assignmentId, actorOf(request));
  }
}

function actorOf(request: Request): Actor {
  const principal = request.velnoxPrincipal;
  if (!principal) throw new VelnoxError(ERROR_CODES.authSessionExpired, { status: 401 });
  return {
    id: principal.user.id,
    email: principal.user.email,
    tenantId: principal.user.tenantId,
    isMspRoot: principal.isMspRoot,
  };
}
