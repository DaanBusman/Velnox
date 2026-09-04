import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  ERROR_CODES,
  VelnoxError,
  isAllowed,
  type Permission,
  type TargetScope,
} from '@velnox/shared';
import { AuthService, type Principal } from '../modules/auth/auth.service';
import { SessionService } from '../modules/auth/session.service';
import { TokenService } from '../modules/auth/token.service';
import { AuditService, AUDIT_ACTIONS } from '../modules/audit/audit.service';
import { setPrincipal } from './request-context';

/**
 * Authentication and authorisation, applied globally.
 *
 * Global on purpose: a new endpoint is protected by default and has to opt out
 * explicitly with `@Public()`. The alternative — remembering to add a guard —
 * fails silently the one time it is forgotten, and the failure is an open
 * endpoint.
 */

export const IS_PUBLIC = 'velnox:public';
export const REQUIRED_PERMISSION = 'velnox:permission';
export const ALLOWS_UNSATISFIED_MFA = 'velnox:mfa_optional';

/** No authentication at all. Login, setup status, health. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Reachable by a signed-in user who still owes a second factor.
 *
 * Only enrolment, the challenge itself, `me` and logout carry this. Everything
 * else is unreachable until the factor is satisfied.
 */
export const AllowsUnsatisfiedMfa = () => SetMetadata(ALLOWS_UNSATISFIED_MFA, true);

/** Requires a permission, optionally at a scope resolved from the request. */
export const RequirePermission = (
  permission: Permission,
  scope?: (req: Request) => TargetScope,
) => applyDecorators(SetMetadata(REQUIRED_PERMISSION, { permission, scope }));

export const ACCESS_COOKIE = 'velnox_at';
export const REFRESH_COOKIE = 'velnox_rt';
export const CSRF_COOKIE = 'velnox_csrf';
export const CSRF_HEADER = 'x-velnox-csrf';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const principal = await this.authenticate(request);

    // --- second factor ----------------------------------------------------
    const mfaOptional = this.reflector.getAllAndOverride<boolean>(ALLOWS_UNSATISFIED_MFA, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!request.velnoxMfaSatisfied && !mfaOptional) {
      throw new VelnoxError(ERROR_CODES.authMfaRequired, { status: 403 });
    }

    // --- permission -------------------------------------------------------
    const requirement = this.reflector.getAllAndOverride<{
      permission: Permission;
      scope?: (req: Request) => TargetScope;
    }>(REQUIRED_PERMISSION, [context.getHandler(), context.getClass()]);

    if (!requirement) return true;

    const target = requirement.scope ? requirement.scope(request) : {};
    if (!isAllowed(principal.grants, requirement.permission, target)) {
      await this.audit.denied(AUDIT_ACTIONS.permissionDenied, {
        actorType: 'USER',
        actorId: principal.user.id,
        actorLabel: principal.user.email,
        tenantId: principal.user.tenantId,
        resourceType: 'endpoint',
        resourceLabel: `${request.method} ${request.path}`,
        metadata: { permission: requirement.permission, target },
      });
      throw new VelnoxError(ERROR_CODES.authzForbidden, {
        status: 403,
        params: { permission: requirement.permission },
      });
    }

    return true;
  }

  private async authenticate(request: Request): Promise<Principal> {
    const token = readAccessToken(request);
    if (!token) throw new VelnoxError(ERROR_CODES.authSessionExpired, { status: 401 });

    const verified = this.tokens.verifyAccessToken(token);
    if (!verified.ok) {
      throw new VelnoxError(ERROR_CODES.authSessionExpired, {
        status: 401,
        params: { reason: verified.reason },
      });
    }

    const principal = await this.auth.findPrincipalById(verified.claims.sub);
    if (!principal) throw new VelnoxError(ERROR_CODES.authSessionExpired, { status: 401 });

    // A password change, role change or forced sign-out bumps tokenVersion, so
    // every token issued before it stops working without a revocation list.
    if (verified.claims.ver !== principal.user.tokenVersion) {
      throw new VelnoxError(ERROR_CODES.authSessionExpired, {
        status: 401,
        params: { reason: 'token_superseded' },
      });
    }

    // The session must still exist: a signed token from a revoked session is
    // otherwise valid until it expires.
    const session = await this.sessions.findActive(verified.claims.sid);
    if (!session) {
      throw new VelnoxError(ERROR_CODES.authSessionExpired, {
        status: 401,
        params: { reason: 'session_revoked' },
      });
    }

    request.velnoxPrincipal = principal;
    request.velnoxSessionId = session.id;
    // Trust the session row, not the token claim: the token was issued before
    // the factor was satisfied and is not reissued until the next refresh.
    request.velnoxMfaSatisfied = !principal.mfaOwed || session.mfaSatisfiedAt !== null;

    setPrincipal({
      userId: principal.user.id,
      tenantId: principal.user.tenantId,
      sessionId: session.id,
      isMspRoot: principal.isMspRoot,
    });

    return principal;
  }
}

/**
 * The access token comes from the cookie for a browser, or a bearer header for a
 * machine client. The cookie is HttpOnly, so script on the page cannot read it.
 */
function readAccessToken(request: Request): string | null {
  const cookie = request.cookies?.[ACCESS_COOKIE];
  if (typeof cookie === 'string' && cookie.length > 0) return cookie;

  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();

  return null;
}

declare module 'express' {
  interface Request {
    velnoxPrincipal?: Principal;
    velnoxSessionId?: string;
    velnoxMfaSatisfied?: boolean;
  }
}
