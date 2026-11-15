import { describe, expect, it } from 'vitest';
import {
  clusterFailureReason,
  unreachableReasonFrom,
  unreachableReasonOf,
  unreachableToken,
} from './reachability';

const withCode = (code: string, message = code) => Object.assign(new Error(message), { code });

describe('the reason a socket error gives', () => {
  it('names the common ones by their code', () => {
    expect(unreachableReasonFrom(withCode('ECONNREFUSED'))).toBe('refused');
    expect(unreachableReasonFrom(withCode('EHOSTUNREACH'))).toBe('no_route');
    expect(unreachableReasonFrom(withCode('ENETUNREACH'))).toBe('no_route');
    expect(unreachableReasonFrom(withCode('ENOTFOUND'))).toBe('dns');
    expect(unreachableReasonFrom(withCode('EAI_AGAIN'))).toBe('dns');
    expect(unreachableReasonFrom(withCode('ECONNRESET'))).toBe('reset');
    expect(unreachableReasonFrom(withCode('ETIMEDOUT'))).toBe('connect_timeout');
  });

  it('recognises a TLS failure by its code family', () => {
    expect(unreachableReasonFrom(withCode('ERR_SSL_WRONG_VERSION_NUMBER'))).toBe('tls');
    expect(unreachableReasonFrom(withCode('ERR_TLS_CERT_ALTNAME_INVALID'))).toBe('tls');
  });

  it('falls back to the message when there is no code', () => {
    expect(unreachableReasonFrom(new Error('socket hang up'))).toBe('reset');
    expect(unreachableReasonFrom(new Error('Client network socket disconnected before secure TLS connection was established'))).toBe('tls');
  });

  it('says other rather than guessing', () => {
    expect(unreachableReasonFrom(new Error('something odd'))).toBe('other');
    expect(unreachableReasonFrom(undefined)).toBe('other');
  });
});

describe('reading the reason back out of a stored message', () => {
  it('finds the token the transport writes', () => {
    const detail = `Could not reach 192.168.15.101:8006 ${unreachableToken('no_answer')}: no answer within 20 s`;
    expect(unreachableReasonOf(detail)).toBe('no_answer');
  });

  it('finds it inside a discovery summary', () => {
    expect(
      unreachableReasonOf(
        'Learned nothing about PVE-1: version: Could not reach 10.0.0.2:8006 [refused]: connect ECONNREFUSED',
      ),
    ).toBe('refused');
  });

  it('is null for a message from before the token existed', () => {
    expect(unreachableReasonOf('Could not reach 192.168.15.101')).toBeNull();
    expect(unreachableReasonOf(null)).toBeNull();
  });

  it('ignores a token that is not a known reason', () => {
    expect(unreachableReasonOf('Could not reach h:1 [made_up]: x')).toBeNull();
  });
});

describe('why a cluster failed, as one word', () => {
  it('names the answers by their code', () => {
    expect(clusterFailureReason('node.fingerprint_mismatch', 'whatever')).toBe('fingerprint');
    expect(clusterFailureReason('cluster.auth_failed', null)).toBe('auth');
    expect(clusterFailureReason('cluster.not_proxmox', null)).toBe('not_proxmox');
  });

  it('reads the silences from the detail', () => {
    expect(clusterFailureReason('cluster.unreachable', 'Could not reach h:8006 [connect_timeout]: x')).toBe(
      'connect_timeout',
    );
  });

  it('is other when nothing says more', () => {
    expect(clusterFailureReason('cluster.unreachable', 'Could not reach h')).toBe('other');
    expect(clusterFailureReason(null, null)).toBe('other');
  });
});
