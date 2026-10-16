/**
 * An SSH key pair made where the operator is: in the browser, with WebCrypto.
 *
 * Setting SSH up used to start with "paste a private key whose public half is
 * in authorized_keys" — which assumes the operator already has one, and never
 * says where the public half is. So the form can make an Ed25519 pair itself
 * and show the public line to put on the nodes. The private key goes the same
 * way a pasted one does: once, to the API, which stores it encrypted and never
 * shows it again.
 *
 * Written out in OpenSSH's own formats — `ssh-ed25519 AAAA… comment` for
 * authorized_keys, and the unencrypted `openssh-key-v1` container for the
 * private key — by hand, because neither format is something WebCrypto
 * exports. Pure: no Buffer, no Node, so the browser and the tests run the same
 * code. The worker's spec proves ssh2 reads the result and that it signs.
 */

const KEY_TYPE = 'ssh-ed25519';

export interface OpenSshKeyPair {
  /** `-----BEGIN OPENSSH PRIVATE KEY-----` …, unencrypted. */
  privateKey: string;
  /** One line for authorized_keys: `ssh-ed25519 AAAA… comment`. */
  publicKey: string;
}

const encoder = new TextEncoder();

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

/** SSH's `string`: a big-endian length, then the bytes. */
function sshString(bytes: Uint8Array | string): Uint8Array {
  const data = typeof bytes === 'string' ? encoder.encode(bytes) : bytes;
  return concat(u32(data.length), data);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * An Ed25519 key, from its 32-byte seed and 32-byte public key, in OpenSSH's
 * formats. `checkInt` is the private section's repeated random number, which
 * only tells a wrong passphrase from a right one; it is a parameter so a test
 * can pin it.
 */
export function openSshEd25519(
  seed: Uint8Array,
  publicKey: Uint8Array,
  comment: string,
  checkInt: number = crypto.getRandomValues(new Uint32Array(1))[0]!,
): OpenSshKeyPair {
  if (seed.length !== 32 || publicKey.length !== 32) {
    throw new Error('An Ed25519 key is a 32-byte seed and a 32-byte public key');
  }
  const publicBlob = concat(sshString(KEY_TYPE), sshString(publicKey));

  let section = concat(
    u32(checkInt),
    u32(checkInt),
    sshString(KEY_TYPE),
    sshString(publicKey),
    // OpenSSH keeps the seed and the public key together as the private key.
    sshString(concat(seed, publicKey)),
    sshString(comment),
  );
  // Padded 1, 2, 3, … to the cipher's block size — 8 for "none".
  const padding: number[] = [];
  for (let i = 1; (section.length + padding.length) % 8 !== 0; i += 1) padding.push(i);
  section = concat(section, new Uint8Array(padding));

  const container = concat(
    encoder.encode('openssh-key-v1\0'),
    sshString('none'),
    sshString('none'),
    sshString(new Uint8Array(0)),
    u32(1),
    sshString(publicBlob),
    sshString(section),
  );
  const body = base64(container).replace(/(.{70})/g, '$1\n');

  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.replace(/\n$/, '')}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `${KEY_TYPE} ${base64(publicBlob)}${comment ? ` ${comment}` : ''}`,
  };
}

/** Whether this runtime's WebCrypto can make Ed25519 keys (current browsers, Node 22). */
export async function canGenerateEd25519(): Promise<boolean> {
  try {
    await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
}

/** A new Ed25519 pair from WebCrypto, in OpenSSH's formats. */
export async function generateOpenSshEd25519(comment: string): Promise<OpenSshKeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as { privateKey: Parameters<typeof crypto.subtle.exportKey>[1] };
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  if (!jwk.d || !jwk.x) throw new Error('WebCrypto did not export the Ed25519 key');
  return openSshEd25519(fromBase64Url(jwk.d), fromBase64Url(jwk.x), comment);
}
