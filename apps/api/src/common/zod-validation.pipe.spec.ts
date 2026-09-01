import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ERROR_CODES, type ApiErrorBody } from '@velnox/shared';
import { ZodValidationPipe } from './zod-validation.pipe';

const schema = z.object({
  email: z.string().email(),
  count: z.coerce.number().int().min(1),
});

describe('ZodValidationPipe', () => {
  it('returns the parsed and coerced value', () => {
    const pipe = new ZodValidationPipe(schema);
    expect(pipe.transform({ email: 'ops@example.com', count: '3' })).toEqual({
      email: 'ops@example.com',
      count: 3,
    });
  });

  it('rejects invalid input with the standard error shape', () => {
    const pipe = new ZodValidationPipe(schema);

    try {
      pipe.transform({ email: 'not-an-email', count: 0 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const body = (error as BadRequestException).getResponse() as ApiErrorBody;
      expect(body.error.code).toBe(ERROR_CODES.validation);
      expect(body.error.details?.map((d) => d.path).sort()).toEqual(['count', 'email']);
    }
  });

  it('reports every problem at once, so a form can show them all', () => {
    const pipe = new ZodValidationPipe(schema);
    try {
      pipe.transform({});
      expect.unreachable('should have thrown');
    } catch (error) {
      const body = (error as BadRequestException).getResponse() as ApiErrorBody;
      expect(body.error.details).toHaveLength(2);
    }
  });

  it('strips nothing the schema did not ask for, because the schema decides', () => {
    const strict = z.object({ a: z.string() }).strict();
    const pipe = new ZodValidationPipe(strict);
    expect(() => pipe.transform({ a: 'x', unexpected: true })).toThrow(BadRequestException);
  });
});
