import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@velnox/shared';
import { RequirePermission } from '../../common/auth.guard';
import { RolesService } from './roles.service';

@ApiTags('roles')
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @RequirePermission(PERMISSIONS.rolesRead)
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
}
