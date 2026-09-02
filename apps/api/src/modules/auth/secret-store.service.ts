import { Inject, Injectable } from '@nestjs/common';
import type { CredentialKind } from '@velnox/db';
import { decodeMasterKey, decryptSecret, encryptSecret } from '@velnox/crypto';
import type { ApiConfig } from '@velnox/config';
import { API_CONFIG } from '../../config/config.module';
import { PrismaService } from '../infrastructure/prisma.service';

/**
 * The API's secret store — deliberately restricted.
 *
 * ADR-009 says the API performs no outbound automation and does not decrypt
 * credentials for use. A TOTP seed is the one thing that cannot honour that
 * literally: verifying a login code needs the seed, and routing every sign-in
 * through the job queue to borrow the worker's key would be absurd.
 *
 * So the boundary is drawn where it matters rather than abandoned. The API can
 * read the material Velnox uses to authenticate *its own* users; it cannot read
 * a single credential belonging to managed infrastructure. That is enforced here
 * by kind, not by convention — asking for a Proxmox password from the API
 * throws, and there is no flag to turn it off.
 */
const API_READABLE_KINDS: ReadonlySet<CredentialKind> = new Set<CredentialKind>([
  'TOTP_SEED',
  'OIDC_CLIENT_SECRET',
]);

export class ForbiddenCredentialKindError extends Error {
  constructor(kind: CredentialKind) {
    super(
      `The API may not read credentials of kind ${kind}. Infrastructure credentials are ` +
        'decrypted only by the worker (docs/tech-decisions.md ADR-009).',
    );
    this.name = 'ForbiddenCredentialKindError';
  }
}

@Injectable()
export class SecretStoreService {
  private readonly masterKey: Buffer;

  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    private readonly prisma: PrismaService,
  ) {
    this.masterKey = decodeMasterKey(config.MASTER_ENCRYPTION_KEY);
  }

  /**
   * Store material together with the credential row that owns it.
   *
   * Both rows are written in one transaction, so there is never a secret without
   * an owner. The ciphertext is bound to the credential id as associated data,
   * so the stored bytes cannot be moved to another credential and still decrypt.
   */
  async putForCredential(params: {
    kind: CredentialKind;
    material: string | Buffer;
    tenantId?: string | null;
    label?: string;
    username?: string;
  }): Promise<{ credentialId: string; secretRef: string }> {
    this.assertReadable(params.kind);

    return this.prisma.client.$transaction(async (tx) => {
      const credential = await tx.credential.create({
        data: {
          kind: params.kind,
          tenantId: params.tenantId ?? null,
          label: params.label ?? null,
          username: params.username ?? null,
          status: 'ACTIVE',
        },
      });

      const aad = `credential:${credential.id}`;
      const encrypted = encryptSecret(this.masterKey, params.material, { aad });

      const secret = await tx.credentialSecret.create({
        data: {
          credentialId: credential.id,
          version: 1,
          status: 'ACTIVE',
          activatedAt: new Date(),
          ciphertext: bytes(encrypted.ciphertext),
          iv: bytes(encrypted.iv),
          authTag: bytes(encrypted.authTag),
          wrappedDek: bytes(encrypted.wrappedDek),
          dekIv: bytes(encrypted.dekIv),
          dekAuthTag: bytes(encrypted.dekAuthTag),
          keyVersion: encrypted.keyVersion,
          algorithm: encrypted.algorithm,
          aad,
        },
      });

      return { credentialId: credential.id, secretRef: secret.id };
    });
  }

  /** Read material, refusing kinds the API has no business decrypting. */
  async get(secretRef: string): Promise<Buffer> {
    const record = await this.prisma.client.credentialSecret.findUnique({
      where: { id: secretRef },
      include: { credential: true },
    });
    if (!record) throw new Error(`No stored secret with reference ${secretRef}`);

    this.assertReadable(record.credential.kind);

    return decryptSecret(
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
      { aad: record.aad ?? undefined },
    );
  }

  /** Removing the credential cascades to its secret versions. */
  async deleteCredential(credentialId: string): Promise<void> {
    await this.prisma.client.credential.delete({ where: { id: credentialId } });
  }

  private assertReadable(kind: CredentialKind): void {
    if (!API_READABLE_KINDS.has(kind)) throw new ForbiddenCredentialKindError(kind);
  }
}

/**
 * Prisma's `Bytes` columns take a `Uint8Array` backed by a plain `ArrayBuffer`,
 * while Node's `Buffer` may sit on a `SharedArrayBuffer`. The copy is a few
 * dozen bytes and keeps the conversion in one place rather than scattering
 * casts across the write.
 */
function bytes(value: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}
