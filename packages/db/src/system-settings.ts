import type { SystemSettings } from '@prisma/client';
import type { VelnoxPrismaClient } from './client';

/** The settings singleton always has id = 1; a CHECK constraint forbids any other. */
export const SYSTEM_SETTINGS_ID = 1;

/**
 * Read the settings row, creating it with defaults if this is a fresh database.
 *
 * Creating it here rather than seeding it in the migration keeps migrations free
 * of data, and means the row's defaults come from one place — the schema.
 * `initialized` stays false: only the Phase 2 setup wizard may set it, and only
 * in the same transaction that creates the first administrator.
 */
export async function ensureSystemSettings(prisma: VelnoxPrismaClient): Promise<SystemSettings> {
  return prisma.systemSettings.upsert({
    where: { id: SYSTEM_SETTINGS_ID },
    update: {},
    create: { id: SYSTEM_SETTINGS_ID },
  });
}

export async function getSystemSettings(
  prisma: VelnoxPrismaClient,
): Promise<SystemSettings | null> {
  return prisma.systemSettings.findUnique({ where: { id: SYSTEM_SETTINGS_ID } });
}
