import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CrossTenantWriteError,
  MissingTenantScopeError,
  newTenancyHolder,
  runWithTenancy,
  scopeQueryArgs,
  setTenantScope,
  tenantScopedModels,
  withSystemScope,
} from './tenancy';

/**
 * The isolation boundary, tested without a database.
 *
 * `scopeQueryArgs` is the whole decision as a pure function, which is what makes
 * this possible: every case below is a question about what a query is rewritten
 * to, and none of them needs Postgres to answer.
 *
 * There is a second, slower test that *does* need a database — `verify-stack.sh`
 * signs in as two tenants and checks that neither can read the other. This file
 * is the one that runs on every commit.
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

/** Run something as a principal scoped to these tenants. */
const asTenants = <T>(tenantIds: string[], fn: () => T): T =>
  runWithTenancy(newTenancyHolder(), () => {
    setTenantScope({ kind: 'tenants', tenantIds });
    return fn();
  });

/** Run something as a principal with a global grant. */
const asGlobal = <T>(fn: () => T): T =>
  runWithTenancy(newTenancyHolder(), () => {
    setTenantScope({ kind: 'all' });
    return fn();
  });

describe('with no scope resolved', () => {
  it('refuses a query against a tenant-scoped model', () => {
    // Outside any request at all — a script, a forgotten job, a test.
    expect(() => scopeQueryArgs('User', 'findMany', {})).toThrow(MissingTenantScopeError);
  });

  it('refuses it inside a request that has not authenticated yet', () => {
    // The middleware has installed a holder; the guard has not filled it in.
    // This is the state every request is in before authentication, and it is the
    // one that makes a forgotten permission check harmless.
    runWithTenancy(newTenancyHolder(), () => {
      expect(() => scopeQueryArgs('Tenant', 'findMany', {})).toThrow(MissingTenantScopeError);
    });
  });

  it('lets a model that is not tenant-scoped through', () => {
    // Sessions, MFA factors and the settings singleton belong to no tenant.
    expect(scopeQueryArgs('Session', 'findMany', { where: { id: 'x' } })).toEqual({
      where: { id: 'x' },
    });
  });

  it('names the model and the operation, so the fix is obvious from the message', () => {
    try {
      scopeQueryArgs('Credential', 'deleteMany', {});
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MissingTenantScopeError);
      expect((error as Error).message).toContain('Credential.deleteMany');
      expect((error as Error).message).toContain('withSystemScope');
    }
  });
});

describe('withSystemScope', () => {
  it('runs unfiltered', async () => {
    const args = await withSystemScope('a test', async () =>
      scopeQueryArgs('User', 'findMany', { where: { status: 'ACTIVE' } }),
    );
    expect(args).toEqual({ where: { status: 'ACTIVE' } });
  });

  it('does not leak out of its callback', async () => {
    await withSystemScope('a test', async () => undefined);
    expect(() => scopeQueryArgs('User', 'findMany', {})).toThrow(MissingTenantScopeError);
  });

  it('is not affected by an outer tenant scope', async () => {
    await asTenants([TENANT_A], async () => {
      const args = await withSystemScope('deliberately crossing', async () =>
        scopeQueryArgs('User', 'findMany', {}),
      );
      expect(args).toEqual({});
    });
  });
});

describe('a principal with a global grant', () => {
  it('is not filtered', () => {
    asGlobal(() => {
      expect(scopeQueryArgs('User', 'findMany', { where: { status: 'ACTIVE' } })).toEqual({
        where: { status: 'ACTIVE' },
      });
    });
  });

  it('may write into any tenant', () => {
    asGlobal(() => {
      expect(() =>
        scopeQueryArgs('User', 'create', { data: { tenantId: TENANT_B } }),
      ).not.toThrow();
    });
  });
});

