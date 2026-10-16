import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { PERMISSIONS } from '@velnox/shared';
import { RequirePermissionSomewhere } from '../../common/auth.guard';
import { zodBody } from '../../common/zod-validation.pipe';
import { actorOf } from '../../common/actor';
import { RolesService } from './roles.service';

const uuidParam = new ParseUUIDPipe({ version: '4' });

const customRoleSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).nullable().optional(),
    /** True: MSP staff only. False: customers' accounts may be given it too. */
    mspOnly: z.boolean(),
    permissions: z.array(z.string().min(1).max(64)).max(100),
  })
  .strict();

@ApiTags('roles')
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @RequirePermissionSomewhere(PERMISSIONS.rolesRead)
  @Get()
  @ApiOperation({
    summary: 'The roles this installation has, and what each one grants',
    description:
      'Permissions are read from the database rather than from the catalogue, so a role edited ' +
      'later is reported as it is. Any stored permission this build no longer recognises is ' +
      'listed separately instead of being quietly dropped.',
  })
  async list() {
    return {
      roles: await this.roles.list(),
      catalogue: this.roles.catalogue(),
    };
  }

  @RequirePermissionSomewhere(PERMISSIONS.rolesManage)
  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Make a custom role',
    description:
      'For the MSP, with `roles.manage` at global scope. A custom role holds only permissions its ' +
      'maker holds, never `system.manage` or `roles.manage`, and — when customers may be given ' +
      'it — no more than the Tenant Administrator role. A permission that changes something brings ' +
      'its read permission with it.',
  })
  create(
    @Body(zodBody(customRoleSchema)) body: z.infer<typeof customRoleSchema>,
    @Req() request: Request,
  ) {
    return this.roles.create(body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.rolesManage)
  @Put(':id')
  @ApiOperation({
    summary: 'Change a custom role',
    description:
      'The same rules as making one. Accounts holding it are given the change at their next ' +
      'request. A system role is refused.',
  })
  update(
    @Param('id', uuidParam) id: string,
    @Body(zodBody(customRoleSchema)) body: z.infer<typeof customRoleSchema>,
    @Req() request: Request,
  ) {
    return this.roles.update(id, body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.rolesManage)
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a custom role',
    description: 'Only once nobody holds it. A system role is refused.',
  })
  async remove(@Param('id', uuidParam) id: string, @Req() request: Request) {
    await this.roles.remove(id, actorOf(request));
  }
}
