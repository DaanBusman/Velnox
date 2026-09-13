import { cookies } from 'next/headers';

/**
 * Which tenant the viewer is looking at.
 *
 * A filter, not a permission. The API scopes every list to the caller's own
 * grants regardless of what this says, so the worst a tampered cookie can do is
 * narrow a list to nothing. It is deliberately not `httpOnly`: it carries no
 * authority, and the selector in the top bar is the thing that writes it.
 */
export const SELECTED_TENANT_COOKIE = 'velnox_tenant';

/** The selection, or null for "everything this account can reach". */
export async function selectedTenantId(): Promise<string | null> {
  const value = (await cookies()).get(SELECTED_TENANT_COOKIE)?.value;
  return value && value.length > 0 ? value : null;
}

/**
 * The selection, but only if it is one of these tenants.
 *
 * Not a security check — see above. It keeps a stale cookie, left behind by a
 * tenant that was archived or a grant that was revoked, from silently filtering
 * every page down to an empty list with no visible reason.
 */
export function resolveSelection(
  selected: string | null,
  tenants: { id: string }[],
): string | null {
  if (!selected) return null;
  return tenants.some((tenant) => tenant.id === selected) ? selected : null;
}
