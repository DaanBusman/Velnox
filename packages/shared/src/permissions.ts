/**
 * The permission catalogue.
 *
 * One frozen list, used by the API guards, the role seed and the frontend. A
 * permission that is not here does not exist: adding one is a code change plus a
 * data migration, never a runtime data-entry surface, so the set of things a
 * role can be granted is always reviewable in a diff.
 *
 * Naming is `resource.action`. `read` sees; `manage` creates, changes and
 * deletes; `execute` starts work against real infrastructure. The split between
 * `manage` and `execute` is deliberate — planning an upgrade and running one are
 * different levels of trust.
 */
export const PERMISSIONS = {
  // Organisation
  tenantsRead: 'tenants.read',
  tenantsManage: 'tenants.manage',
  sitesRead: 'sites.read',
  sitesManage: 'sites.manage',

  // Identity and access
  usersRead: 'users.read',
  usersManage: 'users.manage',
  rolesRead: 'roles.read',
  rolesManage: 'roles.manage',

  // Infrastructure inventory
  clustersRead: 'clusters.read',
  clustersManage: 'clusters.manage',
  nodesRead: 'nodes.read',
  nodesManage: 'nodes.manage',
  workloadsRead: 'workloads.read',
  storageRead: 'storage.read',
  networksRead: 'networks.read',

  // Change management
  updatesRead: 'updates.read',
  updatesExecute: 'updates.execute',
  upgradesRead: 'upgrades.read',
  upgradesExecute: 'upgrades.execute',
  automationRead: 'automation.read',
  automationManage: 'automation.manage',

  // Credentials. Reading metadata is not reading secret material — no permission
  // grants that, because no endpoint returns it.
  credentialsRead: 'credentials.read',
  credentialsManage: 'credentials.manage',
  credentialsRotate: 'credentials.rotate',

  // Migration
  migrationsRead: 'migrations.read',
  migrationsExecute: 'migrations.execute',

  // Operations
  jobsRead: 'jobs.read',
  jobsCancel: 'jobs.cancel',
  jobsApprove: 'jobs.approve',
  alertsRead: 'alerts.read',
  alertsManage: 'alerts.manage',
  reportsRead: 'reports.read',

  // Governance
  auditRead: 'audit.read',
  systemManage: 'system.manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: readonly Permission[] = Object.freeze(
  Object.values(PERMISSIONS),
) as readonly Permission[];

const PERMISSION_SET = new Set<string>(ALL_PERMISSIONS);
export const isPermission = (value: unknown): value is Permission =>
  typeof value === 'string' && PERMISSION_SET.has(value);

/**
 * Permissions that let a principal change customer infrastructure or the
 * security posture of the installation.
 *
 * This is what the `REQUIRED_FOR_PRIVILEGED` multi-factor policy resolves to:
 * exactly the accounts whose compromise would be felt outside Velnox itself.
 *
 * It is an explicit list rather than "everything ending in .manage", because the
 * two are not the same. `alerts.manage` acknowledges and resolves alerts — it
 * changes Velnox's own view of the world, not a customer's hypervisor — so it is
 * deliberately absent. Suppressing an alert can hide an incident, which is worth
 * auditing, but it is not worth forcing a second factor over.
 */
export const PRIVILEGED_PERMISSIONS: readonly Permission[] = Object.freeze([
  PERMISSIONS.tenantsManage,
  PERMISSIONS.sitesManage,
  PERMISSIONS.usersManage,
  PERMISSIONS.rolesManage,
  PERMISSIONS.clustersManage,
  PERMISSIONS.nodesManage,
  PERMISSIONS.updatesExecute,
  PERMISSIONS.upgradesExecute,
  PERMISSIONS.automationManage,
  PERMISSIONS.credentialsManage,
  PERMISSIONS.credentialsRotate,
  PERMISSIONS.migrationsExecute,
  PERMISSIONS.jobsApprove,
  PERMISSIONS.systemManage,
]);

const PRIVILEGED_SET = new Set<string>(PRIVILEGED_PERMISSIONS);
export const isPrivilegedPermission = (p: string): boolean => PRIVILEGED_SET.has(p);

