import 'server-only';
import { cookies } from 'next/headers';
import type { IdentityProviderView, Session, UserSummary } from './session-types';

export type {
  IdentityProviderView,
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

/** Reads as the signed-in user, so the API applies their permissions, not ours. */
export async function listUsers(): Promise<
  { ok: true; users: UserSummary[] } | { ok: false; code: string }
> {
  const cookieHeader = await forwardedCookies();

  try {
    const response = await fetch(`${INTERNAL_API_URL}/api/v1/users`, {
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

    const body = (await response.json()) as { users: UserSummary[] };
    return { ok: true, users: body.users };
  } catch {
    return { ok: false, code: 'network' };
  }
}

/** The Entra ID configuration. Requires system.manage, which the API enforces. */
export async function getIdentityProvider(): Promise<
  { ok: true; provider: IdentityProviderView } | { ok: false; code: string }
> {
  const cookieHeader = await forwardedCookies();

  try {
    const response = await fetch(`${INTERNAL_API_URL}/api/v1/identity-providers/oidc`, {
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

    return { ok: true, provider: (await response.json()) as IdentityProviderView };
  } catch {
    return { ok: false, code: 'network' };
  }
}
