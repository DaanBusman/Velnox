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
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { ERROR_CODES, PERMISSIONS, VelnoxError } from '@velnox/shared';
import { RequirePermissionSomewhere } from '../../common/auth.guard';
import { zodBody, zodQuery } from '../../common/zod-validation.pipe';
import { actorOf } from '../../common/actor';
import { LibraryService, UPLOAD_CHUNK_MAX } from './library.service';

const uuidParam = new ParseUUIDPipe({ version: '4' });

const DRAIN_TIMEOUT_MS = 30_000;

/**
 * Read and discard what is left of a refused chunk's body.
 *
 * Answering before the body has arrived and then closing the connection lets
 * the client's TCP stack reset it while the client is still sending, and a
 * reset throws away the answer — the browser sees a network error instead of
 * the 409 carrying the offset it should resume from. So the refusal waits for
 * the body, up to one chunk's worth and thirty seconds; past either, the
 * connection is dropped, which is no worse than not waiting.
 */
function discardBody(request: Request): Promise<void> {
  if (request.readableEnded || request.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    let seen = 0;
    const done = () => {
      clearTimeout(timer);
      request.off('data', count);
      resolve();
    };
    const count = (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > UPLOAD_CHUNK_MAX) {
        request.destroy();
        done();
      }
    };
    const timer = setTimeout(() => {
      request.destroy();
      done();
    }, DRAIN_TIMEOUT_MS);
    request.on('data', count);
    request.once('end', done);
    request.once('close', done);
    request.once('error', done);
    request.resume();
  });
}

const urlSchema = z.object({
  url: z.string().trim().min(1).max(4000),
  /** Taken from the URL's last path segment when absent. */
  filename: z.string().trim().max(200).nullish(),
});

const uploadSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  /** Up to 1 TiB, which is well past any ISO and any sane cloud image. */
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(1024 ** 4),
});

const chunkQuery = z.object({ offset: z.coerce.number().int().min(0) });

/** A BCP 47 tag, or an empty string for "no language", or null to go back to the parsed one. */
const languageTag = z
  .string()
  .regex(
    /^$|^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/,
    'A language tag such as nl, en-GB or sr-Latn',
  )
  .nullable();

const renameSchema = z
  .object({
    title: z.string().trim().max(200).nullable().optional(),
    language: languageTag.optional(),
  })
  .refine((value) => value.title !== undefined || value.language !== undefined, {
    message: 'Nothing to change',
  });

const pveId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'A Proxmox node or storage name');

const pushSchema = z.object({
  clusterId: z.string().uuid(),
  node: pveId,
  storage: pveId,
});

/**
 * The ISO library.
 *
 * Reading needs `library.read`. Adding, renaming and removing need
 * `library.manage`, checked against the MSP root in the service. Moving a file
 * onto a cluster needs `clusters.manage` on that cluster, also checked in the
 * service once the cluster is known — the decorators here say only that the
 * caller holds the permission somewhere.
 */
@ApiTags('library')
@Controller('library')
export class LibraryController {
  constructor(private readonly library: LibraryService) {}

  @RequirePermissionSomewhere(PERMISSIONS.libraryRead)
  @Get()
  @ApiOperation({ summary: "The library's files, and how full it is" })
  list() {
    return this.library.list();
  }

  @RequirePermissionSomewhere(PERMISSIONS.libraryManage)
  @Post('url')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Fetch a file from a URL into the library',
    description:
      'Returns once the fetch is queued, with the job that performs it. The worker refuses ' +
      'loopback, link-local and Velnox-internal addresses, follows at most five redirects, and ' +
      'never from https down to http. The URL is shown and logged without its query string.',
  })
  addFromUrl(@Body(zodBody(urlSchema)) body: z.infer<typeof urlSchema>, @Req() request: Request) {
    return this.library.addFromUrl(body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.libraryManage)
  @Post('uploads')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Start a browser upload',
    description:
      "Reserves the file's size against the library's limits and returns the chunk size to " +
      'send. Chunks go to PUT /library/uploads/{id}/chunks?offset=N as application/octet-stream.',
  })
  startUpload(
    @Body(zodBody(uploadSchema)) body: z.infer<typeof uploadSchema>,
    @Req() request: Request,
  ) {
    return this.library.startUpload(body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.libraryManage)
  @Get('uploads/:id')
  @ApiOperation({ summary: 'Where an upload is up to, for resuming it' })
  uploadStatus(@Param('id', uuidParam) id: string, @Req() request: Request) {
    return this.library.uploadStatus(id, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.libraryManage)
  @Put('uploads/:id/chunks')
  @ApiOperation({
    summary: 'Send one chunk of an upload',
    description:
      'The offset must be where the upload is up to; any other is refused with the right one. ' +
      'The last chunk starts the check that makes the file available.',
  })
  async writeChunk(
    @Param('id', uuidParam) id: string,
    @Query(zodQuery(chunkQuery)) query: z.infer<typeof chunkQuery>,
    @Req() request: Request,
  ) {
    try {
      /*
       * The body is read straight off the request, unparsed. That holds only for
       * a content type no body parser claims — a chunk sent as JSON would be
       * buffered by the JSON parser, up to its limit, before this ran.
       */
      if (!request.is('application/octet-stream')) {
        throw new VelnoxError(ERROR_CODES.validation, {
          status: 415,
          message: 'Send chunks as application/octet-stream',
        });
      }
      const length = Number(request.headers['content-length']);
      if (!Number.isInteger(length) || length <= 0) {
        throw new VelnoxError(ERROR_CODES.validation, {
          status: 411,
          message: 'A Content-Length is required',
        });
      }
      return await this.library.writeChunk(id, query.offset, length, request, actorOf(request));
    } catch (error) {
      await discardBody(request);
      throw error;
    }
  }

  @RequirePermissionSomewhere(PERMISSIONS.libraryManage)
  @Delete('uploads/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Abandon an upload, and remove what arrived' })
  async abandonUpload(@Param('id', uuidParam) id: string, @Req() request: Request) {
    await this.library.abandonUpload(id, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.libraryRead)
  @Get(':id')
  @ApiOperation({ summary: 'One library file' })
  get(@Param('id', uuidParam) id: string) {
    return this.library.get(id);
  }

  @RequirePermissionSomewhere(PERMISSIONS.libraryManage)
  @Patch(':id')
  @ApiOperation({
    summary: "Correct a file's friendly name or language",
    description:
      'The filename never changes — it is what Proxmox calls the file. This corrects what the ' +
      'filename was read as, for the cases the parser gets wrong.',
  })
  rename(
    @Param('id', uuidParam) id: string,
    @Body(zodBody(renameSchema)) body: z.infer<typeof renameSchema>,
    @Req() request: Request,
  ) {
    return this.library.rename(id, body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.libraryManage)
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a file from the library',
    description:
      'Refused while a job is writing it or pushing it. Copies already on clusters are left alone.',
  })
  async remove(@Param('id', uuidParam) id: string, @Req() request: Request) {
    await this.library.remove(id, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.clustersManage)
  @Post(':id/push')
  @HttpCode(202)
  @ApiOperation({
    summary: "Copy a library file onto a cluster's storage",
    description:
      'Returns the job. Proxmox checks the file against its SHA-256 as it arrives and refuses a ' +
      'mismatch; a push that is cancelled or fails leaves nothing on the node.',
  })
  push(
    @Param('id', uuidParam) id: string,
    @Body(zodBody(pushSchema)) body: z.infer<typeof pushSchema>,
    @Req() request: Request,
  ) {
    return this.library.push({ itemId: id, ...body }, actorOf(request));
  }
}
