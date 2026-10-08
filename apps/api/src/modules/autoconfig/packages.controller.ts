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
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { ERROR_CODES, PACKAGE_MAX_BYTES, PERMISSIONS, VelnoxError } from '@velnox/shared';
import { RequirePermissionSomewhere } from '../../common/auth.guard';
import { zodBody, zodQuery } from '../../common/zod-validation.pipe';
import { actorOf } from '../../common/actor';
import { discardBody } from '../library/library.controller';
import { PackagesService } from './packages.service';

const uuidParam = new ParseUUIDPipe({ version: '4' });

const listQuery = z.object({ tenantId: z.string().uuid().optional() });

const uploadSchema = z.object({
  tenantId: z.string().uuid(),
  filename: z.string().trim().min(1).max(100),
  sizeBytes: z.number().int().min(1).max(PACKAGE_MAX_BYTES),
});

const chunkQuery = z.object({ offset: z.coerce.number().int().min(0) });

/**
 * Installer packages for Autoconfig (Phase 5C): a tenant's MSIs and EXEs.
 *
 * The decorators say only that the caller holds the permission somewhere; the
 * service checks it at the package's tenant.
 */
@ApiTags('autoconfig')
@Controller('autoconfig/packages')
export class PackagesController {
  constructor(private readonly packages: PackagesService) {}

  @RequirePermissionSomewhere(PERMISSIONS.autoconfigRead)
  @Get()
  @ApiOperation({
    summary: 'The installer packages of the tenants you may read, or of one',
    description: 'Never another tenant’s: a tenant’s packages are its own.',
  })
  list(@Query(zodQuery(listQuery)) query: z.infer<typeof listQuery>, @Req() request: Request) {
    return this.packages.list(actorOf(request), query.tenantId);
  }

  @RequirePermissionSomewhere(PERMISSIONS.autoconfigManage)
  @Post('uploads')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Start uploading an MSI or EXE for a tenant',
    description:
      'Chunks go to PUT /autoconfig/packages/uploads/{id}/chunks?offset=N as ' +
      'application/octet-stream, as for the library. The last one starts a check job.',
  })
  startUpload(
    @Body(zodBody(uploadSchema)) body: z.infer<typeof uploadSchema>,
    @Req() request: Request,
  ) {
    return this.packages.startUpload(body, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.autoconfigManage)
  @Get('uploads/:id')
  @ApiOperation({ summary: 'Where a package upload is up to, for resuming it' })
  uploadStatus(@Param('id', uuidParam) id: string, @Req() request: Request) {
    return this.packages.uploadStatus(id, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.autoconfigManage)
  @Put('uploads/:id/chunks')
  @ApiOperation({ summary: 'Send one chunk of a package upload' })
  async writeChunk(
    @Param('id', uuidParam) id: string,
    @Query(zodQuery(chunkQuery)) query: z.infer<typeof chunkQuery>,
    @Req() request: Request,
  ) {
    try {
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
      return await this.packages.writeChunk(id, query.offset, length, request, actorOf(request));
    } catch (error) {
      await discardBody(request);
      throw error;
    }
  }

  @RequirePermissionSomewhere(PERMISSIONS.autoconfigRead)
  @Get(':id')
  @ApiOperation({ summary: 'One installer package' })
  get(@Param('id', uuidParam) id: string, @Req() request: Request) {
    return this.packages.get(id, actorOf(request));
  }

  @RequirePermissionSomewhere(PERMISSIONS.autoconfigManage)
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a package, or abandon its upload',
    description: 'Refused while a template of its tenant runs it.',
  })
  async remove(@Param('id', uuidParam) id: string, @Req() request: Request) {
    await this.packages.remove(id, actorOf(request));
  }
}
