import { Injectable } from '@nestjs/common';
import type { MfaPolicy, TenantStatus } from '@velnox/db';
import { ERROR_CODES, PERMISSIONS, VelnoxError, uniqueSlug } from '@velnox/shared';
import { PrismaService } from '../infrastructure/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { assertAllowedAt, type Actor } from '../../common/actor';

/**
 * Tenants — the isolation boundary itself.
 *
 * Almost nothing here filters by tenant explicitly, and that is the point: every
 * query below runs through the Prisma tenancy extension, which has already
 * narrowed it to what the caller may reach. A tenant administrator calling
 * `list()` gets their own tenant back from the same code that returns fifty to
 * an MSP administrator, because the filter is applied underneath rather than
 * remembered here.
 *
 * The explicit checks that remain are the ones a filter cannot express: a tenant
 * may not be created by someone whose reach is a single tenant, and the MSP root
 * tenant may never be archived.
 */

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  kind: 'MSP_ROOT' | 'CUSTOMER';
  /** MSP for the MSP organisation; MAIN or SUB for a customer (Phase 5C). */
  level: 'MSP' | 'MAIN' | 'SUB';
  /** The main tenant of a sub-tenant. */
  parentTenantId: string | null;
  parentTenantName: string | null;
  /** Active sub-tenants of a main tenant. */
  subTenantCount: number;
  status: TenantStatus;
  /** The stricter-of-two policy is resolved at sign-in; this is the tenant's own. */
  mfaPolicy: MfaPolicy;
  /** Days this tenant's audit events are kept; null is for ever. */
  auditRetentionDays: number | null;
  userCount: number;
  siteCount: number;
  createdAt: string;
}

export interface TenantInput {
  name: string;
  mfaPolicy?: MfaPolicy;
  /** Create it as a sub-tenant of this main tenant; absent creates a main tenant. */
  parentTenantId?: string;
}

const DESCRIBE_INCLUDE = {
  _count: {
    select: { users: true, sites: true, subTenants: { where: { deletedAt: null } } },
  },
  parentTenant: { select: { name: true } },
} as const;

