import { createHash } from 'node:crypto';
import { Client, type SFTPWrapper } from 'ssh2';

/**
 * SSH, for exactly one purpose: reading a file off a Proxmox node.
 *
 * Proxmox's API can put an ISO on a storage and delete one, but has no call to
 * read one back, so copying a file from a cluster into the library needs
 * another way in (ADR-038). This is it, and it is kept as narrow as it can be:
 *
 * - **SFTP only.** No `exec`, no shell, no port forwarding — there is no code
 *   path here that could run a command on a node, so no bug elsewhere can make
 *   one. An operator can go further and give the account an SFTP-only login.
 * - **Host keys are pinned.** The first half of setting SSH up reads each
 *   node's host key without authenticating and shows it; only a key someone
 *   confirmed is ever authenticated to. A different key refuses the connection
 *   before the credential is offered — the same rule as the TLS pin.
 * - **Read only.** The one operation is streaming a file out.
 */

export interface HostKey {
  /** As OpenSSH prints it: `SHA256:` and unpadded base64. */
  fingerprint: string;
  /** `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`, … */
  type: string;
}

export class HostKeyMismatchError extends Error {
  constructor(
    readonly host: string,
    readonly expected: string,
    readonly presented: string,
  ) {
    super(`${host} presented SSH host key ${presented}; ${expected} was confirmed`);
    this.name = 'HostKeyMismatchError';
  }
}

export class SshAuthError extends Error {
  constructor(readonly host: string) {
    super(`${host} refused the SSH key`);
    this.name = 'SshAuthError';
  }
}

export class SshUnreachableError extends Error {
  constructor(
    readonly host: string,
    cause: unknown,
  ) {
    super(`Could not reach ${host} over SSH`, { cause });
    this.name = 'SshUnreachableError';
  }
}

const CONNECT_TIMEOUT_MS = 15_000;

/** OpenSSH's fingerprint format for a raw public key blob. */
export function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/** The key type is the first length-prefixed string in the blob. */
export function keyTypeOf(key: Buffer): string {
  if (key.length < 4) return 'unknown';
  const length = key.readUInt32BE(0);
  if (length <= 0 || length > 64 || key.length < 4 + length) return 'unknown';
  return key.subarray(4, 4 + length).toString('ascii');
}

/**
 * Read a node's host key, and nothing else.
 *
 * The verifier records the key and answers "no", which ends the handshake
 * before user authentication begins — so no username or key is ever offered to
 * a host nobody has confirmed.
 */
export function readHostKey(input: { host: string; port: number }): Promise<HostKey> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let seen: HostKey | null = null;

    const done = (error?: Error): void => {
      client.removeAllListeners();
      client.on('error', () => undefined);
      client.end();
      if (seen) resolve(seen);
      else
        reject(
          error ?? new SshUnreachableError(input.host, new Error('No host key was presented')),
        );
    };

    client.on('error', (error) =>
      done(seen ? undefined : new SshUnreachableError(input.host, error)),
    );
    client.on('close', () => done());
    client.connect({
      host: input.host,
      port: input.port,
      readyTimeout: CONNECT_TIMEOUT_MS,
      // No username beyond ssh2's requirement, and no key: authentication is
      // never reached, because the verifier below says no.
      username: 'velnox-host-key-probe',
      hostVerifier: (key: Buffer) => {
        seen = { fingerprint: fingerprintOf(key), type: keyTypeOf(key) };
        return false;
      },
    });
  });
}

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  passphrase?: string;
  /** The confirmed host key. Anything else is refused before authenticating. */
  fingerprint: string;
}

/**
 * Connect, check the host key, authenticate, open SFTP, run `use`, disconnect.
 *
 * The connection lives exactly as long as `use` does. Aborting the signal
 * closes it, which ends any transfer in progress.
 */
export function withSftp<T>(
  target: SshTarget,
  signal: AbortSignal | undefined,
  use: (sftp: SFTPWrapper) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let mismatch: HostKeyMismatchError | null = null;

    const finish = (error: unknown, value?: T): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      client.end();
      if (error) reject(error);
      else resolve(value as T);
    };
    const abort = (): void => finish(new Error('Cancelled'));
    signal?.addEventListener('abort', abort, { once: true });

    client.on('ready', () => {
      client.sftp((error, sftp) => {
        if (error) {
          finish(error);
          return;
        }
        use(sftp).then(
          (value) => finish(null, value),
          (useError: unknown) => finish(useError),
        );
      });
    });

    client.on('error', (error: Error & { level?: string }) => {
      if (mismatch) finish(mismatch);
      else if (error.level === 'client-authentication') finish(new SshAuthError(target.host));
      else finish(new SshUnreachableError(target.host, error));
    });
    client.on('close', () =>
      finish(mismatch ?? new SshUnreachableError(target.host, new Error('Connection closed'))),
    );

    client.connect({
      host: target.host,
      port: target.port,
      username: target.username,
      privateKey: target.privateKey,
      ...(target.passphrase ? { passphrase: target.passphrase } : {}),
      readyTimeout: CONNECT_TIMEOUT_MS,
      // Key only. A password prompt answered by nobody is a hang, and keyboard
      // interactive is not a thing Velnox should ever be doing.
      tryKeyboard: false,
      hostVerifier: (key: Buffer) => {
        const presented = fingerprintOf(key);
        if (presented === target.fingerprint) return true;
        mismatch = new HostKeyMismatchError(target.host, target.fingerprint, presented);
        return false;
      },
    });
  });
}
