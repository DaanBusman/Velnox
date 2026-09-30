import { Body, Controller, Get, HttpCode, Post, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { PERMISSIONS } from '@velnox/shared';
import { RequirePermission } from '../../common/auth.guard';
import { zodBody } from '../../common/zod-validation.pipe';
import { actorOf } from '../../common/actor';
import { MailService } from './mail.service';

const hostname = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^\[[0-9A-Fa-f:.]+\]$/,
    'A hostname or address',
  );

const address = z.string().trim().email().max(254);

const settingsSchema = z
  .object({
    host: hostname.nullable().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    security: z.enum(['STARTTLS', 'TLS', 'NONE']).optional(),
    username: z.string().trim().min(1).max(254).nullable().optional(),
    password: z.string().min(1).max(512).nullable().optional(),
    from: address.nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'Nothing to change',
  });

const testSchema = z.object({ to: address });

/** Outgoing mail. Installation-wide, and `system.manage` throughout. */
@ApiTags('system')
@Controller('system/mail')
export class MailController {
  constructor(private readonly mail: MailService) {}

  @RequirePermission(PERMISSIONS.systemManage)
  @Get()
  @ApiOperation({
    summary: 'The outgoing mail settings. Whether a password is set, never the password.',
  })
  get() {
    return this.mail.get();
  }

  @RequirePermission(PERMISSIONS.systemManage)
  @Put()
  @ApiOperation({
    summary: 'Change the outgoing mail settings',
    description:
      'Changing the connection clears the proof that it works and switches mail off; it can be switched on again after a test.',
  })
  update(
    @Body(zodBody(settingsSchema)) body: z.infer<typeof settingsSchema>,
    @Req() request: Request,
  ) {
    return this.mail.update(body, actorOf(request));
  }

  @RequirePermission(PERMISSIONS.systemManage)
  @Post('test')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a test mail with the stored settings, through the worker' })
  test(@Body(zodBody(testSchema)) body: z.infer<typeof testSchema>, @Req() request: Request) {
    return this.mail.test(body.to, actorOf(request));
  }
}
