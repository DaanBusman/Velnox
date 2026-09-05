import 'server-only';
import { cookies } from 'next/headers';
import type {
  AuditEventView,
  IdentityProviderView,
  RoleSummary,
  Session,
  UserSummary,
} from './session-types';

export type {
  AuditEventView,
  IdentityProviderView,
  RoleSummary,
  Session,
  SessionUser,
  UserSummary,
} from './session-types';

/**
 * The signed-in user, as the server sees it.
 *
 * Every page that shows anything belonging to a user resolves the session here,
 * by asking the API — not by reading the cookie and trusting what is in it. The
 * cookie is opaque to this app on purpose: the API is the only thing that can
 * say whether a session is still valid, whether its owner still exists, and
 * whether it has satisfied its second factor.
 */

const INTERNAL_API_URL = process.env.API_INTERNAL_URL ?? 'http://api:4000';

export interface SetupStatus {
  initialized: boolean;
  productName: string;
}

/** Forward the browser's cookies, so the API sees the caller's own session. */
async function forwardedCookies(): Promise<string> {
  const store = await cookies();
  return store
    .getAll()
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

/**
 * Returns null for any session the API will not honour — missing, expired,
 * revoked, or belonging to a user that has since been disabled.
 */
export async function getSession(): Promise<Session | null> {
  const cookieHeader = await forwardedCookies();
  if (!cookieHeader) return null;

  try {
    const response = await fetch(`${INTERNAL_API_URL}/api/v1/auth/me`, {
      headers: { accept: 'application/json', cookie: cookieHeader },
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) return null;
    return (await response.json()) as Session;
  } catch {
    // The API being unreachable is not the same as being signed out, but from
    // here the two are indistinguishable, and the safe reading is "no session".
    return null;
  }
}

export async function getSetupStatus(): Promise<SetupStatus | null> {
  try {
    const response = await fetch(`${INTERNAL_API_URL}/api/v1/setup/status`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as SetupStatus;
  } catch {
    return null;
  }
}



/**
 * One place for every authenticated read.
 *
 * Each of these forwards the caller's own cookies, so the API applies their
 * permissions rather than the web app's — the interface never decides what
 * someone may see. A 403 comes back as a code the page renders as an
 * explanation, which is why the failure shape is part of the return type
 * instead of an exception.
 */
async function readAs<T>(path: string): Promise<{ ok: true; data: T } | { ok: false; code: string }> {
  const cookieHeader = await forwardedCookies();

  try {
    const response = await fetch(`${INTERNAL_API_URL}${path}`, {
      headers: { accept: 'application/json', cookie: cookieHeader },
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { code?: string };
      } | null;
      return { ok: false, code: body?.error?.code ?? 'generic' };
    }

    return { ok: true, data: (await response.json()) as T };
  } catch {
    return { ok: false, code: 'network' };
  }
}

export function listRoles() {
  return readAs<{ roles: RoleSummary[]; catalogue: string[] }>('/api/v1/roles');
}

export function listAuditEvents(params: { limit?: number; cursor?: string; action?: string } = {}) {
  const query = new URLSearchParams();
  query.set('limit', String(params.limit ?? 50));
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.action) query.set('action', params.action);

  return readAs<{ events: AuditEventView[]; nextCursor: string | null }>(
    `/api/v1/audit-events?${query.toString()}`,
  );
}

export function listAuditActions() {
  return readAs<{ actions: string[] }>('/api/v1/audit-events/actions');
}

export function listUsers() {
  return readAs<{ users: UserSummary[] }>('/api/v1/users');
}

/** The Entra ID configuration. Requires system.manage, which the API enforces. */
export function getIdentityProvider() {
  return readAs<IdentityProviderView>('/api/v1/identity-providers/oidc');
}
