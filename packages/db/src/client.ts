import { PrismaClient, type Prisma } from '@prisma/client';

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
 * From Phase 3 this is where the tenancy client extension is attached, so that
 * every query against a tenant-scoped model carries a tenant filter and throws
 * when no request context is present. It is a single function on purpose: there
 * must be exactly one way to obtain a client, or the extension becomes optional.
 */
export function createPrismaClient(options: CreateClientOptions): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: options.databaseUrl } },
    log: options.logQueries
      ? [{ emit: 'event', level: 'query' }, 'warn', 'error']
      : ['warn', 'error'],
  });
}

/** Round-trips to the database. Returns the latency so health checks can report it. */
export async function pingDatabase(prisma: PrismaClient): Promise<number> {
  const started = Date.now();
  // A connectivity probe that touches no tenant-scoped model, and there is no
  // typed equivalent of "SELECT 1".
  // eslint-disable-next-line no-restricted-syntax
  await prisma.$queryRaw`SELECT 1`;
  return Date.now() - started;
}
