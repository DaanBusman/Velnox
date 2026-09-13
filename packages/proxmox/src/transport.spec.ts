import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RETRY,
  FingerprintMismatchError,
  ProxmoxHttpError,
  ProxmoxUnreachableError,
  isRetryable,
  withRetries,
} from './transport';
import { parseData } from './client';

/**
 * The retry policy, and what must never be retried.
 *
 * The pinning itself is exercised against a real TLS handshake by
 * `scripts/verify-proxmox.sh`, because a unit test of certificate verification
 * that stubs the socket proves only that the stub was written to agree.
 */

describe('what is worth trying again', () => {
  it('retries a host that did not answer', () => {
    expect(isRetryable(new ProxmoxUnreachableError('pve1', new Error('ETIMEDOUT')))).toBe(true);
  });

  it('retries the status codes a busy cluster returns', () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(isRetryable(new ProxmoxHttpError(status, '', '', '/version'))).toBe(true);
    }
  });

  it('does not retry a refusal', () => {
    // A 403 is an answer. Repeating it three times wastes twelve seconds and
    // tells nobody anything new.
    for (const status of [400, 401, 403, 404, 501]) {
      expect(isRetryable(new ProxmoxHttpError(status, '', '', '/version'))).toBe(false);
    }
  });

  it('never retries a fingerprint mismatch', () => {
    /*
     * The important one. A mismatched fingerprint is not a hiccup — it is "this
     * host is not the one you pinned". Retrying would turn that into three
     * attempts at the same wrong host, and would make a transient-looking log
     * line out of the strongest signal the system has.
     */
    const error = new FingerprintMismatchError('AA:BB', 'CC:DD', 'pve1');
    expect(isRetryable(error)).toBe(false);
  });

  it('does not retry a programming error', () => {
    expect(isRetryable(new TypeError('undefined is not a function'))).toBe(false);
  });
});

describe('withRetries', () => {
  const fast = { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 };

  it('returns the first success without retrying', async () => {
    const operation = vi.fn(async () => 'ok');
    expect(await withRetries(operation, fast)).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable failure and succeeds', async () => {
    let calls = 0;
    const operation = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new ProxmoxUnreachableError('pve1', new Error('reset'));
      return 'ok';
    });

    expect(await withRetries(operation, fast)).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('gives up after the configured number of attempts', async () => {
    const operation = vi.fn(async () => {
      throw new ProxmoxUnreachableError('pve1', new Error('reset'));
    });

    await expect(withRetries(operation, fast)).rejects.toThrow(ProxmoxUnreachableError);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('stops immediately on something not worth retrying', async () => {
    const operation = vi.fn(async () => {
      throw new FingerprintMismatchError('AA:BB', 'CC:DD', 'pve1');
    });

    await expect(withRetries(operation, fast)).rejects.toThrow(FingerprintMismatchError);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('reports each retry, so a job can record why it took three attempts', async () => {
    const seen: number[] = [];
    const operation = vi.fn(async () => {
      throw new ProxmoxUnreachableError('pve1', new Error('reset'));
    });

    await withRetries(operation, fast, (attempt) => seen.push(attempt)).catch(() => undefined);
    expect(seen).toEqual([1, 2]);
  });

  it('ships with a policy that is three attempts', () => {
    // Asserted rather than assumed: a run against fifteen nodes multiplies this,
    // and a default of ten would turn one unreachable node into a discovery run
    // that never ends.
    expect(DEFAULT_RETRY.attempts).toBe(3);
  });
});

describe('the response envelope', () => {
  it('unwraps data', () => {
    expect(parseData<{ version: string }>('{"data":{"version":"8.2.4"}}', '/version')).toEqual({
      version: '8.2.4',
    });
  });

  it('passes a null through, because null is a real answer', () => {
    // `/nodes/x/subscription` on a node that never had one answers `data: null`
    // with a 200. Treating that as an error would mark every unsubscribed node
    // as a failed discovery.
    expect(parseData('{"data":null}', '/subscription')).toBeNull();
  });

  it('refuses HTML, which is what a reverse proxy in the way returns', () => {
    expect(() => parseData('<html><title>502 Bad Gateway</title>', '/version')).toThrow(/not JSON/);
  });

  it('refuses a JSON body with no envelope', () => {
    expect(() => parseData('{"version":"8.2.4"}', '/version')).toThrow(/data envelope/);
  });
});
