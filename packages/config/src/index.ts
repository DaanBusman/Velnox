import { z } from 'zod';
import { readFileSync } from 'node:fs';

/**
 * Typed, validated configuration.
 *
 * Configuration is read once at startup and validated with zod. A missing or
 * malformed value stops the process immediately with a message naming the
 * variable — there are no silent defaults for anything security-relevant,
 * because a default secret is worse than no secret.
 */

/** The upstream source URL. Used to decide whether this build claims to be modified. */
export const UPSTREAM_SOURCE_URL = 'https://github.com/DaanBusman/Velnox';

/**
 * Reads `NAME`, falling back to the contents of the file named by `NAME_FILE`.
 * Docker secrets are mounted as files; env vars are visible in `docker inspect`.
 */
export function readEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const filePath = env[`${name}_FILE`];
  if (filePath) {
    try {
      const contents = readFileSync(filePath, 'utf8').trim();
      if (contents) return contents;
    } catch (err) {
      throw new Error(
        `${name}_FILE points at ${filePath}, which could not be read: ${(err as Error).message}`,
      );
    }
  }
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

const booleanish = z
  .string()
  .transform((v) => ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()));

/** 32 bytes, base64. Checked here so a bad key fails at boot, not at first use. */
const base64Key32 = z.string().superRefine((value, ctx) => {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64');
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be valid base64' });
    return;
  }
  if (decoded.length !== 32) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `must decode to exactly 32 bytes, got ${decoded.length}. Generate one with: openssl rand -base64 32`,
    });
  }
});

const baseSchema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('production'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  VELNOX_PRODUCT_NAME: z.string().min(1).default('Velnox'),
  VELNOX_VERSION: z.string().min(1).default('0.0.0-dev'),
  VELNOX_BUILD_COMMIT: z.string().min(1).default('unknown'),
  VELNOX_BUILD_TIME: z.string().optional(),
  VELNOX_SOURCE_URL: z.string().url().default(UPSTREAM_SOURCE_URL),

  VELNOX_DEFAULT_LOCALE: z.enum(['en', 'nl']).default('en'),
  VELNOX_DEFAULT_TIMEZONE: z.string().min(1).default('Europe/Amsterdam'),

  METRICS_ENABLED: booleanish.default('false'),
  VELNOX_DEV_ENDPOINTS: booleanish.default('false'),
});

const redisSchema = z.object({
  REDIS_HOST: z.string().min(1).default('redis'),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
  REDIS_PASSWORD: z.string().min(1),
  REDIS_DB: z.coerce.number().int().min(0).default(0),
});

const databaseSchema = z.object({
  DATABASE_URL: z.string().min(1).startsWith('postgres'),
});

const apiSchema = baseSchema
  .merge(redisSchema)
  .merge(databaseSchema)
  .extend({
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    APP_URL: z.string().url().default('https://localhost'),
    JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
    MASTER_ENCRYPTION_KEY: base64Key32,
  });

const workerSchema = baseSchema
  .merge(redisSchema)
  .merge(databaseSchema)
  .extend({
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
    MASTER_ENCRYPTION_KEY: base64Key32,
  });

export type BaseConfig = z.infer<typeof baseSchema>;
export type ApiConfig = z.infer<typeof apiSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;

/** Every variable that may arrive via a `_FILE` indirection. */
const FILE_BACKED = [
  'DATABASE_URL',
  'REDIS_PASSWORD',
  'JWT_SECRET',
  'MASTER_ENCRYPTION_KEY',
  'MICROSOFT_CLIENT_SECRET',
];

function collect(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const name of FILE_BACKED) {
    const resolved = readEnv(name, env);
    if (resolved !== undefined) out[name] = resolved;
  }
  return out;
}

function parse<T extends z.ZodTypeAny>(schema: T, env: NodeJS.ProcessEnv, role: string): z.infer<T> {
  const result = schema.safeParse(collect(env));
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(
      `Invalid ${role} configuration.\n${lines.join('\n')}\n\n` +
        `See .env.example for what each variable means, or run ./scripts/gen-env.sh to create a .env with generated secrets.`,
    );
  }
  return result.data;
}

export const loadApiConfig = (env: NodeJS.ProcessEnv = process.env): ApiConfig =>
  parse(apiSchema, env, 'API');

export const loadWorkerConfig = (env: NodeJS.ProcessEnv = process.env): WorkerConfig =>
  parse(workerSchema, env, 'worker');

export const loadBaseConfig = (env: NodeJS.ProcessEnv = process.env): BaseConfig =>
  parse(baseSchema, env, 'base');

/**
 * Values that must never appear in a log line. Fed to the redactor at startup so
 * value-based redaction covers configured secrets, not only ones generated at
 * runtime.
 */
export function secretValues(config: Partial<ApiConfig & WorkerConfig>): string[] {
  return [config.REDIS_PASSWORD, config.JWT_SECRET, config.MASTER_ENCRYPTION_KEY].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
}

export const redisConnection = (config: {
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PASSWORD: string;
  REDIS_DB: number;
}) => ({
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  password: config.REDIS_PASSWORD,
  db: config.REDIS_DB,
});
