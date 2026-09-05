import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodSchema } from 'zod';
import { ERROR_CODES, type ApiErrorBody } from '@velnox/shared';

/**
 * Validates and narrows request input against a zod schema.
 *
 * Velnox uses zod for its API contracts (docs/architecture.md section 3), so
 * validation uses the same schemas rather than a second, decorator-based system
 * that could disagree with them. Failures come back in the standard error shape
 * with per-field detail, so the frontend can attach messages to inputs.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        const body: ApiErrorBody = {
          error: {
            code: ERROR_CODES.validation,
            message: 'Request validation failed',
            details: error.issues.map((issue) => ({
              path: issue.path.join('.'),
              code: issue.code,
              message: issue.message,
            })),
          },
        };
        throw new BadRequestException(body);
      }
      throw error;
    }
  }
}

export const zodBody = <T>(schema: ZodSchema<T>): ZodValidationPipe<T> =>
  new ZodValidationPipe(schema);

/**
 * The same pipe, for query strings.
 *
 * A separate name only because reading `zodQuery(schema)` at a call site says
 * where the data came from — query parameters arrive as strings and usually need
 * `z.coerce`, which a reader should be prompted to think about.
 */
export const zodQuery = <T>(schema: ZodSchema<T>): ZodValidationPipe<T> =>
  new ZodValidationPipe(schema);
