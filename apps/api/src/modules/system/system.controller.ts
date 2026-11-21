import { Body, Controller, Get, HttpCode, Post, Put, Req } from '@nestjs/common';
import { Public, RequirePermission } from '../../common/auth.guard';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import {
  PERMISSIONS,
  type SourceOfferResponse,
  type SystemInfoResponse,
  type TlsChangeResponse,
  type TlsStatusResponse,
  type UpdateStatusResponse,
} from '@velnox/shared';
import { actorOf } from '../../common/actor';
import { zodBody } from '../../common/zod-validation.pipe';
import { SystemService } from './system.service';
import { TlsConfigService } from './tls-config.service';
import { TlsService } from './tls.service';
import { UpdateCheckService } from './update-check.service';

const updateCheckSchema = z.object({ enabled: z.boolean() });

/*
 * What goes into Caddy's configuration is checked here to the character: an
 * address or a URL with a space, a brace or a newline in it would be a second
 * directive. PEM is length-limited and parsed by the service.
 */
const acmeEmail = z
  .string()
  .trim()
  .max(254)
  .regex(/^[^\s@{}"'`\\#;]+@[^\s@{}"'`\\#;]+\.[^\s@{}"'`\\#;]+$/, 'An email address');
const tlsChangeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('installer') }),
  z.object({ mode: z.literal('internal') }),
  z.object({
    mode: z.literal('acme'),
    email: acmeEmail,
    directory: z
      .string()
      .trim()
      .max(500)
      .regex(/^https:\/\/[^\s{}"'`\\#;]+$/, 'An https URL')
      .nullish(),
    caRoot: z.string().max(65_536).nullish(),
  }),
  z.object({
    mode: z.literal('certificate'),
    certificate: z.string().min(1).max(65_536),
    key: z.string().min(1).max(16_384),
  }),
  z.object({
    mode: z.literal('pfx'),
    // 64 KiB of file, as base64: far more than a certificate with its chain.
    pfx: z
      .string()
      .min(1)
      .max(87_384)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'A file as base64'),
    // A line, because openssl reads it as one.
    password: z
      .string()
      .max(1024)
      .regex(/^[^\r\n]*$/, 'One line'),
  }),
]);

/*
 * `@Public()` is on the two methods that are public, not on the class.
 *
 * The guard resolves it with getAllAndOverride([handler, class]), so a class-
 * level @Public() is inherited by every method — including one that also
 * carries @RequirePermission, which the guard never reaches because it returns
 * early on public. This class used to be annotated that way, and adding the
 * certificate endpoint to it would have published the installation's TLS
 * configuration to anonymous callers.
 */
@ApiTags('system')
@Controller('system')
export class SystemController {
  constructor(
    private readonly system: SystemService,
    private readonly tls: TlsService,
    private readonly tlsConfig: TlsConfigService,
    private readonly updates: UpdateCheckService,
  ) {}

  @Public()
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

  @Public()
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

  /*
   * Not @Public, unlike the two above.
   *
   * The certificate itself is offered to anyone who opens a browser, so it is
   * not secret — but this reports the configured mode, the ACME account address
   * and whether the proxy is answering at all, which together describe how the
   * installation is exposed. That belongs behind the same permission as the rest
   * of the installation settings.
   */
  @RequirePermission(PERMISSIONS.systemManage)
  @Get('tls')
  @ApiOperation({
    summary: 'The certificate being served',
    description:
      'Read by opening a TLS connection to the proxy and inspecting the certificate it presents, ' +
      'not from configuration — so a change that was written but never picked up is visible ' +
      'rather than reported as success.',
  })
  tlsStatus(): Promise<TlsStatusResponse> {
    return this.tls.status();
  }

  @RequirePermission(PERMISSIONS.systemManage)
  @Put('tls')
  @ApiOperation({
    summary: 'Change the certificate being served',
    description:
      'Caddy’s own certificate, one from an ACME CA (Let’s Encrypt unless another directory is ' +
      'named), an uploaded certificate and key or PFX file, or back to the installer’s. Applied through ' +
      'Caddy’s admin socket; refused configurations leave the previous certificate in place. ' +
      'The key is stored encrypted and never returned. The certificate served afterwards is read ' +
      'back over a handshake (ADR-045).',
  })
  changeTls(
    @Body(zodBody(tlsChangeSchema)) body: z.infer<typeof tlsChangeSchema>,
    @Req() request: Request,
  ): Promise<TlsChangeResponse> {
    return this.tlsConfig.apply(body, actorOf(request));
  }

  /*
   * The update check (0.7.21). Behind system.manage like the rest of Server
   * management: which version runs and what it is exposed to is not for every
   * user of the installation to read.
   */
  @RequirePermission(PERMISSIONS.systemManage)
  @Get('update')
  @ApiOperation({
    summary: 'Is there a newer Velnox',
    description:
      'What the worker last read from the release file (release.json on GitHub, or ' +
      'VELNOX_UPDATE_MANIFEST_URL), compared with the running version: whether a newer one ' +
      'exists and which advisories concern this installation. A failed read is reported as one, ' +
      'never as up to date.',
  })
  updateStatus(): Promise<UpdateStatusResponse> {
    return this.updates.status();
  }

  @RequirePermission(PERMISSIONS.systemManage)
  @Put('update')
  @ApiOperation({ summary: 'Switch the update check on or off', description: 'Audited.' })
  setUpdateCheck(
    @Body(zodBody(updateCheckSchema)) body: z.infer<typeof updateCheckSchema>,
    @Req() request: Request,
  ): Promise<UpdateStatusResponse> {
    return this.updates.setEnabled(body.enabled, actorOf(request));
  }

  @RequirePermission(PERMISSIONS.systemManage)
  @Post('update/check')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Check for a newer Velnox now',
    description: 'The worker reads the release file and the result is returned. Works while the check is off.',
  })
  checkForUpdate(): Promise<UpdateStatusResponse> {
    return this.updates.checkNow();
  }
}
