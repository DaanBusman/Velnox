import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Per-request context.
 *
 * In Phase 1 this carries only a correlation id, but it is introduced now
 * deliberately: from Phase 2 it carries the authenticated principal, and from
 * Phase 3 the Prisma tenancy extension *requires* it and throws when it is
 * absent (docs/architecture.md section 4). Establishing the plumbing before
 * anything depends on it means later phases add fields rather than retrofit a
 * mechanism.
 */
export interface RequestContext {
  requestId: string;
  ip: string;
  userAgent: string;
  method: string;
  path: string;
  startedAt: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const runWithRequestContext = <T>(context: RequestContext, fn: () => T): T =>
  storage.run(context, fn);

export const getRequestContext = (): RequestContext | undefined => storage.getStore();

export const currentRequestId = (): string | undefined => storage.getStore()?.requestId;

export const newRequestId = (): string => randomUUID();
