import 'server-only';
import type { SourceOfferResponse, SystemInfoResponse } from '@velnox/shared';

/**
 * Server-side API access.
 *
 * The browser never calls the API with a token: pages read through Server
 * Components over the internal Docker network, and the few client-side calls go
 * to the same origin through the reverse proxy, so the session cookie travels
 * without CORS. `server-only` makes an accidental import from a Client Component
 * a build error rather than a leak of the internal address.
 */
const INTERNAL_API_URL = process.env.API_INTERNAL_URL ?? 'http://api:4000';

export class ApiUnreachableError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(`API request to ${path} failed`, { cause });
    this.name = 'ApiUnreachableError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${INTERNAL_API_URL}${path}`;
  let response: Response;

  try {
    response = await fetch(url, {
      ...init,
      // Health and status must never be served from a cache: a stale "everything
      // is fine" is worse than no answer at all.
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
      headers: { accept: 'application/json', ...init?.headers },
    });
  } catch (error) {
    throw new ApiUnreachableError(path, error);
  }

  // The 503 exemption that used to live here was for `/readyz`, which answers
  // 503 with the report still in the body. That moved to the browser with the
  // Service status panel, and nothing left here has a body worth reading on a
  // failure — treating one as success would parse an error page as data.
  if (!response.ok) {
    throw new ApiUnreachableError(path, new Error(`HTTP ${response.status}`));
  }

  return (await response.json()) as T;
}

export const getSystemInfo = (): Promise<SystemInfoResponse> => request('/api/v1/system/info');

export const getSourceOffer = (): Promise<SourceOfferResponse> => request('/api/v1/system/source');

export async function tryGetSystemInfo(): Promise<SystemInfoResponse | null> {
  try {
    return await getSystemInfo();
  } catch {
    return null;
  }
}

export async function tryGetSourceOffer(): Promise<SourceOfferResponse | null> {
  try {
    return await getSourceOffer();
  } catch {
    return null;
  }
}
