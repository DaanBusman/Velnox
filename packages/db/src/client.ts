import { PrismaClient, type Prisma } from '@prisma/client';
import { tenancyExtension } from './tenancy';

export { PrismaClient };
export type { Prisma };
export * from '@prisma/client';

export interface CreateClientOptions {
  databaseUrl: string;
  /** Emit Prisma query events. Never enabled in production: queries carry data. */
  logQueries?: boolean;
}

/**
 * Build a Prisma client.
 *
 * This is where the tenancy extension is attached, and it is a single function
 * on purpose: there must be exactly one way to obtain a client, or the extension
 * becomes optional — and an optional isolation boundary is not one.
 *
 * The extended client is a different type from the base `PrismaClient`, which is
 * why `VelnoxPrismaClient` exists and why `PrismaService` owns an instance
 * rather than inheriting from one.
 */
export function createPrismaClient(options: CreateClientOptions) {
  const base = new PrismaClient({
    datasources: { db: { url: options.databaseUrl } },
    log: options.logQueries
      ? [{ emit: 'event', level: 'query' }, 'warn', 'error']
      : ['warn', 'error'],
  });

  return base.$extends(tenancyExtension);
}

/** The client every service actually holds: base Prisma plus mandatory scoping. */
export type VelnoxPrismaClient = ReturnType<typeof createPrismaClient>;

/**
 * The client handed to an interactive `$transaction` callback.
 *
 * `Prisma.TransactionClient` describes the *unextended* client, so a helper that
 * accepts "either the client or a transaction" stops compiling the moment an
 * extension is attached. These six members are exactly what Prisma removes
 * inside a transaction — you cannot open a connection, or nest another one.
 */
export type VelnoxTransactionClient = Omit<
  VelnoxPrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * The parts of a client that connectivity and bookkeeping helpers need.
 *
 * Structural rather than `PrismaClient`, so the same helper works with the
 * extended client without either of them knowing about the other.
 */
export interface RawCapableClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/** Round-trips to the database. Returns the latency so health checks can report it. */
export async function pingDatabase(prisma: RawCapableClient): Promise<number> {
  const started = Date.now();
  // A connectivity probe that touches no tenant-scoped model, and there is no
  // typed equivalent of "SELECT 1".
  // eslint-disable-next-line no-restricted-syntax
  await prisma.$queryRaw`SELECT 1`;
  return Date.now() - started;
}
