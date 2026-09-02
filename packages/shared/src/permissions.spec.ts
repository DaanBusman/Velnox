import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  FIRST_ADMINISTRATOR_ROLE,
  PERMISSIONS,
  PRIVILEGED_PERMISSIONS,
  SYSTEM_ROLES,
  grantedPermissions,
  holdsPrivilegedPermission,
  isAllowed,
  isPermission,
  isPrivilegedPermission,
  systemRole,
  type Grant,
} from './permissions';

const grant = (permission: string, scopeType: Grant['scopeType'], scopeId: string | null = null) =>
  ({ permission, scopeType, scopeId }) as Grant;

describe('permission catalogue', () => {
  it('has no duplicates', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it('names every permission resource.action', () => {
    for (const p of ALL_PERMISSIONS) {
      expect(p, `"${p}" is not resource.action`).toMatch(/^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/);
    }
  });

  it('recognises only catalogued permissions', () => {
    expect(isPermission('nodes.manage')).toBe(true);
    expect(isPermission('nodes.destroy')).toBe(false);
    expect(isPermission('')).toBe(false);
    expect(isPermission(null)).toBe(false);
  });
});

describe('isAllowed', () => {
  it('grants nothing without a matching permission', () => {
    expect(isAllowed([grant(PERMISSIONS.nodesRead, 'GLOBAL')], PERMISSIONS.nodesManage)).toBe(false);
    expect(isAllowed([], PERMISSIONS.nodesRead)).toBe(false);
  });

  it('lets a GLOBAL grant reach every scope', () => {
    const grants = [grant(PERMISSIONS.nodesManage, 'GLOBAL')];
    expect(isAllowed(grants, PERMISSIONS.nodesManage)).toBe(true);
    expect(isAllowed(grants, PERMISSIONS.nodesManage, { tenantId: 'any' })).toBe(true);
    expect(isAllowed(grants, PERMISSIONS.nodesManage, { clusterId: 'any' })).toBe(true);
  });

  it('confines a TENANT grant to its own tenant', () => {
    const grants = [grant(PERMISSIONS.nodesManage, 'TENANT', 'tenant-a')];
    expect(isAllowed(grants, PERMISSIONS.nodesManage, { tenantId: 'tenant-a' })).toBe(true);
    expect(isAllowed(grants, PERMISSIONS.nodesManage, { tenantId: 'tenant-b' })).toBe(false);
  });

  it('refuses a tenant-scoped grant when the target names no tenant', () => {
    // A resource with no resolved tenant must not fall through to "allowed".
    const grants = [grant(PERMISSIONS.nodesManage, 'TENANT', 'tenant-a')];
    expect(isAllowed(grants, PERMISSIONS.nodesManage, {})).toBe(false);
    expect(isAllowed(grants, PERMISSIONS.nodesManage, { tenantId: null })).toBe(false);
  });

  it('confines a CLUSTER grant to that cluster, even inside the right tenant', () => {
    const grants = [grant(PERMISSIONS.nodesManage, 'CLUSTER', 'cluster-dr')];
    expect(
      isAllowed(grants, PERMISSIONS.nodesManage, { tenantId: 'tenant-b', clusterId: 'cluster-dr' }),
    ).toBe(true);
    expect(
      isAllowed(grants, PERMISSIONS.nodesManage, { tenantId: 'tenant-b', clusterId: 'cluster-prod' }),
    ).toBe(false);
    expect(isAllowed(grants, PERMISSIONS.nodesManage, { tenantId: 'tenant-b' })).toBe(false);
  });

  it('never lets a scope id match across scope types', () => {
    // A site id that happens to equal a cluster id must not grant cluster access.
    const grants = [grant(PERMISSIONS.nodesManage, 'SITE', 'shared-id')];
    expect(isAllowed(grants, PERMISSIONS.nodesManage, { clusterId: 'shared-id' })).toBe(false);
    expect(isAllowed(grants, PERMISSIONS.nodesManage, { siteId: 'shared-id' })).toBe(true);
  });

  it('combines grants: the widest matching one wins', () => {
    const grants = [
      grant(PERMISSIONS.nodesRead, 'TENANT', 'tenant-a'),
      grant(PERMISSIONS.nodesManage, 'CLUSTER', 'cluster-1'),
    ];
    expect(isAllowed(grants, PERMISSIONS.nodesRead, { tenantId: 'tenant-a' })).toBe(true);
    expect(isAllowed(grants, PERMISSIONS.nodesManage, { tenantId: 'tenant-a' })).toBe(false);
    expect(isAllowed(grants, PERMISSIONS.nodesManage, { clusterId: 'cluster-1' })).toBe(true);
  });

  it('ignores an empty scope id, which would otherwise match a missing target', () => {
    const grants = [grant(PERMISSIONS.nodesRead, 'TENANT', '')];
    expect(isAllowed(grants, PERMISSIONS.nodesRead, { tenantId: '' })).toBe(false);
  });
});

describe('privileged permissions', () => {
  it('treats everything that reaches customer infrastructure as privileged', () => {
    for (const p of [
      PERMISSIONS.clustersManage,
      PERMISSIONS.nodesManage,
      PERMISSIONS.updatesExecute,
      PERMISSIONS.upgradesExecute,
      PERMISSIONS.migrationsExecute,
      PERMISSIONS.credentialsManage,
      PERMISSIONS.credentialsRotate,
      PERMISSIONS.automationManage,
      PERMISSIONS.jobsApprove,
    ]) {
      expect(isPrivilegedPermission(p), `${p} should be privileged`).toBe(true);
    }
  });

  it('treats everything that changes who can do what as privileged', () => {
    for (const p of [
      PERMISSIONS.tenantsManage,
      PERMISSIONS.sitesManage,
      PERMISSIONS.usersManage,
      PERMISSIONS.rolesManage,
      PERMISSIONS.systemManage,
    ]) {
      expect(isPrivilegedPermission(p), `${p} should be privileged`).toBe(true);
    }
  });

  it('does not treat alert handling as privileged, which is a deliberate choice', () => {
    // Acknowledging an alert changes Velnox's own view, not a customer's
    // hypervisor. Suppressing one can hide an incident, which is why it is
    // audited — but not why it would need a second factor.
    expect(isPrivilegedPermission(PERMISSIONS.alertsManage)).toBe(false);
  });

  it('lists every privileged permission in the catalogue', () => {
    for (const p of PRIVILEGED_PERMISSIONS) {
      expect(isPermission(p), `${p} is privileged but not catalogued`).toBe(true);
    }
  });

  it('treats no read permission as privileged', () => {
    for (const p of ALL_PERMISSIONS.filter((x) => x.endsWith('.read'))) {
      expect(isPrivilegedPermission(p), `${p} should not be privileged`).toBe(false);
    }
  });

  it('detects a privileged holder from their grants', () => {
    expect(holdsPrivilegedPermission([grant(PERMISSIONS.nodesRead, 'GLOBAL')])).toBe(false);
    expect(
      holdsPrivilegedPermission([grant(PERMISSIONS.updatesExecute, 'TENANT', 'tenant-a')]),
    ).toBe(true);
  });
});

describe('system roles', () => {
  it('grants the first administrator every permission', () => {
    const role = systemRole(FIRST_ADMINISTRATOR_ROLE);
    expect([...role.permissions].sort()).toEqual([...ALL_PERMISSIONS].sort());
    expect(role.mspOnly).toBe(true);
  });

  it('only references catalogued permissions', () => {
    for (const role of SYSTEM_ROLES) {
      for (const p of role.permissions) {
        expect(isPermission(p), `${role.key} references unknown permission "${p}"`).toBe(true);
      }
    }
  });

  it('gives no read-only role a way to change anything', () => {
    for (const key of ['msp_read_only', 'tenant_read_only'] as const) {
      for (const p of systemRole(key).permissions) {
        expect(p.endsWith('.read'), `${key} has non-read permission ${p}`).toBe(true);
      }
    }
  });

  it('withholds system.manage from everyone except the super administrator', () => {
    for (const role of SYSTEM_ROLES) {
      const hasIt = role.permissions.includes(PERMISSIONS.systemManage);
      expect(hasIt, `${role.key}`).toBe(role.key === 'msp_super_administrator');
    }
  });

  it('withholds identity administration from engineers and operators', () => {
    for (const key of ['msp_engineer', 'tenant_operator'] as const) {
      const permissions = systemRole(key).permissions;
      expect(permissions).not.toContain(PERMISSIONS.usersManage);
      expect(permissions).not.toContain(PERMISSIONS.rolesManage);
    }
  });

  it('withholds the audit log from roles that could be audited by it', () => {
    // An engineer being able to read the record of their own actions is fine;
    // this asserts the deliberate choice, so changing it is a visible decision.
    expect(systemRole('msp_engineer').permissions).not.toContain(PERMISSIONS.auditRead);
    expect(systemRole('tenant_operator').permissions).not.toContain(PERMISSIONS.auditRead);
    expect(systemRole('msp_administrator').permissions).toContain(PERMISSIONS.auditRead);
  });

  it('marks exactly the MSP roles as msp-only', () => {
    for (const role of SYSTEM_ROLES) {
      expect(role.mspOnly, role.key).toBe(role.key.startsWith('msp_'));
    }
  });

  it('has unique keys and names', () => {
    expect(new Set(SYSTEM_ROLES.map((r) => r.key)).size).toBe(SYSTEM_ROLES.length);
    expect(new Set(SYSTEM_ROLES.map((r) => r.name)).size).toBe(SYSTEM_ROLES.length);
  });
});

describe('grantedPermissions', () => {
  it('deduplicates across scopes and sorts', () => {
    expect(
      grantedPermissions([
        grant(PERMISSIONS.nodesRead, 'TENANT', 'a'),
        grant(PERMISSIONS.nodesRead, 'TENANT', 'b'),
        grant(PERMISSIONS.auditRead, 'GLOBAL'),
      ]),
    ).toEqual([PERMISSIONS.auditRead, PERMISSIONS.nodesRead].sort());
  });
});
