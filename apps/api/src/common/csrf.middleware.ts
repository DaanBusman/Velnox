import type { NextFunction, Request, Response } from 'express';
import { ERROR_CODES, VelnoxError } from '@velnox/shared';
import { CSRF_COOKIE, CSRF_HEADER } from './auth.guard';

/**
 * Double-submit CSRF protection.
 *
 * The session cookie is SameSite=Lax, which already stops the classic
 * cross-site form post. This is the second layer: a state-changing request must
 * echo the CSRF cookie back in a header, and a cross-origin page cannot read
 * that cookie to do so.
 *
 * Only requests that carry a session cookie are checked. A request with no
 * cookie has nothing to ride on, and login itself has to work before any token
 * exists.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export class CsrfMiddleware {
  readonly handle = (request: Request, response: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(request.method)) return next();

    const cookie = request.cookies?.[CSRF_COOKIE];
    // No session cookie means nothing to protect: login and the setup wizard
    // are reached before one exists.
    if (typeof cookie !== 'string' || cookie.length === 0) return next();

    const header = request.get(CSRF_HEADER);
    if (typeof header === 'string' && header.length > 0 && header === cookie) return next();

    next(
      new VelnoxError(ERROR_CODES.authzForbidden, {
        status: 403,
        message: 'CSRF token missing or does not match',
        params: { reason: 'csrf' },
      }),
    );
  };
}
