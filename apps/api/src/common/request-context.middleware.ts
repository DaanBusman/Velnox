import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import { rootRedactor } from '@velnox/shared';
import { newTenancyHolder, runWithTenancy } from '@velnox/db';
import { newRequestId, runWithRequestContext } from './request-context';

const REQUEST_ID_HEADER = 'x-velnox-request-id';

/**
 * Establishes the per-request context and emits one access log line per request.
 *
 * It also opens the tenancy scope for the request. The scope is not *known* here
 * — authentication has not happened yet — so what is installed is an empty
 * holder that the auth guard fills in. Until it does, every query against a
 * tenant-scoped model throws, which is the behaviour that makes a forgotten
 * authorization check leak nothing (docs/architecture.md section 4).
 *
 * The request id is generated here rather than accepted from the client: a
 * client-supplied correlation id is untrusted input that ends up in every log
 * line, so it is echoed back in the response header but never used as the id.
 */
export class RequestContextMiddleware {
  constructor(private readonly logger: Logger) {}

  /** Bound and installed with `app.use()` in main.ts, ahead of every route. */
  readonly handle = (req: Request, res: Response, next: NextFunction): void => {
    const context = {
      requestId: newRequestId(),
      ip: req.ip ?? req.socket.remoteAddress ?? 'unknown',
      userAgent: req.get('user-agent') ?? '',
      method: req.method,
      path: req.originalUrl.split('?')[0] ?? req.originalUrl,
      startedAt: Date.now(),
    };

    res.setHeader(REQUEST_ID_HEADER, context.requestId);

    const tenancy = newTenancyHolder();

    runWithRequestContext(context, () =>
      runWithTenancy(tenancy, () => {
        res.on('finish', () => {
          const durationMs = Date.now() - context.startedAt;
          const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

          // Health probes fire every few seconds on every service; logging them at
          // info level buries everything else.
          const isProbe = context.path === '/healthz' || context.path === '/readyz';
          if (isProbe && res.statusCode < 400) return;

          this.logger[level](
            {
              requestId: context.requestId,
              method: context.method,
              path: rootRedactor.text(context.path),
              status: res.statusCode,
              durationMs,
              ip: context.ip,
            },
            `${context.method} ${context.path} ${res.statusCode} ${durationMs}ms`,
          );
        });

        next();
      }),
    );
  };
}
