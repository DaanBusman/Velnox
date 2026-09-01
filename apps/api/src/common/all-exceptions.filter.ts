import { Catch, HttpException, HttpStatus, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import type { Logger } from 'pino';
import { ERROR_CODES, isVelnoxError, rootRedactor, type ApiErrorBody } from '@velnox/shared';
import { currentRequestId } from './request-context';

/**
 * Converts every thrown value into the single documented error shape.
 *
 * Two rules this enforces:
 *   - the body always carries a machine-readable `code` that the frontend
 *     renders from the active locale (docs/i18n.md);
 *   - internal failures never leak their message to the client. A 500 says
 *     "generic" and carries the request id; the detail goes to the log, where
 *     it is redacted first.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly logger: Logger,
    private readonly exposeDetail: boolean,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const requestId = currentRequestId();

    const { status, body } = this.describe(exception, requestId);

    if (status >= 500) {
      this.logger.error(
        { requestId, err: rootRedactor.value(exception) },
        'Unhandled exception while serving a request',
      );
    }

    if (!response.headersSent) {
      response.status(status).json(body);
    }
  }

  private describe(
    exception: unknown,
    requestId: string | undefined,
  ): { status: number; body: ApiErrorBody } {
    if (isVelnoxError(exception)) {
      return {
        status: exception.status,
        body: {
          error: {
            code: exception.code,
            message: rootRedactor.text(exception.message),
            ...(exception.params ? { params: exception.params } : {}),
            ...(requestId ? { requestId } : {}),
          },
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      // Already in our shape (thrown by the validation pipe).
      if (typeof payload === 'object' && payload !== null && 'error' in payload) {
        const body = payload as ApiErrorBody;
        return {
          status,
          body: { error: { ...body.error, ...(requestId ? { requestId } : {}) } },
        };
      }

      const message =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: string | string[] }).message ?? exception.message);

      return {
        status,
        body: {
          error: {
            code: status === HttpStatus.NOT_FOUND ? ERROR_CODES.notFound : ERROR_CODES.generic,
            message: rootRedactor.text(Array.isArray(message) ? message.join('; ') : message),
            ...(requestId ? { requestId } : {}),
          },
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        error: {
          code: ERROR_CODES.generic,
          message: this.exposeDetail
            ? rootRedactor.text(exception instanceof Error ? exception.message : String(exception))
            : 'Internal server error',
          ...(requestId ? { requestId } : {}),
        },
      },
    };
  }
}
