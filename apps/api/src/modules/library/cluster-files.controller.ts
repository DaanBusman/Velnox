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
import { ClusterSshService } from './cluster-ssh.service';
import { LibraryService } from './library.service';

const uuidParam = new ParseUUIDPipe({ version: '4' });
const pveId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'A Proxmox node or storage name');

const volumeSchema = z.object({
  node: pveId,
  storage: pveId,
  volid: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}:(iso|import)\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/),
});

const probeSchema = z.object({ port: z.coerce.number().int().min(1).max(65535).default(22) });

const sshSchema = z.object({
  username: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z_][a-z0-9_.-]*$/i, 'A Unix username'),
  port: z.coerce.number().int().min(1).max(65535).default(22),
  privateKey: z
    .string()
    .min(50)
    .max(20_000)
    .refine((value) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value), {
      message: 'An OpenSSH or PEM private key',
    }),
  passphrase: z.string().max(1000).nullish(),
  /** The host keys the operator confirmed, from the probe. */
  hostKeys: z
    .array(
      z.object({
        node: pveId,
        fingerprint: z
          .string()
          .regex(/^SHA256:[A-Za-z0-9+/]{43}$/, 'SHA256:… as ssh-keygen prints it'),
      }),
    )
    .min(1),
});

/**
 * What is on a cluster's storage, and the SSH access used to copy it off.
 *
 * Under `/clusters/{id}` because that is what these are about; in the library
 * module because that is what uses them.
 */
@ApiTags('library')
@Controller('clusters')
export class ClusterFilesController {
  constructor(
    private readonly library: LibraryService,
    private readonly ssh: ClusterSshService,
  ) {}

  @RequirePermissionSomewhere(PERMISSIONS.clustersRead)
  @Get(':id/files')
  @ApiOperation({
    summary: "ISOs and disk images on a cluster's storage",
    description:
      'As discovery last saw them, marked with the library item that has the same name and size. ' +
      'Refreshed after every push, pull and delete, and on every discovery run.',
  })
  files(@Param('id', uuidParam) id: string) {
    return this.library.clusterContents(id);
  }

  @RequirePermissionSomewhere(PERMISSIONS.clustersManage)
  @Post(':id/files/delete')
  @HttpCode(202)
  @ApiOperation({
    summary: "Delete an ISO or disk image from a cluster's storage",
    description: 'Returns the job. The library copy, if there is one, is untouched.',
  })
  deleteFile(
    @Param('id', uuidParam) id: string,
    @Body(zodBody(volumeSchema)) body: z.infer<typeof volumeSchema>,
    @Req() request: Request,
  ) {
    return this.library.deleteOnCluster({ clusterId: id, ...body }, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.libraryManage)
  @Post(':id/files/pull')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Copy a file from a cluster into the library, over SSH',
    description:
      "Needs SSH set up on the cluster, because Proxmox's API has no call to read a file back. " +
      'SFTP only, against pinned host keys.',
  })
  pull(
    @Param('id', uuidParam) id: string,
    @Body(zodBody(volumeSchema)) body: z.infer<typeof volumeSchema>,
    @Req() request: Request,
  ) {
    return this.library.pull({ clusterId: id, ...body }, actorOf(request));
  }

  // --- SSH -----------------------------------------------------------------

  @RequirePermissionSomewhere(PERMISSIONS.clustersRead)
  @Get(':id/ssh')
  @ApiOperation({ summary: "A cluster's SSH set-up: user, port, and each node's pinned host key" })
  sshStatus(@Param('id', uuidParam) id: string) {
    return this.ssh.status(id);
  }

  @RequirePermissionSomewhere(PERMISSIONS.clustersManage)
  @Post(':id/ssh/probe')
  @HttpCode(200)
  @ApiOperation({
    summary: "Read each node's SSH host key, without authenticating",
    description:
      'The first half of setting SSH up. Compare each fingerprint with `ssh-keygen -lf ' +
      '/etc/ssh/ssh_host_ed25519_key.pub` on the node before confirming it.',
  })
  probe(
    @Param('id', uuidParam) id: string,
    @Body(zodBody(probeSchema)) body: z.infer<typeof probeSchema>,
    @Req() request: Request,
  ) {
    return this.ssh.probe(id, body.port, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.clustersManage)
  @Put(':id/ssh')
  @ApiOperation({
    summary: 'Set up SSH with a key and the confirmed host keys',
    description:
      'Stores the key encrypted, pins the host keys, and proves the key works on every pinned ' +
      'node before answering. On any failure nothing is kept.',
  })
  configure(
    @Param('id', uuidParam) id: string,
    @Body(zodBody(sshSchema)) body: z.infer<typeof sshSchema>,
    @Req() request: Request,
  ) {
    return this.ssh.configure(id, body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.clustersManage)
  @Delete(':id/ssh')
  @HttpCode(204)
  @ApiOperation({ summary: "Remove a cluster's SSH key and host key pins" })
  async removeSsh(@Param('id', uuidParam) id: string, @Req() request: Request) {
    await this.ssh.remove(id, actorOf(request));
  }
}
