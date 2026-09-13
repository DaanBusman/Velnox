import type { Request } from 'express';
import { ERROR_CODES, VelnoxError, isAllowed, type Grant, type Permission } from '@velnox/shared';

/**
 * The authenticated caller, in the form services need.
 *
 * The guard has already answered "may this principal use this endpoint at all".
 * Services ask the second question — *on whose data* — and that needs the grants
 * themselves, not a yes/no. This type is what carries them across the boundary,
 * so no service reaches into the Express request.
 */
export interface Actor {
  id: string;
  email: string;
  tenantId: string;
  isMspRoot: boolean;
  /** Every tenant this actor may read. Empty means none, never all. */
  accessibleTenantIds: string[];
  /** True when a grant is GLOBAL, which is what makes an actor unscoped. */
  hasGlobalGrant: boolean;
  grants: Grant[];
}

export function actorOf(request: Request): Actor {
  const principal = request.velnoxPrincipal;
  if (!principal) throw new VelnoxError(ERROR_CODES.authSessionExpired, { status: 401 });

  return {
    id: principal.user.id,
    email: principal.user.email,
    tenantId: principal.user.tenantId,
    isMspRoot: principal.isMspRoot,
    accessibleTenantIds: principal.accessibleTenantIds,
    hasGlobalGrant: principal.hasGlobalGrant,
    grants: principal.grants,
  };
}

/**
 * Refuse unless this actor holds the permission at the scope of the thing being
 * acted on.
 *
 * The `@RequirePermission` decorator can only resolve a scope from the request
 * itself, which is enough for "create a site in tenant X" — the tenant is in the
 * body — and not enough for "rename site Y", where the tenant is a property of a
 * row nobody has read yet. This is that second check, made after the row is
 * loaded.
 *
 * It is a refusal, not a filter: the query that loaded the row was already
 * scoped, so reaching here with an out-of-scope row should be impossible. That
 * is exactly why it is worth asserting — a "cannot happen" that is never checked
 * is a "cannot happen" nobody notices becoming possible.
 */
export function assertAllowedAt(
  actor: Actor,
  permission: Permission,
  target: { tenantId?: string | null; siteId?: string | null; clusterId?: string | null },
): void {
  if (isAllowed(actor.grants, permission, target)) return;
  throw new VelnoxError(ERROR_CODES.authzForbidden, {
    status: 403,
    params: { permission },
  });
}
