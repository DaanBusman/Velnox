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
export interface RequestPrincipal {
  userId: string;
  tenantId: string;
  sessionId: string;
  isMspRoot: boolean;
}

export interface RequestContext {
  requestId: string;
  ip: string;
  userAgent: string;
  method: string;
  path: string;
  startedAt: number;
  /** Set by the auth guard once the request is authenticated. */
  principal?: RequestPrincipal;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const runWithRequestContext = <T>(context: RequestContext, fn: () => T): T =>
  storage.run(context, fn);

export const getRequestContext = (): RequestContext | undefined => storage.getStore();

export const currentRequestId = (): string | undefined => storage.getStore()?.requestId;

export const newRequestId = (): string => randomUUID();

/**
 * Attach the authenticated principal to the current request context.
 *
 * From Phase 3 the Prisma tenancy extension reads this and throws when it is
 * absent, so audit writes and queries cannot silently run unscoped.
 */
export function setPrincipal(principal: RequestPrincipal): void {
  const store = storage.getStore();
  if (store) store.principal = principal;
}

export const currentPrincipal = (): RequestPrincipal | undefined =>
  storage.getStore()?.principal;
