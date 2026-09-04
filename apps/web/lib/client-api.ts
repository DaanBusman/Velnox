'use client';

/**
 * Browser-side API calls.
 *
 * Only authentication does this. Everything else reads through Server
 * Components, but signing in has to happen in the browser: the API answers with
 * `Set-Cookie`, and letting the browser receive those headers directly is what
 * keeps the session cookie `HttpOnly` and out of reach of any script on the
 * page. Routing it through a server action would mean copying cookies by hand.
 *
 * The API is same-origin behind the reverse proxy, so no CORS and no token in
 * JavaScript.
 */

export const CSRF_COOKIE = 'velnox_csrf';
export const CSRF_HEADER = 'X-Velnox-CSRF';

export interface ApiFailure {
  code: string;
  params?: Record<string, string | number | boolean | null>;
  /** Field-level detail from the validation pipe, when there is any. */
  details?: { path: string; code: string; message: string }[];
  status: number;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiFailure };

function readCsrfToken(): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<ApiResult<T>> {
  const csrf = readCsrfToken();

  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: 'POST',
      // The cookie is the credential; it must be sent and it must be storable.
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        // Double-submit: a cross-site page can cause the cookie to be sent but
        // cannot read it to reproduce this header.
        ...(csrf ? { [CSRF_HEADER]: csrf } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, error: { code: 'network', status: 0 } };
  }

  if (response.status === 204) return { ok: true, data: undefined as T };

  const payload = (await response.json().catch(() => null)) as {
    error?: ApiFailure;
  } | null;

  if (!response.ok) {
    const error = payload?.error;
    return {
      ok: false,
      error: {
        code: error?.code ?? 'generic',
        status: response.status,
        ...(error?.params ? { params: error.params } : {}),
        ...(error?.details ? { details: error.details } : {}),
      },
    };
  }

  return { ok: true, data: payload as T };
}
