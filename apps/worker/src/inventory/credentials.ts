import { decodeMasterKey, decryptSecret, encryptSecret } from '@velnox/crypto';
import type { CredentialKind, VelnoxPrismaClient } from '@velnox/db';
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

/** What a provisioned VM's credential holds. */
export interface GuestCredentials {
  accounts: { name: string; password: string | null; administrator: boolean }[];
  /** Windows only, and only when the template had one. */
  productKey?: string | null;
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

  /**
   * An SSH private key, and its passphrase if it has one (Phase 5A).
   *
   * Stored as one secret — a small JSON object — so the two can never be
   * rotated apart: a new key with the old key's passphrase is a key that does
   * not open.
   */
  async sshKey(credentialId: string): Promise<{ privateKey: string; passphrase?: string }> {
    const raw = await this.read(credentialId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CredentialUnavailableError(credentialId);
    }
    const record = parsed as { privateKey?: unknown; passphrase?: unknown };
    if (typeof record.privateKey !== 'string' || record.privateKey.length === 0) {
      throw new CredentialUnavailableError(credentialId);
    }
    return {
      privateKey: record.privateKey,
      ...(typeof record.passphrase === 'string' && record.passphrase
        ? { passphrase: record.passphrase }
        : {}),
    };
  }

  // --- Phase 5B -----------------------------------------------------------

  /** One of a template's stored secrets: a fixed password, a product key, a PDF password. */
  templateSecret(credentialId: string): Promise<string> {
    return this.read(credentialId, ['TEMPLATE_SECRETS']);
  }

  /** The password an encrypted installation record is locked with. */
  documentPassword(credentialId: string): Promise<string> {
    return this.read(credentialId, ['DOCUMENT_PASSWORD']);
  }

  smtpPassword(credentialId: string): Promise<string> {
    return this.read(credentialId, ['SMTP_PASSWORD']);
  }

  /** A provisioned VM's accounts and passwords. For the answer file and the record, nothing else. */
  async guestCredentials(credentialId: string): Promise<GuestCredentials> {
    const raw = await this.read(credentialId, ['GUEST_CREDENTIALS']);
    try {
      const parsed = JSON.parse(raw) as GuestCredentials;
      if (!Array.isArray(parsed.accounts)) throw new Error('shape');
      return parsed;
    } catch {
      throw new CredentialUnavailableError(credentialId);
    }
  }

  /**
   * Store a provisioned VM's passwords, encrypted, the same way the API stores
   * any credential: one row, one secret, the ciphertext bound to the row's id.
   * The worker writes these because the worker is what decided them — a
   * template's fixed passwords cannot be read anywhere else.
   */
  async storeGuestCredentials(input: {
    tenantId: string;
    clusterId: string;
    hostname: string;
    credentials: GuestCredentials;
  }): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const credential = await tx.credential.create({
        data: {
          kind: 'GUEST_CREDENTIALS',
          tenantId: input.tenantId,
          label: `Accounts on ${input.hostname}`,
          status: 'ACTIVE',
          scopeType: 'CLUSTER',
          scopeId: input.clusterId,
        },
      });
      const aad = `credential:${credential.id}`;
      const encrypted = encryptSecret(this.masterKey, JSON.stringify(input.credentials), { aad });
      await tx.credentialSecret.create({
        data: {
          credentialId: credential.id,
          version: 1,
          status: 'ACTIVE',
          activatedAt: new Date(),
          ciphertext: new Uint8Array(encrypted.ciphertext),
          iv: new Uint8Array(encrypted.iv),
          authTag: new Uint8Array(encrypted.authTag),
          wrappedDek: new Uint8Array(encrypted.wrappedDek),
          dekIv: new Uint8Array(encrypted.dekIv),
          dekAuthTag: new Uint8Array(encrypted.dekAuthTag),
          keyVersion: encrypted.keyVersion,
          algorithm: encrypted.algorithm,
          aad,
        },
      });
      return credential.id;
    });
  }

  /** Remove a credential and its secret versions. Missing is not an error. */
  async remove(credentialId: string): Promise<void> {
    await this.prisma.credential.deleteMany({ where: { id: credentialId } });
  }

  private async read(credentialId: string, kinds?: readonly CredentialKind[]): Promise<string> {
    const record = await this.prisma.credentialSecret.findFirst({
      where: { credentialId, status: 'ACTIVE' },
      orderBy: [{ version: 'desc' }],
      include: { credential: { select: { kind: true } } },
    });

    if (!record) throw new CredentialUnavailableError(credentialId);
    // Asked for a template secret, given an SSH key: a wrong id somewhere, and
    // the answer is a refusal rather than the key.
    if (kinds && !kinds.includes(record.credential.kind)) {
      throw new CredentialUnavailableError(credentialId);
    }

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
