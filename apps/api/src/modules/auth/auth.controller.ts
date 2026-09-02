import { randomBytes } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ERROR_CODES, VelnoxError, grantedPermissions } from '@velnox/shared';
import { zodBody } from '../../common/zod-validation.pipe';
import {
  ACCESS_COOKIE,
  AllowsUnsatisfiedMfa,
  CSRF_COOKIE,
  Public,
  REFRESH_COOKIE,
} from '../../common/auth.guard';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { AuthService, type Principal } from './auth.service';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(256),
});

/**
 * Cookie settings.
 *
 * `HttpOnly` keeps the token out of reach of any script on the page, which is
 * what makes an XSS bug a smaller problem than a stolen session. `SameSite=Lax`
 * stops a cross-site form post from carrying it. The refresh cookie is scoped to
 * the auth path so it is not attached to every ordinary request.
 */
const baseCookie = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
};

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sign in with an email address and password',
    description:
      'On success the session is delivered as HttpOnly cookies; no token is returned in the body. ' +
      'A response of mfa_required means the credentials were correct but a second factor is owed.',
  })
  async login(
    @Body(zodBody(loginSchema)) body: z.infer<typeof loginSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const outcome = await this.auth.login(body.email, body.password, {
      ip: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    });

    if (outcome.status === 'rate_limited') {
      response.setHeader('Retry-After', String(outcome.retryAfterSeconds));
      throw new VelnoxError(ERROR_CODES.authRateLimited, {
        status: 429,
        params: { seconds: outcome.retryAfterSeconds },
      });
    }

    if (outcome.status === 'rejected') {
      // One code for every failure, so the response never distinguishes an
      // unknown address from a wrong password.
      throw new VelnoxError(ERROR_CODES.authInvalidCredentials, { status: 401 });
    }

    this.setSessionCookies(response, outcome.accessToken, outcome.refreshToken);

    return {
      status: outcome.status === 'mfa_required' ? 'mfa_required' : 'authenticated',
      user: describePrincipal(outcome.principal),
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Exchange the refresh cookie for a new session',
    description:
      'Rotates the refresh token. Presenting one that has already been rotated revokes the whole ' +
      'session family, because two parties holding the same token cannot be told apart.',
  })
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const presented = request.cookies?.[REFRESH_COOKIE];
    if (typeof presented !== 'string' || !presented) {
      throw new VelnoxError(ERROR_CODES.authSessionExpired, { status: 401 });
    }

    const outcome = await this.sessions.rotate(presented, {
      ip: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    });

    if (outcome.status === 'reused') {
      this.clearSessionCookies(response);
      await this.audit.failure(AUDIT_ACTIONS.tokenReuseDetected, {
        actorType: 'ANONYMOUS',
        metadata: {
          familyId: outcome.revokedFamily,
          sessionsRevoked: outcome.sessionsRevoked,
        },
      });
      throw new VelnoxError(ERROR_CODES.authSessionExpired, {
        status: 401,
        params: { reason: 'reuse_detected' },
      });
    }

    if (outcome.status !== 'rotated') {
      this.clearSessionCookies(response);
      throw new VelnoxError(ERROR_CODES.authSessionExpired, { status: 401 });
    }

    const principal = await this.auth.findPrincipalById(outcome.session.userId);
    this.auth.assertActiveOrThrow(principal);

    const access = this.tokens.issueAccessToken({
      sub: principal.user.id,
      sid: outcome.session.id,
      ver: principal.user.tokenVersion,
      mfa: outcome.session.mfaSatisfiedAt !== null,
    });

    this.setSessionCookies(response, access.token, outcome.refreshToken);
    await this.audit.success(AUDIT_ACTIONS.tokenRefreshed, {
      actorType: 'USER',
      actorId: principal.user.id,
      actorLabel: principal.user.email,
      tenantId: principal.user.tenantId,
    });

    return { status: 'authenticated', user: describePrincipal(principal) };
  }

  @AllowsUnsatisfiedMfa()
  @Get('me')
  @ApiOperation({ summary: 'The signed-in user, their permissions and what they still owe' })
  me(@Req() request: Request) {
    const principal = request.velnoxPrincipal!;
    return {
      user: describePrincipal(principal),
      mfaSatisfied: request.velnoxMfaSatisfied === true,
    };
  }

  @AllowsUnsatisfiedMfa()
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'End this session' })
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const principal = request.velnoxPrincipal;
    if (request.velnoxSessionId) {
      await this.sessions.revoke(request.velnoxSessionId, 'signed_out');
    }
    this.clearSessionCookies(response);

    if (principal) {
      await this.audit.success(AUDIT_ACTIONS.logout, {
        actorType: 'USER',
        actorId: principal.user.id,
        actorLabel: principal.user.email,
        tenantId: principal.user.tenantId,
      });
    }
  }

  private setSessionCookies(response: Response, accessToken: string, refreshToken: string): void {
    response.cookie(ACCESS_COOKIE, accessToken, baseCookie);
    response.cookie(REFRESH_COOKIE, refreshToken, { ...baseCookie, path: '/api/v1/auth' });
    // Readable by script on purpose: the page echoes it back in a header, which
    // a cross-site request cannot do. The cookie alone confers nothing.
    response.cookie(CSRF_COOKIE, randomBytes(32).toString('base64url'), {
      ...baseCookie,
      httpOnly: false,
    });
  }

  private clearSessionCookies(response: Response): void {
    response.clearCookie(ACCESS_COOKIE, baseCookie);
    response.clearCookie(REFRESH_COOKIE, { ...baseCookie, path: '/api/v1/auth' });
    response.clearCookie(CSRF_COOKIE, { ...baseCookie, httpOnly: false });
  }
}

export function describePrincipal(principal: Principal) {
  return {
    id: principal.user.id,
    email: principal.user.email,
    displayName: principal.user.displayName,
    tenantId: principal.user.tenantId,
    isMspRoot: principal.isMspRoot,
    permissions: grantedPermissions(principal.grants),
    mfa: {
      enrolled: principal.user.mfaEnrolled,
      required: principal.mfaRequired,
      policy: principal.mfaPolicy,
    },
  };
}
