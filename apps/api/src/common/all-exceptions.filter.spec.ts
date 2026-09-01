import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { Logger } from 'pino';
import { ERROR_CODES, REDACTED, rootRedactor, VelnoxError, type ApiErrorBody } from '@velnox/shared';
import { AllExceptionsFilter } from './all-exceptions.filter';

function harness() {
  const json = vi.fn();
  // Typed with its parameter so `status.mock.calls[0][0]` narrows to number
  // rather than needing a cast that TypeScript rightly rejects.
  const status = vi.fn((_code: number) => ({ json }));
  const response = { status, json, headersSent: false };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as Logger;

  const capture = (): { status: number; body: ApiErrorBody } => ({
    status: status.mock.calls[0]![0],
    body: json.mock.calls[0]![0] as ApiErrorBody,
  });

  return { host, logger, capture };
}

describe('AllExceptionsFilter', () => {
  it('renders a VelnoxError as its code, status and parameters', () => {
    const { host, logger, capture } = harness();
    new AllExceptionsFilter(logger, false).catch(
      new VelnoxError(ERROR_CODES.clusterQuorumAtRisk, {
        status: 409,
        message: 'would lose quorum',
        params: { cluster: 'prod-a', available: 2, required: 3 },
      }),
      host,
    );

    const { status, body } = capture();
    expect(status).toBe(409);
    expect(body.error.code).toBe('cluster.quorum_at_risk');
    expect(body.error.params).toEqual({ cluster: 'prod-a', available: 2, required: 3 });
  });

  it('preserves the validation body produced by the zod pipe', () => {
    const { host, logger, capture } = harness();
    const validation: ApiErrorBody = {
      error: {
        code: ERROR_CODES.validation,
        message: 'Request validation failed',
        details: [{ path: 'email', code: 'invalid_string', message: 'Invalid email' }],
      },
    };

    new AllExceptionsFilter(logger, false).catch(new BadRequestException(validation), host);

    const { status, body } = capture();
    expect(status).toBe(400);
    expect(body.error.code).toBe(ERROR_CODES.validation);
    expect(body.error.details).toHaveLength(1);
  });

  it('maps a 404 to the not_found code', () => {
    const { host, logger, capture } = harness();
    new AllExceptionsFilter(logger, false).catch(new NotFoundException(), host);

    expect(capture().status).toBe(HttpStatus.NOT_FOUND);
    expect(capture().body.error.code).toBe(ERROR_CODES.notFound);
  });

  it('does not leak internal detail on an unexpected failure in production', () => {
    const { host, logger, capture } = harness();
    new AllExceptionsFilter(logger, false).catch(
      new Error('connect ECONNREFUSED 10.0.0.5:5432 as user velnox'),
      host,
    );

    const { status, body } = capture();
    expect(status).toBe(500);
    expect(body.error.code).toBe(ERROR_CODES.generic);
    expect(body.error.message).toBe('Internal server error');
    expect(body.error.message).not.toContain('10.0.0.5');
  });

  it('exposes detail outside production, where it is a debugging aid', () => {
    const { host, logger, capture } = harness();
    new AllExceptionsFilter(logger, true).catch(new Error('something specific'), host);
    expect(capture().body.error.message).toBe('something specific');
  });

  it('redacts secrets that reached an error message', () => {
    const secret = 'rotation-password-abc123';
    rootRedactor.remember(secret);
    try {
      const { host, logger, capture } = harness();
      new AllExceptionsFilter(logger, true).catch(
        new HttpException(`auth failed using ${secret}`, 401),
        host,
      );

      const body = capture().body;
      expect(body.error.message).not.toContain(secret);
      expect(body.error.message).toContain(REDACTED);
    } finally {
      rootRedactor.forget(secret);
    }
  });

  it('logs server errors but not client errors', () => {
    const a = harness();
    new AllExceptionsFilter(a.logger, false).catch(new Error('boom'), a.host);
    expect(a.logger.error).toHaveBeenCalledTimes(1);

    const b = harness();
    new AllExceptionsFilter(b.logger, false).catch(new NotFoundException(), b.host);
    expect(b.logger.error).not.toHaveBeenCalled();
  });
});
