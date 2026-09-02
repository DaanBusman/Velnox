import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { PASSWORD_MIN_LENGTH } from '@velnox/crypto';
import { zodBody } from '../../common/zod-validation.pipe';
import { Public } from '../../common/auth.guard';
import { SetupService } from './setup.service';

const initializeSchema = z.object({
  organisationName: z.string().trim().min(2).max(120),
  displayName: z.string().trim().min(2).max(120),
  email: z.string().email().max(320),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(256),
});

@ApiTags('setup')
@Controller('setup')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Public()
  @Get('status')
  @ApiOperation({
    summary: 'Whether this installation has been set up',
    description: 'Open at all times, so the frontend can decide whether to show the wizard.',
  })
  status() {
    return this.setup.status();
  }

  @Public()
  @Post('initialize')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create the MSP root tenant and the first administrator',
    description:
      'The only mutating endpoint reachable before setup. Creates the tenant, the system roles ' +
      'and the first Super Administrator in one transaction, then closes permanently: every ' +
      'later call returns 409. There is no default account and no default password at any point.',
  })
  async initialize(@Body(zodBody(initializeSchema)) body: z.infer<typeof initializeSchema>) {
    await this.setup.assertNotInitialized();
    const result = await this.setup.initialize(body);
    return { status: 'initialized', ...result };
  }
}