describe('a principal scoped to one tenant', () => {
  it('has the scope appended to its filter', () => {
    asTenants([TENANT_A], () => {
      expect(scopeQueryArgs('User', 'findMany', { where: { status: 'ACTIVE' } })).toEqual({
        where: { status: 'ACTIVE', AND: [{ tenantId: { in: [TENANT_A] } }] },
      });
    });
  });

  it('keeps the unique field at the top level of a findUnique', () => {
    // Prisma requires a unique field at the top of `where`. Nesting the caller's
    // `{id}` inside an AND produces "Argument where needs at least one of id",
    // which is how this was first written and how it first broke.
    asTenants([TENANT_A], () => {
      const args = scopeQueryArgs('Site', 'findUnique', { where: { id: 'site-1' } }) as {
        where: Record<string, unknown>;
      };
      expect(args.where.id).toBe('site-1');
      expect(args.where.AND).toEqual([{ tenantId: { in: [TENANT_A] } }]);
    });
  });

  it('appends to an AND the caller already supplied rather than replacing it', () => {
    // Replacing it would drop the caller's own condition, which *widens* their
    // query — the one direction a security filter must never move.
    asTenants([TENANT_A], () => {
      const args = scopeQueryArgs('User', 'findMany', {
        where: { AND: [{ status: 'ACTIVE' }] },
      }) as { where: { AND: unknown[] } };

      expect(args.where.AND).toEqual([{ status: 'ACTIVE' }, { tenantId: { in: [TENANT_A] } }]);
    });
  });

  it('cannot be widened by a caller-supplied OR', () => {
    asTenants([TENANT_A], () => {
      const args = scopeQueryArgs('User', 'findMany', {
        where: { OR: [{ tenantId: TENANT_B }, { tenantId: TENANT_A }] },
      }) as { where: Record<string, unknown> };

      // The OR stays where it was and the scope sits beside it. Prisma combines
      // top-level keys with AND, so the result is "their condition and ours".
      expect(args.where.OR).toHaveLength(2);
      expect(args.where.AND).toEqual([{ tenantId: { in: [TENANT_A] } }]);
    });
  });

  it('scopes a Tenant query by primary key rather than by a tenant column', () => {
    asTenants([TENANT_A], () => {
      expect(scopeQueryArgs('Tenant', 'findMany', {})).toEqual({
        where: { AND: [{ id: { in: [TENANT_A] } }] },
      });
    });
  });

  it('scopes role assignments through the account they are on', () => {
    // Not through `role_assignments.tenant_id`, which is null for a GLOBAL grant
    // — filtering on that column would show every MSP-wide grant to every
    // tenant.
    asTenants([TENANT_A], () => {
      expect(scopeQueryArgs('RoleAssignment', 'findMany', {})).toEqual({
        where: { AND: [{ user: { tenantId: { in: [TENANT_A] } } }] },
      });
    });
  });

  it('leaves installation-wide roles and credentials visible', () => {
    asTenants([TENANT_A], () => {
      const roles = scopeQueryArgs('Role', 'findMany', {}) as { where: { AND: unknown[] } };
      expect(roles.where.AND).toEqual([
        { OR: [{ tenantId: null }, { tenantId: { in: [TENANT_A] } }] },
      ]);
    });
  });

  it('does not leave installation-wide audit events visible', () => {
    // The opposite rule to roles, deliberately: an audit event with no tenant is
    // an installation-level event — an MSP administrator signing in — and a
    // customer has no business reading it.
    asTenants([TENANT_A], () => {
      expect(scopeQueryArgs('AuditEvent', 'findMany', {})).toEqual({
        where: { AND: [{ tenantId: { in: [TENANT_A] } }] },
      });
    });
  });

  it('refuses a write into another tenant', () => {
    asTenants([TENANT_A], () => {
      expect(() => scopeQueryArgs('User', 'create', { data: { tenantId: TENANT_B } })).toThrow(
        CrossTenantWriteError,
      );
    });
  });

  it('refuses a write that names the other tenant through a relation', () => {
    // `{ tenant: { connect: { id } } }` says the same thing in a shape a check
    // on `data.tenantId` alone would not see.
    asTenants([TENANT_A], () => {
      expect(() =>
        scopeQueryArgs('Site', 'create', { data: { tenant: { connect: { id: TENANT_B } } } }),
      ).toThrow(CrossTenantWriteError);
    });
  });

  it('refuses a createMany where any one row is out of scope', () => {
    asTenants([TENANT_A], () => {
      expect(() =>
        scopeQueryArgs('Site', 'createMany', {
          data: [{ tenantId: TENANT_A }, { tenantId: TENANT_B }],
        }),
      ).toThrow(CrossTenantWriteError);
    });
  });

  it('refuses an update that would move a row into another tenant', () => {
    asTenants([TENANT_A], () => {
      expect(() =>
        scopeQueryArgs('Site', 'update', {
          where: { id: 'site-1' },
          data: { tenantId: TENANT_B },
        }),
      ).toThrow(CrossTenantWriteError);
    });
  });

  it('allows a write into a tenant it does reach', () => {
    asTenants([TENANT_A, TENANT_B], () => {
      expect(() =>
        scopeQueryArgs('User', 'create', { data: { tenantId: TENANT_B } }),
      ).not.toThrow();
    });
  });
});

describe('a principal whose grants resolve to no tenant at all', () => {
  it('sees nothing rather than everything', () => {
    // The expensive failure mode this design exists to avoid: an empty list
    // treated as "no filter". `{ in: [] }` matches no rows in Prisma.
    asTenants([], () => {
      expect(scopeQueryArgs('User', 'findMany', {})).toEqual({
        where: { AND: [{ tenantId: { in: [] } }] },
      });
    });
  });

  it('cannot write anywhere', () => {
    asTenants([], () => {
      expect(() => scopeQueryArgs('User', 'create', { data: { tenantId: TENANT_A } })).toThrow(
        CrossTenantWriteError,
      );
    });
  });
});

describe('the scoped model list against the schema', () => {
  /**
   * A model with a tenant column that nobody added to `TENANT_SCOPED` is an
   * isolation hole that compiles, passes review and ships. This reads the schema
   * and refuses to let that happen quietly.
   *
   * The exemptions are listed by name rather than inferred, so adding one is a
   * decision somebody makes in a diff.
   */
  const EXEMPT = new Set([
    // Its client secret is installation-wide; `default_tenant_id` is which
    // tenant auto-provisioned users land in, not which tenant may read the row.
    'IdentityProvider',
  ]);

  const schema = readFileSync(join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');

  /** Every `model X { ... }` block, as a name and its body. */
  const models = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map((match) => ({
    name: match[1] ?? '',
    body: match[2] ?? '',
  }));

  it('found the models to check', () => {
    // A regex that silently matches nothing would make every assertion below
    // pass for the wrong reason.
    expect(models.length).toBeGreaterThan(10);
  });

  it('accounts for every model carrying a tenant column', () => {
    const scoped = new Set(tenantScopedModels());

    const unaccounted = models
      .filter((model) => /^\s*tenantId\s/m.test(model.body))
      .map((model) => model.name)
      .filter((name) => !scoped.has(name) && !EXEMPT.has(name));

    expect(unaccounted).toEqual([]);
  });

  it('scopes the Tenant model itself', () => {
    // It has no tenant column — it *is* the tenant — so the rule above would
    // never catch it going missing.
    expect(tenantScopedModels()).toContain('Tenant');
  });
});
