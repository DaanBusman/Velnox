import { decryptSecret, encryptSecret, rewrapSecret, type EncryptedSecret } from './envelope';

/**
 * The secret store interface.
 *
 * Every consumer talks to this, never to the envelope functions directly, so a
 * HashiCorp Vault or Azure Key Vault backend can replace the storage without any
 * call site changing. The database-backed implementation below is the only one
 * that ships today; the others are recorded in docs/known-gaps.md rather than
 * stubbed here.
 *
 * The interface is deliberately narrow. There is no "list secrets" and no
 * "export": the only way material leaves the store is one `get` at a time, by a
 * caller that already knows the reference it wants.
 */

/** Opaque handle to stored material. Safe to keep in a database column or a job payload. */
export type SecretRef = string;

export interface SecretStore {
  /** Store material and return its reference. */
  put(material: string | Buffer, context?: SecretContext): Promise<SecretRef>;
  /** Retrieve material. Throws if the reference is unknown or undecryptable. */
  get(ref: SecretRef): Promise<Buffer>;
  /** Remove material permanently. */
  delete(ref: SecretRef): Promise<void>;
  /** Re-encrypt everything under a new master key. Used by key rotation. */
  rewrap(newMasterKey: Buffer): Promise<{ rewrapped: number }>;
}

export interface SecretContext {
  /**
   * Binds the ciphertext to where it belongs, so stored bytes cannot be moved to
   * another row and still decrypt. Pass something stable and unique, such as
   * `mfa:<userId>` or `credential:<id>`.
   */
  aad?: string;
}

/**
 * The persistence the store needs, so it can be backed by Prisma without this
 * package depending on the database layer.
 */
export interface SecretRecord extends EncryptedSecret {
  id: string;
  aad: string | null;
}

export interface SecretRepository {
  insert(record: Omit<SecretRecord, 'id'>): Promise<{ id: string }>;
  findById(id: string): Promise<SecretRecord | null>;
  deleteById(id: string): Promise<void>;
  listAll(): Promise<SecretRecord[]>;
  updateWrapping(
    id: string,
    wrapping: Pick<EncryptedSecret, 'wrappedDek' | 'dekIv' | 'dekAuthTag' | 'keyVersion'>,
  ): Promise<void>;
}

export class SecretNotFoundError extends Error {
  constructor(ref: string) {
    super(`No stored secret with reference ${ref}`);
    this.name = 'SecretNotFoundError';
  }
}

/**
 * Database-backed secret store.
 *
 * Holds the master key in memory for the lifetime of the process. That is the
 * cost of having no external KMS: anything that can read this process's memory
 * can read the key, which is why the worker is the only service that constructs
 * one with the intent to call `get`.
 */
export class DatabaseSecretStore implements SecretStore {
  constructor(
    private readonly repository: SecretRepository,
    private readonly masterKey: Buffer,
  ) {}

  async put(material: string | Buffer, context: SecretContext = {}): Promise<SecretRef> {
    const encrypted = encryptSecret(this.masterKey, material, { aad: context.aad });
    const { id } = await this.repository.insert({ ...encrypted, aad: context.aad ?? null });
    return id;
  }

  async get(ref: SecretRef): Promise<Buffer> {
    const record = await this.repository.findById(ref);
    if (!record) throw new SecretNotFoundError(ref);
    return decryptSecret(this.masterKey, record, { aad: record.aad ?? undefined });
  }

  async delete(ref: SecretRef): Promise<void> {
    await this.repository.deleteById(ref);
  }

  /**
   * Rewrap every stored secret under a new master key.
   *
   * Payloads are never decrypted — only each secret's data key is unwrapped and
   * wrapped again — so this stays cheap regardless of how much material is
   * stored, and a failure part-way leaves the untouched rows readable under the
   * old key rather than corrupting them.
   */
  async rewrap(newMasterKey: Buffer): Promise<{ rewrapped: number }> {
    const records = await this.repository.listAll();
    let rewrapped = 0;

    for (const record of records) {
      const next = rewrapSecret(this.masterKey, newMasterKey, record);
      await this.repository.updateWrapping(record.id, {
        wrappedDek: next.wrappedDek,
        dekIv: next.dekIv,
        dekAuthTag: next.dekAuthTag,
        keyVersion: next.keyVersion,
      });
      rewrapped += 1;
    }

    return { rewrapped };
  }
}

/** In-memory store, for tests. Never used by a running service. */
export class InMemorySecretRepository implements SecretRepository {
  private readonly rows = new Map<string, SecretRecord>();
  private sequence = 0;

  async insert(record: Omit<SecretRecord, 'id'>): Promise<{ id: string }> {
    const id = `secret-${++this.sequence}`;
    this.rows.set(id, { ...record, id });
    return { id };
  }

  async findById(id: string): Promise<SecretRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async deleteById(id: string): Promise<void> {
    this.rows.delete(id);
  }

  async listAll(): Promise<SecretRecord[]> {
    return [...this.rows.values()];
  }

  async updateWrapping(
    id: string,
    wrapping: Pick<EncryptedSecret, 'wrappedDek' | 'dekIv' | 'dekAuthTag' | 'keyVersion'>,
  ): Promise<void> {
    const existing = this.rows.get(id);
    if (existing) this.rows.set(id, { ...existing, ...wrapping });
  }

  get size(): number {
    return this.rows.size;
  }
}
