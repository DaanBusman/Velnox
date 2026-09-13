import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { PERMISSIONS, isFingerprint } from '@velnox/shared';
import { RequirePermission, RequirePermissionSomewhere } from '../../common/auth.guard';
import { zodBody, zodQuery } from '../../common/zod-validation.pipe';
import { actorOf } from '../../common/actor';
import { ClustersService } from './clusters.service';
import { InventoryReadService } from './inventory-read.service';

const uuidParam = new ParseUUIDPipe({ version: '4' });

/** A hostname or an address. Not a URL: the scheme and path are Velnox's to decide. */
const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9._:-]+$/, 'A hostname or IP address, without a scheme or path');

const probeSchema = z.object({
  host: hostSchema,
  port: z.coerce.number().int().min(1).max(65535).default(8006),
});

const fingerprintSchema = z.string().refine(isFingerprint, {
  message: 'A SHA-256 certificate fingerprint, as `pvenode cert info` prints it',
});

const createSchema = z.object({
  tenantId: z.string().uuid(),
  siteId: z.string().uuid().nullish(),
  name: z.string().trim().min(2).max(120),
  host: hostSchema,
  port: z.coerce.number().int().min(1).max(65535).default(8006),
  /** The fingerprint the operator confirmed, from the probe above. */
  fingerprint: fingerprintSchema,
  auth: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('API_TOKEN'),
      /** `root@pam!velnox`, exactly as Proxmox shows it. */
      tokenId: z
        .string()
        .trim()
        .min(3)
        .max(200)
        .regex(/^[^@]+@[^!]+![^!]+$/, 'user@realm!tokenid'),
      secret: z.string().min(1).max(500),
    }),
    z.object({
      kind: z.literal('TICKET'),
      username: z.string().trim().min(1).max(120),
      realm: z.string().trim().min(1).max(60),
      password: z.string().min(1).max(500),
    }),
  ]),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    siteId: z.string().uuid().nullish(),
    /** Zero turns scheduled discovery off for this cluster. */
    discoveryIntervalMinutes: z.coerce.number().int().min(0).max(1440).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to change' });

const listSchema = z.object({
  tenantId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
});

/**
 * Clusters.
 *
 * Adding one is two calls on purpose. `probe` shows the certificate and sends no
 * credential; `create` takes the fingerprint the operator confirmed and only
 * then authenticates, against that pinned certificate. Collapsing them into one
 * call would mean sending a token to a host nobody has vouched for.
 */
@ApiTags('inventory')
@Controller('clusters')
export class ClustersController {
  constructor(
    private readonly clusters: ClustersService,
    private readonly inventory: InventoryReadService,
  ) {}

  @RequirePermissionSomewhere(PERMISSIONS.clustersRead)
  @Get()
  @ApiOperation({ summary: 'List clusters' })
  async list(@Query(zodQuery(listSchema)) query: z.infer<typeof listSchema>) {
    return { clusters: await this.clusters.list(query) };
  }

  @RequirePermissionSomewhere(PERMISSIONS.clustersManage)
  @Post('probe')
  @HttpCode(200)
  @ApiOperation({
    summary: "Read a host's certificate, without authenticating",
    description:
      'The first half of adding a cluster. Completes a TLS handshake, reads the certificate and ' +
      'sends no token, no ticket and no cookie — which is what makes connecting to a host nobody ' +
      'has vouched for acceptable. Confirm the fingerprint against `pvenode cert info` on the ' +
      'node before using it.',
  })
  probe(@Body(zodBody(probeSchema)) body: z.infer<typeof probeSchema>, @Req() request: Request) {
    return this.clusters.probe(body, actorOf(request));
  }

  @RequirePermission(PERMISSIONS.clustersManage, (request) => ({
    tenantId: (request.body as { tenantId?: string } | undefined)?.tenantId ?? null,
    siteId: (request.body as { siteId?: string } | undefined)?.siteId ?? null,
  }))
  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Add a cluster',
    description:
      'Stores the credential encrypted, pins the fingerprint, and proves the credential works ' +
      'before answering. A cluster that appears in the list and then silently fails every ' +
      'discovery run is worse than a refusal while the operator is still looking at the form.',
  })
  create(@Body(zodBody(createSchema)) body: z.infer<typeof createSchema>, @Req() request: Request) {
    return this.clusters.create(body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.clustersRead)
  @Get(':id')
  @ApiOperation({ summary: 'One cluster' })
  get(@Param('id', uuidParam) id: string) {
    return this.clusters.get(id);
  }

  @RequirePermissionSomewhere(PERMISSIONS.clustersRead)
  @Get(':id/ceph')
  @ApiOperation({
    summary: "A cluster's Ceph daemons",
    description:
      'Empty for a cluster without Ceph, which shows no Ceph surface at all rather than tiles ' +
      'reading zero.',
  })
  async ceph(@Param('id', uuidParam) id: string) {
    // Loaded through the scoped client first, so an unreachable cluster is a 404
    // rather than an empty daemon list.
    await this.clusters.get(id);
    return { daemons: await this.inventory.listCephDaemons(id) };
  }

  @RequirePermissionSomewhere(PERMISSIONS.clustersRead)
  @Get(':id/discovery-runs')
  @ApiOperation({ summary: 'Recent discovery runs, and what they could not learn' })
  async runs(@Param('id', uuidParam) id: string) {
    await this.clusters.get(id);
    return { runs: await this.clusters.runs(id) };
  }

  @RequirePermissionSomewhere(PERMISSIONS.clustersManage)
  @Patch(':id')
  @ApiOperation({
    summary: 'Rename a cluster, move it to a site, or change its discovery interval',
  })
  update(
    @Param('id', uuidParam) id: string,
    @Body(zodBody(updateSchema)) body: z.infer<typeof updateSchema>,
    @Req() request: Request,
  ) {
    return this.clusters.update(id, body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.clustersRead)
  @Post(':id/discover')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Ask for a discovery run now',
    description: 'Returns once the run is queued, not once it has finished.',
  })
  discover(@Param('id', uuidParam) id: string, @Req() request: Request) {
    return this.clusters.discover(id, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.clustersManage)
  @Delete(':id')
  @ApiOperation({
    summary: 'Stop managing a cluster',
    description:
      "Removes Velnox's cache of it and the stored credential. The cluster itself is untouched " +
      'and the audit trail is unaffected.',
  })
  remove(@Param('id', uuidParam) id: string, @Req() request: Request) {
    return this.clusters.remove(id, actorOf(request));
  }
}
