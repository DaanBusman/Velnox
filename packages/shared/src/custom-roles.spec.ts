import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  CUSTOMER_ASSIGNABLE,
  NEVER_IN_CUSTOM_ROLE,
  PERMISSIONS as P,
  customRoleProblems,
  permissionAreas,
  permissionsBeyondGrantor,
  systemRole,
  withReadsFor,
  type Grant,
  type Permission,
} from './index';

const global = (permissions: readonly Permission[]): Grant[] =>
  permissions.map((permission) => ({ permission, scopeType: 'GLOBAL', scopeId: null }));
const mspAdministrator = global(systemRole('msp_administrator').permissions);

describe('custom roles: what a role may hold', () => {
  it('never system settings or making roles, whoever makes it', () => {
    const superAdmin = global(ALL_PERMISSIONS);
    for (const permission of NEVER_IN_CUSTOM_ROLE) {
      expect(customRoleProblems({ permissions: [permission], mspOnly: true }, superAdmin)).toEqual([
        { reason: 'never', permission },
      ]);
    }
  });

  it('nothing its maker does not hold — an MSP Administrator cannot hand out support.manage', () => {
    expect(
      customRoleProblems(
        { permissions: [P.supportManage, P.clustersRead], mspOnly: true },
        mspAdministrator,
      ),
    ).toEqual([{ reason: 'not_held', permission: P.supportManage }]);
  });

  it('a grant at TENANT scope does not count: custom roles are installation-wide', () => {
    const tenantOnly: Grant[] = [
      { permission: P.clustersManage, scopeType: 'TENANT', scopeId: 't' },
    ];
    expect(
      customRoleProblems({ permissions: [P.clustersManage], mspOnly: true }, tenantOnly),
    ).toEqual([{ reason: 'not_held', permission: P.clustersManage }]);
  });

  it('for customers, no more than a Tenant Administrator — never the MSP-wide library', () => {
    expect(
      customRoleProblems(
        { permissions: [P.libraryManage, P.clustersManage], mspOnly: false },
        mspAdministrator,
      ),
    ).toEqual([{ reason: 'not_for_customers', permission: P.libraryManage }]);
    expect(
      customRoleProblems({ permissions: [P.libraryManage], mspOnly: true }, mspAdministrator),
    ).toEqual([]);
    expect(CUSTOMER_ASSIGNABLE).not.toContain(P.rolesManage);
    expect(CUSTOMER_ASSIGNABLE).not.toContain(P.tenantsManage);
  });

  it('a permission that does not exist is named, not dropped', () => {
    expect(
      customRoleProblems({ permissions: ['clusters.destroy'], mspOnly: true }, mspAdministrator),
    ).toEqual([{ reason: 'unknown', permission: 'clusters.destroy' }]);
  });
});

describe('custom roles: areas and levels', () => {
  it('covers every permission a custom role can hold, once', () => {
    const areas = permissionAreas();
    const listed = areas.flatMap((a) => [...(a.read ? [a.read] : []), ...a.changes]);
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.sort()).toEqual(
      ALL_PERMISSIONS.filter((p) => !NEVER_IN_CUSTOM_ROLE.includes(p)).sort(),
    );
  });

  it('"can change" includes seeing', () => {
    expect(withReadsFor([P.updatesExecute])).toEqual([P.updatesRead, P.updatesExecute]);
    expect(withReadsFor([P.clustersRead])).toEqual([P.clustersRead]);
  });
});

describe('granting a role: nothing beyond the grantor', () => {
  it('an MSP Administrator cannot make anyone MSP Super Administrator', () => {
    expect(
      permissionsBeyondGrantor(
        systemRole('msp_super_administrator').permissions,
        mspAdministrator,
        {},
      ),
    ).toEqual(expect.arrayContaining([P.systemManage, P.usersResetMfaMsp, P.supportManage]));
  });

  it('but can grant what it holds, at any tenant', () => {
    expect(
      permissionsBeyondGrantor(systemRole('tenant_administrator').permissions, mspAdministrator, {
        tenantId: 't',
      }),
    ).toEqual([]);
  });

  it('a tenant administrator can grant its own role in its own tenant, not elsewhere', () => {
    const tenantAdmin: Grant[] = systemRole('tenant_administrator').permissions.map(
      (permission) => ({
        permission,
        scopeType: 'TENANT',
        scopeId: 'a',
      }),
    );
    const role = systemRole('tenant_operator').permissions;
    expect(permissionsBeyondGrantor(role, tenantAdmin, { tenantId: 'a' })).toEqual([]);
    expect(permissionsBeyondGrantor(role, tenantAdmin, { tenantId: 'b' })).toEqual(role);
  });
});
