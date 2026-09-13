import { decodeMasterKey, decryptSecret } from '@velnox/crypto';
import type { VelnoxPrismaClient } from '@velnox/db';
import type { ProxmoxAuth } from '@velnox/proxmox';

/**
 * Reading an infrastructure credential — the thing only the worker may do.
 *
 * ADR-009 draws the line here: the API may encrypt a Proxmox token on its way
 * in, and cannot decrypt one on the way out. `SecretStoreService.get` in the API
 * refuses every infrastructure kind and has no flag to turn that off; this is
 * the other side of the same rule, and it lives in the service with no listening
 * port.
 *
 * Nothing that comes out of here is logged, returned in a job result, or written
 * to a database column. The `ProxmoxAuth` it produces goes straight into a
 * client and is dropped with it.
 */

export class CredentialUnavailableError extends Error {
  constructor(readonly credentialId: string) {
    super(`No usable secret for credential ${credentialId}`);
    this.name = 'CredentialUnavailableError';
  }
}

export class CredentialReader {
  private readonly masterKey: Buffer;

  constructor(
    private readonly prisma: VelnoxPrismaClient,
    masterKeyBase64: string,
  ) {
    this.masterKey = decodeMasterKey(masterKeyBase64);
  }

  /**
   * Build the authentication a Proxmox client needs.
   *
   * `principal` is `user@realm!tokenid` for a token, `user@realm` for a
   * password. It is stored in the clear because it is not secret and because an
   * operator needs to see which token to revoke on the Proxmox side.
   */
  async proxmoxAuth(input: {
    credentialId: string;
    kind: 'API_TOKEN' | 'TICKET';
    principal: string | null;
  }): Promise<ProxmoxAuth> {
    const secret = await this.read(input.credentialId);

    if (input.kind === 'API_TOKEN') {
      if (!input.principal) throw new CredentialUnavailableError(input.credentialId);
      return { kind: 'token', tokenId: input.principal, secret };
    }

    const [username, realm] = (input.principal ?? '').split('@');
    if (!username || !realm) throw new CredentialUnavailableError(input.credentialId);

    return { kind: 'ticket', username, realm, password: secret };
  }

  private async read(credentialId: string): Promise<string> {
    const record = await this.prisma.credentialSecret.findFirst({
      where: { credentialId, status: 'ACTIVE' },
      orderBy: [{ version: 'desc' }],
    });

    if (!record) throw new CredentialUnavailableError(credentialId);

    const material = decryptSecret(
      this.masterKey,
      {
        ciphertext: Buffer.from(record.ciphertext),
        iv: Buffer.from(record.iv),
        authTag: Buffer.from(record.authTag),
        wrappedDek: Buffer.from(record.wrappedDek),
        dekIv: Buffer.from(record.dekIv),
        dekAuthTag: Buffer.from(record.dekAuthTag),
        keyVersion: record.keyVersion,
        algorithm: record.algorithm,
      },
      // Bound to the credential row it belongs to, so stored bytes cannot be
      // moved to another credential and still decrypt.
      { aad: record.aad ?? undefined },
    );

    return material.toString('utf8');
  }
}