/** The scope a grant applies at. A grant covers its scope and everything under it. */
export const SCOPE_TYPES = ['GLOBAL', 'TENANT', 'SITE', 'CLUSTER'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

/**
 * Scope ancestry, widest first. `GLOBAL` is only assignable to members of the MSP
 * root tenant; a grant at `TENANT` covers every site, cluster and node beneath it.
 */
export const SCOPE_RANK: Record<ScopeType, number> = {
  GLOBAL: 0,
  TENANT: 1,
  SITE: 2,
  CLUSTER: 3,
};

export interface Grant {
  permission: Permission;
  scopeType: ScopeType;
  /** Null for GLOBAL. */
  scopeId: string | null;
}

/** The scope a request targets, resolved from the resource being acted on. */
export interface TargetScope {
  tenantId?: string | null;
  siteId?: string | null;
  clusterId?: string | null;
}

/**
 * Does any grant cover this permission at or above the target's scope?
 *
 * Written as a pure function on purpose: it is the single decision every guard
 * defers to, so it is exhaustively testable without a database, a request or a
 * running server.
 */
export function isAllowed(
  grants: readonly Grant[],
  permission: Permission,
  target: TargetScope = {},
): boolean {
  for (const grant of grants) {
    if (grant.permission !== permission) continue;

    switch (grant.scopeType) {
      case 'GLOBAL':
        return true;
      case 'TENANT':
        if (grant.scopeId && grant.scopeId === target.tenantId) return true;
        break;
      case 'SITE':
        if (grant.scopeId && grant.scopeId === target.siteId) return true;
        break;
      case 'CLUSTER':
        if (grant.scopeId && grant.scopeId === target.clusterId) return true;
        break;
    }
  }
  return false;
}

/** Every permission the grants confer anywhere. Used to decide MFA policy and to drive the UI. */
export function grantedPermissions(grants: readonly Grant[]): Permission[] {
  return [...new Set(grants.map((g) => g.permission))].sort();
}

export const holdsPrivilegedPermission = (grants: readonly Grant[]): boolean =>
  grants.some((g) => isPrivilegedPermission(g.permission));

// ---------------------------------------------------------------------------
// System roles
// ---------------------------------------------------------------------------

export type SystemRoleKey =
  | 'msp_super_administrator'
  | 'msp_administrator'
  | 'msp_engineer'
  | 'msp_read_only'
  | 'tenant_administrator'
  | 'tenant_operator'
  | 'tenant_read_only';

export interface SystemRoleDefinition {
  key: SystemRoleKey;
  name: string;
  description: string;
  /** Roles only ever assignable to members of the MSP root tenant. */
  mspOnly: boolean;
  permissions: readonly Permission[];
}

const READ_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS.filter((p) => p.endsWith('.read'));

const P = PERMISSIONS;

/** Operating a fleet: everything except identity, tenancy and system settings. */
const ENGINEER_PERMISSIONS: readonly Permission[] = [
  ...READ_PERMISSIONS.filter((p) => p !== P.auditRead),
  P.clustersManage,
  P.nodesManage,
  P.updatesExecute,
  P.upgradesExecute,
  P.credentialsManage,
  P.credentialsRotate,
  P.migrationsExecute,
  P.automationManage,
  P.jobsCancel,
  P.alertsManage,
];

export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = Object.freeze([
  {
    key: 'msp_super_administrator',
    name: 'MSP Super Administrator',
    description:
      'Full access to every tenant, plus tenant, security and system settings. The role the first administrator receives.',
    mspOnly: true,
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'msp_administrator',
    name: 'MSP Administrator',
    description:
      'Broad access across all tenants, including user and role management, but not installation-wide system settings.',
    mspOnly: true,
    permissions: ALL_PERMISSIONS.filter((p) => p !== P.systemManage),
  },
  {
    key: 'msp_engineer',
    name: 'MSP Engineer',
    description:
      'Manages clusters and nodes and runs updates, upgrades and migrations. No user, role or system administration.',
    mspOnly: true,
    permissions: ENGINEER_PERMISSIONS,
  },
  {
    key: 'msp_read_only',
    name: 'MSP Read Only',
    description: 'Sees everything across all tenants and changes nothing.',
    mspOnly: true,
    permissions: READ_PERMISSIONS,
  },
  {
    key: 'tenant_administrator',
    name: 'Tenant Administrator',
    description:
      'Full control within one tenant, including managing that tenant’s own users and roles.',
    mspOnly: false,
    permissions: [
      ...READ_PERMISSIONS,
      P.sitesManage,
      P.usersManage,
      P.rolesManage,
      P.clustersManage,
      P.nodesManage,
      P.updatesExecute,
      P.upgradesExecute,
      P.credentialsManage,
      P.credentialsRotate,
      P.migrationsExecute,
      P.automationManage,
      P.jobsCancel,
      P.jobsApprove,
      P.alertsManage,
    ],
  },
  {
    key: 'tenant_operator',
    name: 'Tenant Operator',
    description: 'Runs day-to-day work on one tenant’s resources. No identity administration.',
    mspOnly: false,
    permissions: [
      ...READ_PERMISSIONS.filter((p) => p !== P.auditRead),
      P.clustersManage,
      P.nodesManage,
      P.updatesExecute,
      P.jobsCancel,
      P.alertsManage,
    ],
  },
  {
    key: 'tenant_read_only',
    name: 'Tenant Read Only',
    description: 'Sees one tenant’s resources and changes nothing.',
    mspOnly: false,
    permissions: READ_PERMISSIONS.filter((p) => p !== P.auditRead),
  },
]);

export const systemRole = (key: SystemRoleKey): SystemRoleDefinition => {
  const role = SYSTEM_ROLES.find((r) => r.key === key);
  if (!role) throw new Error(`Unknown system role: ${key}`);
  return role;
};

/** The role the setup wizard grants to the first administrator, at GLOBAL scope. */
export const FIRST_ADMINISTRATOR_ROLE: SystemRoleKey = 'msp_super_administrator';
