import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Validating an OIDC discovery document.
 *
 * The URL is supplied by an administrator, and the API fetches it. That is a
 * request the server makes to wherever it is told, which is the shape of a
 * server-side request forgery — an internal address here turns Velnox into a
 * probe for its own network. The checks below are the defence: HTTPS only, and
 * a hostname that resolves to a public address.
 *
 * This is not airtight. A name can resolve differently between this check and
 * the fetch (DNS rebinding), and closing that needs a resolver-pinned agent.
 * The gap is recorded in docs/known-gaps.md rather than papered over; the
 * endpoint is also restricted to `system.manage`, which is the highest
 * permission the product has.
 */

export interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  userinfo_endpoint?: string;
  response_types_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export type DiscoveryOutcome =
  | { ok: true; document: DiscoveryDocument; warnings: string[] }
  | { ok: false; reason: DiscoveryFailure; detail?: string };

export type DiscoveryFailure =
  | 'not_https'
  | 'address_not_public'
  | 'unreachable'
  | 'bad_status'
  | 'not_json'
  | 'missing_fields'
  | 'issuer_mismatch';

/** RFC 1918, loopback, link-local, carrier-grade NAT, and the IPv6 equivalents. */
function isPublicAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    const parts = address.split('.').map(Number);
    const [a = 0, b = 0] = parts;

    if (a === 10) return false; // 10.0.0.0/8
    if (a === 127) return false; // loopback
    if (a === 0) return false; // "this" network
    if (a === 169 && b === 254) return false; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
    if (a === 192 && b === 168) return false; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10
    if (a >= 224) return false; // multicast and reserved
    return true;
  }

  if (version === 6) {
    const normalised = address.toLowerCase();
    if (normalised === '::1' || normalised === '::') return false;
    if (normalised.startsWith('fe80')) return false; // link-local
    if (/^f[cd]/.test(normalised)) return false; // unique local
    // An IPv4-mapped address is an IPv4 address wearing a hat.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalised);
    if (mapped?.[1]) return isPublicAddress(mapped[1]);
    return true;
  }

  return false;
}

export async function resolvesToPublicAddress(hostname: string): Promise<boolean> {
  // A literal address skips DNS but not the check.
  if (isIP(hostname)) return isPublicAddress(hostname);

  try {
    const addresses = await lookup(hostname, { all: true });
    // Every address must be public. One private answer is enough to reach
    // somewhere it should not.
    return addresses.length > 0 && addresses.every((entry) => isPublicAddress(entry.address));
  } catch {
    return false;
  }
}

/**
 * Fetch and check a provider's discovery document.
 *
 * Returns a failure reason rather than throwing, because every one of these is
 * a thing an administrator needs to see and fix, not an internal error.
 */
export async function fetchDiscoveryDocument(
  discoveryUrl: string,
  expectedIssuer?: string | null,
): Promise<DiscoveryOutcome> {
  let url: URL;
  try {
    url = new URL(discoveryUrl);
  } catch {
    return { ok: false, reason: 'not_https' };
  }

  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };

  if (!(await resolvesToPublicAddress(url.hostname))) {
    return { ok: false, reason: 'address_not_public' };
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      redirect: 'error', // A redirect could land on an address the check cleared.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return {
      ok: false,
      reason: 'unreachable',
      detail: error instanceof Error ? error.message : undefined,
    };
  }

  if (!response.ok) {
    return { ok: false, reason: 'bad_status', detail: String(response.status) };
  }

  let document: DiscoveryDocument;
  try {
    document = (await response.json()) as DiscoveryDocument;
  } catch {
    return { ok: false, reason: 'not_json' };
  }

  const required: (keyof DiscoveryDocument)[] = [
    'issuer',
    'authorization_endpoint',
    'token_endpoint',
    'jwks_uri',
  ];
  const missing = required.filter((field) => typeof document[field] !== 'string');
  if (missing.length > 0) {
    return { ok: false, reason: 'missing_fields', detail: missing.join(', ') };
  }

  // The issuer is what a token is later checked against, so a document that
  // announces a different one than was configured is a misconfiguration worth
  // refusing now rather than at the first sign-in.
  if (expectedIssuer && document.issuer !== expectedIssuer) {
    return { ok: false, reason: 'issuer_mismatch', detail: document.issuer };
  }

  /*
   * Warnings, not failures.
   *
   * Velnox will use authorization code with PKCE (docs/architecture.md), so a
   * provider that does not advertise S256 is a problem — but the advertisement
   * is optional in the specification and some providers omit it while
   * supporting it. Refusing here would block working configurations.
   */
  const warnings: string[] = [];
  const methods = document.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes('S256')) {
    warnings.push('pkce_s256_not_advertised');
  }

  const responseTypes = document.response_types_supported;
  if (Array.isArray(responseTypes) && !responseTypes.includes('code')) {
    warnings.push('authorization_code_not_advertised');
  }

  return { ok: true, document, warnings };
}
