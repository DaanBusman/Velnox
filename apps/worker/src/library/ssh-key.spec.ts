import { describe, expect, it } from 'vitest';
import { utils } from 'ssh2';
import { generateOpenSshEd25519, openSshEd25519 } from '@velnox/shared';
import { publicKeyLine } from './ssh-setup';

/**
 * The key pair the SSH form makes in the browser, read by the library that
 * will use it. The format is written by hand, so "it looks like a key" proves
 * nothing: ssh2 must parse it, its public half must be the line the form
 * shows, and it must sign something its public half verifies.
 */

const parse = (privateKey: string) => {
  const parsed = utils.parseKey(privateKey);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key instanceof Error) throw key ?? new Error('no key');
  return key;
};

describe('an Ed25519 key pair in OpenSSH form', () => {
  it('is read by ssh2 as the key whose public line the form shows', async () => {
    const pair = await generateOpenSshEd25519('velnox@pve-cluster');
    const key = parse(pair.privateKey);
    expect(key.type).toBe('ssh-ed25519');
    expect(pair.publicKey).toBe(
      `ssh-ed25519 ${key.getPublicSSH().toString('base64')} velnox@pve-cluster`,
    );
    expect(key.getPrivatePEM()).toBeTruthy();
  });

  it('signs, and its public line verifies the signature', async () => {
    const pair = await generateOpenSshEd25519('velnox');
    const data = Buffer.from('proof');
    const signature = parse(pair.privateKey).sign(data);
    const publicKey = parse(pair.publicKey);
    expect(publicKey.verify(data, signature as Buffer)).toBe(true);
    expect(publicKey.verify(Buffer.from('other'), signature as Buffer)).toBe(false);
  });

  it('is what the worker reads back as its public half, without the comment', async () => {
    const pair = await generateOpenSshEd25519('velnox@somewhere');
    expect(publicKeyLine(pair.privateKey)).toBe(pair.publicKey.replace(/ velnox@somewhere$/, ''));
  });

  it('is laid out as OpenSSH lays it out', () => {
    const pair = openSshEd25519(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), 'c', 7);
    const lines = pair.privateKey.trimEnd().split('\n');
    expect(lines[0]).toBe('-----BEGIN OPENSSH PRIVATE KEY-----');
    expect(lines.at(-1)).toBe('-----END OPENSSH PRIVATE KEY-----');
    expect(lines.slice(1, -2).every((l) => l.length === 70)).toBe(true);
    expect(Buffer.from(lines.slice(1, -1).join(''), 'base64').subarray(0, 15).toString()).toBe(
      'openssh-key-v1\0',
    );
    expect(() => openSshEd25519(new Uint8Array(31), new Uint8Array(32), '')).toThrow();
  });
});

describe('the public half of a stored key', () => {
  it('is read from an RSA key too', () => {
    const pair = utils.generateKeyPairSync('rsa', { bits: 2048 });
    expect(publicKeyLine(pair.private)).toBe(pair.public.split(' ').slice(0, 2).join(' '));
  });

  it('is null for something that is not a key', () => {
    expect(publicKeyLine('not a key')).toBeNull();
  });
});
