import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server, utils, type Connection } from 'ssh2';
import {
  HostKeyMismatchError,
  SshAuthError,
  fingerprintOf,
  keyTypeOf,
  readHostKey,
  withSftp,
} from './ssh';

/*
 * Against a real SSH server, in process. What is proven here is the part that
 * would be expensive to get wrong: that a probe never authenticates, that a
 * wrong host key refuses before the credential is offered, and that the only
 * thing ever opened is SFTP.
 */

const hostKey = utils.generateKeyPairSync('ed25519');
const clientKey = utils.generateKeyPairSync('ed25519');
const otherClientKey = utils.generateKeyPairSync('ed25519');
const allowedPublic = utils.parseKey(clientKey.public);
const FILE = Buffer.from('CD001 pretend iso contents '.repeat(200));

let server: Server;
let port: number;
const seen = { authAttempts: 0, sessionsOpened: 0, subsystems: [] as string[], execs: 0 };

beforeAll(async () => {
  server = new Server({ hostKeys: [hostKey.private] }, (connection: Connection) => {
    connection.on('authentication', (ctx) => {
      seen.authAttempts += 1;
      if (Array.isArray(allowedPublic) || allowedPublic instanceof Error) {
        ctx.reject();
        return;
      }
      if (
        ctx.method === 'publickey' &&
        ctx.key.algo === allowedPublic.type &&
        ctx.key.data.equals(allowedPublic.getPublicSSH())
      ) {
        ctx.accept();
      } else {
        ctx.reject(['publickey']);
      }
    });
    connection.on('ready', () => {
      connection.on('session', (accept) => {
        seen.sessionsOpened += 1;
        const session = accept();
        session.on('exec', () => {
          seen.execs += 1;
        });
        session.on('sftp', (acceptSftp) => {
          seen.subsystems.push('sftp');
          const sftp = acceptSftp();
          const handles = new Map<number, number>();
          sftp.on('OPEN', (reqid, filename) => {
            if (filename !== '/var/lib/vz/template/iso/a.iso') {
              sftp.status(reqid, utils.sftp.STATUS_CODE.NO_SUCH_FILE);
              return;
            }
            handles.set(1, 0);
            sftp.handle(reqid, Buffer.from([1]));
          });
          sftp.on('READ', (reqid, _handle, offset, length) => {
            if (offset >= FILE.length) {
              sftp.status(reqid, utils.sftp.STATUS_CODE.EOF);
              return;
            }
            sftp.data(reqid, FILE.subarray(offset, offset + length));
          });
          sftp.on('FSTAT', (reqid) =>
            sftp.attrs(reqid, {
              mode: 0o100644,
              size: FILE.length,
              uid: 0,
              gid: 0,
              atime: 0,
              mtime: 0,
            }),
          );
          sftp.on('STAT', (reqid) =>
            sftp.attrs(reqid, {
              mode: 0o100644,
              size: FILE.length,
              uid: 0,
              gid: 0,
              atime: 0,
              mtime: 0,
            }),
          );
          sftp.on('CLOSE', (reqid) => sftp.status(reqid, utils.sftp.STATUS_CODE.OK));
        });
      });
    });
    connection.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
});

const serverFingerprint = () => {
  const parsed = utils.parseKey(hostKey.public);
  if (Array.isArray(parsed) || parsed instanceof Error) throw new Error('bad test key');
  return fingerprintOf(parsed.getPublicSSH());
};

const readAll = (target: Parameters<typeof withSftp>[0]) =>
  withSftp(
    target,
    undefined,
    (sftp) =>
      new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        sftp
          .createReadStream('/var/lib/vz/template/iso/a.iso')
          .on('data', (chunk: Buffer) => chunks.push(chunk))
          .on('end', () => resolve(Buffer.concat(chunks)))
          .on('error', reject);
      }),
  );

describe('reading a host key', () => {
  it('returns the fingerprint OpenSSH would print, and never authenticates', async () => {
    const before = seen.authAttempts;
    const key = await readHostKey({ host: '127.0.0.1', port });
    expect(key.fingerprint).toBe(serverFingerprint());
    expect(key.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(key.type).toBe('ssh-ed25519');
    expect(seen.authAttempts).toBe(before);
  });
});

describe('copying a file over SFTP', () => {
  const target = () => ({
    host: '127.0.0.1',
    port,
    username: 'velnox',
    privateKey: clientKey.private,
    fingerprint: serverFingerprint(),
  });

  it('reads the file byte for byte, over SFTP and nothing else', async () => {
    const sessions = seen.sessionsOpened;
    const bytes = await readAll(target());
    expect(bytes.equals(FILE)).toBe(true);
    expect(seen.sessionsOpened).toBe(sessions + 1);
    expect(seen.subsystems.at(-1)).toBe('sftp');
    expect(seen.execs).toBe(0);
  });

  it('refuses a host key it was not told to trust, before offering the credential', async () => {
    const before = seen.authAttempts;
    await expect(
      readAll({ ...target(), fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
    ).rejects.toBeInstanceOf(HostKeyMismatchError);
    expect(seen.authAttempts).toBe(before);
  });

  it('says so when the key is refused', async () => {
    await expect(
      readAll({ ...target(), privateKey: otherClientKey.private }),
    ).rejects.toBeInstanceOf(SshAuthError);
  });
});

describe('key helpers', () => {
  it('reads the type out of a key blob', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    expect(publicKey).toBeTruthy();
    const blob = Buffer.concat([
      Buffer.from([0, 0, 0, 11]),
      Buffer.from('ssh-ed25519'),
      Buffer.alloc(36),
    ]);
    expect(keyTypeOf(blob)).toBe('ssh-ed25519');
    expect(keyTypeOf(Buffer.from([0, 0]))).toBe('unknown');
  });
});
