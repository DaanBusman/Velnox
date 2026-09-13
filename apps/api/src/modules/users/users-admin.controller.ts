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
import { PERMISSIONS, SCOPE_TYPES } from '@velnox/shared';
import { PASSWORD_MIN_LENGTH } from '@velnox/crypto';
import { zodBody } from '../../common/zod-validation.pipe';
import { RequirePermissionSomewhere } from '../../common/auth.guard';
import { actorOf } from '../../common/actor';
import { UserAdminService } from './user-admin.service';

const createSchema = z.object({
  email: z.string().email().max(320),
  displayName: z.string().trim().min(2).max(120),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(256),
  /** Which tenant the account belongs to. Defaults to the caller's own. */
  tenantId: z.string().uuid().optional(),
});

const statusSchema = z.object({ status: z.enum(['ACTIVE', 'DISABLED']) });
/**
 * A grant names what it covers.
 *
 * `scopeType` defaults to nothing on purpose — there is no sensible default. The
 * old endpoint granted at GLOBAL implicitly, which on a single-tenant
 * installation was invisible and on a fifty-tenant one meant every grant reached
 * every customer.
 */
const assignSchema = z
  .object({
    roleId: z.string().uuid(),
    scopeType: z.enum(SCOPE_TYPES),
    scopeId: z.string().uuid().nullish(),
  })
  .refine((value) => (value.scopeType === 'GLOBAL') === (value.scopeId == null), {
    message: 'A global grant has no scope id; every other scope needs one',
    path: ['scopeId'],
  });

/*
 * These routes use `RequirePermissionSomewhere` rather than `RequirePermission`.
 *
 * The scope that matters is the *target account's* tenant, which is not in the
 * request — only its id is. With `RequirePermission` and no scope resolver the
 * guard falls back to "global grants only", which locked tenant administrators
 * out of administering their own tenant's accounts. Each service method checks
 * the precise scope once it has loaded the row.
 */

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

  @RequirePermissionSomewhere(PERMISSIONS.usersManage)
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

  @RequirePermissionSomewhere(PERMISSIONS.usersManage)
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

  @RequirePermissionSomewhere(PERMISSIONS.usersResetMfa)
  @Delete(':id/mfa')
  @HttpCode(204)
  @ApiOperation({
    summary: "Remove an account's second factor",
    description:
      'For someone who has lost both their authenticator and their recovery codes. The account ' +
      'can enrol again at its next sign-in; its sessions are revoked and the act is audited under ' +
      'its own action. Never your own account — self-service disable exists for that and ' +
      'asks for a valid code. `users.reset_mfa` reaches accounts in a customer tenant; an account ' +
      'in the MSP root tenant additionally requires `users.reset_mfa_msp`, so an administrator or ' +
      'engineer can put a customer back in but not a colleague.',
  })
  async resetMfa(@Param('id', uuidParam) id: string, @Req() request: Request) {
    await this.users.resetMfa(id, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.rolesManage)
  @Post(':id/role-assignments')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Grant a role to an account, at a scope',
    description:
      'GLOBAL covers every tenant and is only possible for an account in the MSP organisation. ' +
      'TENANT and SITE name what the grant covers. The caller must already hold `roles.manage` ' +
      'at that same scope, so delegating access can never widen it.',
  })
  assignRole(
    @Param('id', uuidParam) id: string,
    @Body(zodBody(assignSchema)) body: z.infer<typeof assignSchema>,
    @Req() request: Request,
  ) {
    return this.users.assignRole(id, body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.rolesManage)
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
