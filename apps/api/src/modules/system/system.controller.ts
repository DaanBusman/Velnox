import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/auth.guard';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { SourceOfferResponse, SystemInfoResponse } from '@velnox/shared';
import { SystemService } from './system.service';

@Public()
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
        url: { type: 'string', example: 'https://github.com/DaanBusman/Velnox' },
        modified: { type: 'boolean', example: false },
      },
    },
  })
  source(): Promise<SourceOfferResponse> {
    return this.system.source();
  }

}
