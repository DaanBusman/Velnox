import { describe, expect, it } from 'vitest';
import { createRedactor, REDACTED } from './redaction';

describe('redaction', () => {
  describe('by key', () => {
    it('replaces values under secret-looking keys', () => {
      const r = createRedactor();
      const out = r.value({
        username: 'root',
        password: 'hunter2-long-enough',
        apiKey: 'abcdef',
        Authorization: 'Bearer xyz',
        nested: { clientSecret: 'shh', totpSeed: 'JBSWY3DP' },
      });

      expect(out).toEqual({
        username: 'root',
        password: REDACTED,
        apiKey: REDACTED,
        Authorization: REDACTED,
        nested: { clientSecret: REDACTED, totpSeed: REDACTED },
      });
    });

    it('leaves innocent keys alone', () => {
      const r = createRedactor();
      expect(r.value({ hostname: 'pve1', passes: 3, tokenCount: 2 })).toEqual({
        hostname: 'pve1',
        passes: 3,
        tokenCount: 2,
      });
    });
  });

  describe('by value', () => {
    it('masks a remembered secret wherever it appears', () => {
      const r = createRedactor();
      const generated = 'S3cret-Rotation-Value-9x';
      r.remember(generated);

      expect(r.text(`chpasswd wrote ${generated} to root`)).toBe(`chpasswd wrote ${REDACTED} to root`);
      expect(r.value({ note: `old was ${generated}` })).toEqual({ note: `old was ${REDACTED}` });
      expect(r.value([`${generated}!`])).toEqual([`${REDACTED}!`]);
    });

    it('masks a secret inside an Error message and its cause chain', () => {
      const r = createRedactor(['top-level-secret-value']);
      const err = new Error('auth failed for top-level-secret-value', {
        cause: new Error('inner top-level-secret-value'),
      });

      const out = r.value({ err }) as { err: { message: string; cause: { message: string } } };
      expect(out.err.message).toBe(`auth failed for ${REDACTED}`);
      expect(out.err.cause.message).toBe(`inner ${REDACTED}`);
    });

    it('stops masking once a secret is forgotten', () => {
      const r = createRedactor();
      r.remember('superseded-password-1');
      expect(r.text('superseded-password-1')).toBe(REDACTED);
      r.forget('superseded-password-1');
      expect(r.text('superseded-password-1')).toBe('superseded-password-1');
    });

    it('ignores short values, which would mangle unrelated output', () => {
      const r = createRedactor(['abc']);
      expect(r.text('abcdefg contains abc')).toBe('abcdefg contains abc');
    });
  });

  describe('connection URLs', () => {
    it('masks credentials in a URL even when the value was never registered', () => {
      const r = createRedactor();
      expect(r.text('postgresql://velnox:sUp3rS3cret@postgres:5432/velnox')).toBe(
        `postgresql://velnox:${REDACTED}@postgres:5432/velnox`,
      );
      expect(r.text('redis://default:abc123def@redis:6379')).toBe(
        `redis://default:${REDACTED}@redis:6379`,
      );
    });

    it('leaves a URL without credentials intact', () => {
      const r = createRedactor();
      expect(r.text('https://pve1.example.com:8006/api2/json')).toBe(
        'https://pve1.example.com:8006/api2/json',
      );
    });
  });

  describe('robustness', () => {
    it('survives circular references', () => {
      const r = createRedactor();
      const a: Record<string, unknown> = { name: 'a' };
      a.self = a;
      expect(r.value(a)).toEqual({ name: 'a', self: '[circular]' });
    });

    it('does not leak buffer contents', () => {
      const r = createRedactor();
      expect(r.value({ blob: Buffer.from('secret bytes') })).toEqual({ blob: '[buffer 12B]' });
    });

    it('bottoms out on deeply nested structures', () => {
      const r = createRedactor();
      let deep: Record<string, unknown> = { end: true };
      for (let i = 0; i < 30; i++) deep = { deep };
      expect(JSON.stringify(r.value(deep))).toContain('depth-limit');
    });
  });
});
