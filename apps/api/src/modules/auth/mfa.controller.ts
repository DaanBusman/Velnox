import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { ERROR_CODES, VelnoxError } from '@velnox/shared';
import { zodBody } from '../../common/zod-validation.pipe';
import { AllowsUnsatisfiedMfa } from '../../common/auth.guard';
import { MfaService } from './mfa.service';

/**
 * Multi-factor authentication endpoints.
 *
 * Enrolment and the challenge carry `@AllowsUnsatisfiedMfa` because they are the
 * only way out of a session that owes a second factor — a session that cannot
 * reach them would be a locked door with the key on the wrong side.
 *
 * Everything that is not part of getting through the door does *not* carry it:
 * regenerating recovery codes and disabling the factor need a fully satisfied
 * session, so a half-authenticated session cannot weaken the account it is
 * halfway into.
 */

const codeSchema = z.object({
  // Digits only, with spaces and dashes tolerated because people copy codes
  // from a screen that groups them.
  code: z
    .string()
    .min(6)
    .max(16)
    .regex(/^[\d\s-]+$/, 'must be digits'),
});

const recoverySchema = z.object({
  code: z.string().min(8).max(32),
});

@ApiTags('auth')
@Controller('auth/mfa')
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  @AllowsUnsatisfiedMfa()
  @Get()
  @ApiOperation({ summary: 'Whether this account has a second factor, and how many codes are left' })
  async status(@Req() request: Request) {
    return this.mfa.status(principalOf(request).user.id);
  }

  @AllowsUnsatisfiedMfa()
  @Post('enrol')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Begin enrolment',
    description:
      'Returns a secret and an otpauth:// URI. The factor is not usable until confirmed with a ' +
      'working code, so an abandoned enrolment cannot lock the account out. The secret is ' +
      'returned only here and appears in no log or audit record.',
  })
  async enrol(@Req() request: Request) {
    return this.mfa.beginEnrolment(principalOf(request).user);
  }

  @AllowsUnsatisfiedMfa()
  @Post('enrol/confirm')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Confirm enrolment with a code from the authenticator',
    description: 'Returns the recovery codes. They are shown once and cannot be retrieved again.',
  })
  async confirm(
    @Body(zodBody(codeSchema)) body: z.infer<typeof codeSchema>,
    @Req() request: Request,
  ) {
    return this.mfa.confirmEnrolment(principalOf(request).user, body.code);
  }

  @AllowsUnsatisfiedMfa()
  @Post('challenge')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Answer the second-factor challenge for this session',
    description: 'On success the session becomes fully authenticated and the rest of the API opens.',
  })
  async challenge(
    @Body(zodBody(codeSchema)) body: z.infer<typeof codeSchema>,
    @Req() request: Request,
  ) {
    await this.mfa.completeChallenge(
      principalOf(request).user,
      sessionOf(request),
      body.code,
      request.ip ?? 'unknown',
    );
    return { status: 'authenticated' };
  }

  @AllowsUnsatisfiedMfa()
  @Post('challenge/recovery')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Answer the challenge with a recovery code',
    description: 'Each code works exactly once. The response says how many remain.',
  })
  async recovery(
    @Body(zodBody(recoverySchema)) body: z.infer<typeof recoverySchema>,
    @Req() request: Request,
  ) {
    const { remaining } = await this.mfa.useRecoveryCode(
      principalOf(request).user,
      sessionOf(request),
      body.code,
      request.ip ?? 'unknown',
    );
    return { status: 'authenticated', recoveryCodesRemaining: remaining };
  }

  // No @AllowsUnsatisfiedMfa below this line, on purpose.

  @Post('recovery-codes')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Issue a new set of recovery codes',
    description: 'Whatever is left of the previous set stops working immediately.',
  })
  async regenerate(@Req() request: Request) {
    const codes = await this.mfa.regenerateRecoveryCodes(principalOf(request).user);
    return { recoveryCodes: codes };
  }

  @Post('disable')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove the second factor',
    description: 'Requires a currently valid code, so an unattended session cannot strip it.',
  })
  async disable(
    @Body(zodBody(codeSchema)) body: z.infer<typeof codeSchema>,
    @Req() request: Request,
  ) {
    await this.mfa.disable(principalOf(request).user, body.code, request.ip ?? 'unknown');
  }
}

/**
 * The guard has already authenticated the request, so a missing principal here
 * is a wiring mistake rather than an unauthenticated caller. Throwing the
 * session error is still the right response — it is never correct to continue.
 */
function principalOf(request: Request) {
  const principal = request.velnoxPrincipal;
  if (!principal) throw new VelnoxError(ERROR_CODES.authSessionExpired, { status: 401 });
  return principal;
}

function sessionOf(request: Request): string {
  const sessionId = request.velnoxSessionId;
  if (!sessionId) throw new VelnoxError(ERROR_CODES.authSessionExpired, { status: 401 });
  return sessionId;
}