@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<TenantSummary[]> {
    const tenants = await this.prisma.client.tenant.findMany({
      where: { deletedAt: null },
      include: DESCRIBE_INCLUDE,
      // The MSP organisation first, then customers alphabetically. Sorting by
      // name alone would file the MSP itself somewhere in the middle of its own
      // customer list.
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    });

    return tenants.map((tenant) => this.describe(tenant));
  }

  async get(id: string): Promise<TenantSummary> {
    const tenant = await this.prisma.client.tenant.findFirst({
      where: { id, deletedAt: null },
      include: DESCRIBE_INCLUDE,
    });

    // Out of scope and not existing are the same 404 on purpose: a different
    // answer would confirm that a tenant with this id exists somewhere.
    if (!tenant) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });

    return this.describe(tenant);
  }

  /**
   * Create a customer tenant.
   *
   * Only a caller with a GLOBAL grant can do this, and the check is here rather
   * than only on the decorator because it is not a scope question. `Tenant` has
   * no tenant column, so the extension has nothing to filter a *create* by —
   * this is the one write in the product that the isolation layer cannot see,
   * and it therefore needs saying out loud.
   */
  async create(input: TenantInput, actor: Actor): Promise<TenantSummary> {
    if (!actor.hasGlobalGrant) {
      throw new VelnoxError(ERROR_CODES.authzForbidden, {
        status: 403,
        message: 'Creating a tenant requires a grant at global scope',
        params: { permission: PERMISSIONS.tenantsManage, reason: 'requires_global_scope' },
      });
    }

    const name = input.name.trim();
    const slug = await this.freeSlug(name);

    /*
     * A sub-tenant belongs to an active customer main tenant — not the MSP, not
     * another sub-tenant. The database says the same (two levels, fixed at
     * creation); this gives the reason in words.
     */
    if (input.parentTenantId) {
      const parent = await this.prisma.client.tenant.findFirst({
        where: { id: input.parentTenantId, deletedAt: null },
        select: { kind: true, status: true, parentTenantId: true },
      });
      if (
        !parent ||
        parent.kind !== 'CUSTOMER' ||
        parent.parentTenantId !== null ||
        parent.status !== 'ACTIVE'
      ) {
        throw new VelnoxError(ERROR_CODES.tenantParentInvalid, { status: 400 });
      }
    }

    const tenant = await this.prisma.client.tenant.create({
      data: {
        name,
        slug,
        kind: 'CUSTOMER',
        parentTenantId: input.parentTenantId ?? null,
        settings: input.mfaPolicy ? { mfaPolicy: input.mfaPolicy } : {},
      },
      include: DESCRIBE_INCLUDE,
    });

    await this.audit.success(AUDIT_ACTIONS.tenantCreated, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: tenant.id,
      resourceType: 'tenant',
      resourceId: tenant.id,
      resourceLabel: tenant.name,
      metadata: { slug, ...(input.parentTenantId ? { parentTenantId: input.parentTenantId } : {}) },
    });

    return this.describe(tenant);
  }

  async update(
    id: string,
    input: {
      name?: string;
      status?: TenantStatus;
      mfaPolicy?: MfaPolicy;
      auditRetentionDays?: number | null;
    },
    actor: Actor,
  ): Promise<TenantSummary> {
    const existing = await this.prisma.client.tenant.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });

    assertAllowedAt(actor, PERMISSIONS.tenantsManage, { tenantId: id });

    /*
     * How long a tenant's audit trail is kept is the MSP's decision, never the
     * tenant's own: a customer administrator shortening it would be shortening
     * the record of what they themselves did.
     */
    if (input.auditRetentionDays !== undefined && !actor.isMspRoot) {
      throw new VelnoxError(ERROR_CODES.authzForbidden, {
        status: 403,
        params: { permission: PERMISSIONS.tenantsManage, reason: 'msp_only' },
      });
    }

    /*
     * The MSP organisation cannot be suspended.
     *
     * Suspending it would disable the accounts that administer the installation,
     * including whoever pressed the button. There is no path back from that
     * which does not involve a database prompt, which is exactly the class of
     * mistake the founding administrator rule exists to prevent.
     */
    if (input.status && input.status !== 'ACTIVE') await this.assertNoActiveSubTenants(id);

    if (existing.kind === 'MSP_ROOT' && input.status && input.status !== 'ACTIVE') {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 409,
        message: 'The MSP organisation cannot be suspended or archived',
        params: { reason: 'msp_root' },
      });
    }

    const settings = readSettings(existing.settings);
    if (input.mfaPolicy) settings.mfaPolicy = input.mfaPolicy;

    const tenant = await this.prisma.client.tenant.update({
      where: { id },
      data: {
        ...(input.name ? { name: input.name.trim() } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.mfaPolicy ? { settings } : {}),
        ...(input.auditRetentionDays !== undefined
          ? { auditRetentionDays: input.auditRetentionDays }
          : {}),
      },
    });

    await this.audit.success(AUDIT_ACTIONS.tenantUpdated, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: tenant.id,
      resourceType: 'tenant',
      resourceId: tenant.id,
      resourceLabel: tenant.name,
      metadata: {
        ...(input.name ? { name: tenant.name } : {}),
        ...(input.status ? { status: tenant.status } : {}),
        ...(input.mfaPolicy ? { mfaPolicy: input.mfaPolicy } : {}),
        ...(input.auditRetentionDays !== undefined
          ? { auditRetentionDays: input.auditRetentionDays }
          : {}),
      },
    });

    // Re-read rather than describing the update's own result: the counts come
    // from a relation aggregate that an `update` does not return.
    return this.get(id);
  }

  /**
   * Archive a tenant.
   *
   * Not a delete. A tenant owns users, audit events and — from Phase 4 —
   * infrastructure and credentials, and destroying the row would either cascade
   * through all of that or fail on a foreign key. Neither is what someone means
   * when they stop working with a customer: they mean "stop showing me this",
   * and they mean the audit trail stays readable afterwards.
   *
   * Archiving is reversible. Deleting a customer's history is a thing Velnox
   * deliberately cannot do from the interface.
   */
  async archive(id: string, actor: Actor): Promise<{ id: string; status: TenantStatus }> {
    const tenant = await this.prisma.client.tenant.findFirst({ where: { id, deletedAt: null } });
    if (!tenant) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });

    assertAllowedAt(actor, PERMISSIONS.tenantsManage, { tenantId: id });

    if (tenant.kind === 'MSP_ROOT') {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 409,
        message: 'The MSP organisation cannot be archived',
        params: { reason: 'msp_root' },
      });
    }

    if (id === actor.tenantId) {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 409,
        message: 'You cannot archive the tenant your own account belongs to',
        params: { reason: 'own_tenant' },
      });
    }

    await this.assertNoActiveSubTenants(id);

    const active = await this.prisma.client.user.count({
      where: { tenantId: id, status: 'ACTIVE', deletedAt: null },
    });

    if (active > 0) {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 409,
        message: 'Disable the tenant’s accounts before archiving it',
        params: { reason: 'active_users', count: active },
      });
    }

    await this.prisma.client.tenant.update({
      where: { id },
      data: { status: 'ARCHIVED', deletedAt: new Date() },
    });

    await this.audit.success(AUDIT_ACTIONS.tenantArchived, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: id,
      resourceType: 'tenant',
      resourceId: id,
      resourceLabel: tenant.name,
    });

    return { id, status: 'ARCHIVED' };
  }

  /**
   * A main tenant goes last: suspending or archiving it with sub-tenants still
   * active would leave them reachable through a main tenant nobody can use.
   */
  private async assertNoActiveSubTenants(id: string): Promise<void> {
    const subs = await this.prisma.client.tenant.count({
      where: { parentTenantId: id, deletedAt: null, status: { not: 'ARCHIVED' } },
    });
    if (subs > 0) {
      throw new VelnoxError(ERROR_CODES.tenantHasSubTenants, {
        status: 409,
        params: { count: subs },
      });
    }
  }

  /**
   * A slug nobody else is using.
   *
   * Read-then-write, so two simultaneous creations could still collide on the
   * unique index. That is left to the database rather than papered over with a
   * lock: the loser gets a 409, which is the correct answer to "this name was
   * taken while you were typing".
   */
  private async freeSlug(name: string): Promise<string> {
    const existing = await this.prisma.client.tenant.findMany({ select: { slug: true } });
    return uniqueSlug(name, new Set(existing.map((row) => row.slug)), 'tenant');
  }

  private describe(tenant: {
    id: string;
    name: string;
    slug: string;
    kind: string;
    status: TenantStatus;
    settings: unknown;
    auditRetentionDays: number | null;
    parentTenantId: string | null;
    parentTenant: { name: string } | null;
    createdAt: Date;
    _count: { users: number; sites: number; subTenants: number };
  }): TenantSummary {
    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      kind: tenant.kind === 'MSP_ROOT' ? 'MSP_ROOT' : 'CUSTOMER',
      level: tenant.kind === 'MSP_ROOT' ? 'MSP' : tenant.parentTenantId ? 'SUB' : 'MAIN',
      parentTenantId: tenant.parentTenantId,
      parentTenantName: tenant.parentTenant?.name ?? null,
      subTenantCount: tenant._count.subTenants,
      status: tenant.status,
      mfaPolicy: readSettings(tenant.settings).mfaPolicy ?? 'OPTIONAL',
      auditRetentionDays: tenant.auditRetentionDays,
      userCount: tenant._count.users,
      siteCount: tenant._count.sites,
      createdAt: tenant.createdAt.toISOString(),
    };
  }
}

/** The `settings` column is free-form JSON; this reads the parts Velnox owns. */
function readSettings(value: unknown): { mfaPolicy?: MfaPolicy } & Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}
