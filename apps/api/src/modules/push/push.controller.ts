import { Body, Controller, Get, HttpCode, Post, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { PUSH_ENDPOINT_MAX_LENGTH, isPushAuthSecret, isPushPublicKey } from '@velnox/shared';
import { zodBody } from '../../common/zod-validation.pipe';
import { actorOf } from '../../common/actor';
import { PushService } from './push.service';

const endpoint = z.string().url().max(PUSH_ENDPOINT_MAX_LENGTH);
const endpointSchema = z.object({ endpoint });
const deviceSchema = z.object({
  endpoint,
  keys: z.object({
    p256dh: z.string().refine(isPushPublicKey),
    auth: z.string().refine(isPushAuthSecret),
  }),
  locale: z.enum(['en', 'nl']),
});

/** This account's notification devices. Nobody can act on someone else's. */
@ApiTags('notifications')
@Controller('me/push')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get('key')
  @ApiOperation({ summary: 'The public key a browser subscribes to notifications with' })
  key(@Req() request: Request) {
    return this.push.publicKey(actorOf(request));
  }

  @Post('status')
  @HttpCode(200)
  @ApiOperation({ summary: 'Whether this browser is registered for this account' })
  status(@Req() request: Request, @Body(zodBody(endpointSchema)) body: z.infer<typeof endpointSchema>) {
    return this.push.isRegistered(body.endpoint, actorOf(request));
  }

  @Put('device')
  @ApiOperation({ summary: 'Register this browser for approval notifications' })
  register(@Req() request: Request, @Body(zodBody(deviceSchema)) body: z.infer<typeof deviceSchema>) {
    return this.push.register(
      { endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth, locale: body.locale },
      actorOf(request),
    );
  }

  @Post('device/remove')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stop notifying this browser' })
  remove(@Req() request: Request, @Body(zodBody(endpointSchema)) body: z.infer<typeof endpointSchema>) {
    return this.push.unregister(body.endpoint, actorOf(request));
  }

  @Post('test')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a test notification to this browser, through the worker' })
  test(@Req() request: Request, @Body(zodBody(endpointSchema)) body: z.infer<typeof endpointSchema>) {
    return this.push.test(body.endpoint, actorOf(request));
  }
}
