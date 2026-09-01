import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { loadApiConfig, loadWorkerConfig, secretValues, UPSTREAM_SOURCE_URL } from './index';

const validEnv = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://velnox:pw@postgres:5432/velnox',
  REDIS_PASSWORD: 'a-redis-password-value',
  JWT_SECRET: 'x'.repeat(32),
  MASTER_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
});

describe('configuration', () => {
  it('accepts a complete environment and applies documented defaults', () => {
    const cfg = loadApiConfig(validEnv());
    expect(cfg.API_PORT).toBe(4000);
    expect(cfg.VELNOX_DEFAULT_LOCALE).toBe('en');
    expect(cfg.VELNOX_SOURCE_URL).toBe(UPSTREAM_SOURCE_URL);
    expect(cfg.METRICS_ENABLED).toBe(false);
    expect(cfg.VELNOX_DEV_ENDPOINTS).toBe(false);
  });

  it('refuses to start without a master encryption key', () => {
    const env = validEnv();
    delete env.MASTER_ENCRYPTION_KEY;
    expect(() => loadApiConfig(env)).toThrow(/MASTER_ENCRYPTION_KEY/);
  });

  it('rejects a master key that is not 32 bytes', () => {
    const env = { ...validEnv(), MASTER_ENCRYPTION_KEY: randomBytes(16).toString('base64') };
    expect(() => loadApiConfig(env)).toThrow(/exactly 32 bytes, got 16/);
  });

  it('rejects a short JWT secret rather than accepting a weak one', () => {
    const env = { ...validEnv(), JWT_SECRET: 'too-short' };
    expect(() => loadApiConfig(env)).toThrow(/at least 32 characters/);
  });

  it('has no default for any secret', () => {
    const env = validEnv();
    delete env.JWT_SECRET;
    delete env.REDIS_PASSWORD;
    expect(() => loadApiConfig(env)).toThrow(/JWT_SECRET[\s\S]*REDIS_PASSWORD|REDIS_PASSWORD/);
  });

  it('parses booleanish flags the way an operator would write them', () => {
    for (const truthy of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(loadApiConfig({ ...validEnv(), METRICS_ENABLED: truthy }).METRICS_ENABLED).toBe(true);
    }
    for (const falsy of ['0', 'false', 'no', 'off', 'anything-else']) {
      expect(loadApiConfig({ ...validEnv(), METRICS_ENABLED: falsy }).METRICS_ENABLED).toBe(false);
    }
  });

  it('loads worker configuration without requiring API-only variables', () => {
    const env = validEnv();
    delete env.JWT_SECRET;
    const cfg = loadWorkerConfig(env);
    expect(cfg.WORKER_CONCURRENCY).toBe(4);
  });

  it('collects configured secrets for the redactor', () => {
    const cfg = loadApiConfig(validEnv());
    const secrets = secretValues(cfg);
    expect(secrets).toContain(cfg.JWT_SECRET);
    expect(secrets).toContain(cfg.REDIS_PASSWORD);
    expect(secrets).toContain(cfg.MASTER_ENCRYPTION_KEY);
  });

  it('names every offending variable at once instead of one per restart', () => {
    const env = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;
    try {
      loadApiConfig(env);
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      for (const name of ['DATABASE_URL', 'REDIS_PASSWORD', 'JWT_SECRET', 'MASTER_ENCRYPTION_KEY']) {
        expect(message).toContain(name);
      }
    }
  });
});
