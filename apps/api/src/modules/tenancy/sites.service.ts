import { Injectable } from '@nestjs/common';
import { ERROR_CODES, PERMISSIONS, VelnoxError, uniqueSlug } from '@velnox/shared';
import { PrismaService } from '../infrastructure/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { assertAllowedAt, type Actor } from '../../common/actor';

/**
 * Sites — a location inside a tenant.
 *
 * A site is what makes a grant narrower than a whole customer, and from Phase 4
 * it is where clusters hang. Both of those are why it carries a tenant: a site
 * belongs to exactly one, and moving one between tenants is deliberately not
 * possible — it would silently move every grant scoped to it, and every cluster
 * beneath it, into another customer.
 */

export interface SiteSummary {
  id: string;
  tenantId: string;
  tenantName: string;
  name: string;
  slug: string;
  description: string | null;
  locality: string | null;
  country: string | null;
  timezone: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  /** Grants scoped to this site. Shown so deleting one is not a surprise. */
  grantCount: number;
  createdAt: string;
}

export interface SiteInput {
  tenantId: string;
  name: string;
  description?: string | null;
  locality?: string | null;
  country?: string | null;
  timezone?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
}

@Injectable()
export class SitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * `tenantId` narrows; it never widens. The extension has already limited the
   * query to what the caller may reach, so an id they cannot see returns nothing
   * rather than someone else's sites.
   */
  async list(tenantId?: string): Promise<SiteSummary[]> {
    const sites = await this.prisma.client.site.findMany({
      where: { deletedAt: null, ...(tenantId ? { tenantId } : {}) },
      include: { tenant: { select: { name: true } } },
      orderBy: [{ name: 'asc' }],
    });

    const grantCounts = await this.countGrantsFor(sites.map((site) => site.id));

    return sites.map((site) => this.describe(site, grantCounts.get(site.id) ?? 0));
  }

  async get(id: string): Promise<SiteSummary> {
    const site = await this.prisma.client.site.findFirst({
      where: { id, deletedAt: null },
      include: { tenant: { select: { name: true } } },
    });
    if (!site) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });

    const grantCounts = await this.countGrantsFor([site.id]);
    return this.describe(site, grantCounts.get(site.id) ?? 0);
  }

  async create(input: SiteInput, actor: Actor): Promise<SiteSummary> {
    // The tenant comes from the request here — unlike everywhere else — because
    // an MSP engineer legitimately creates sites for a customer. It is checked
    // twice: the grant must cover that tenant, and the tenancy extension refuses
    // the write outright if it is out of scope.
    assertAllowedAt(actor, PERMISSIONS.sitesManage, { tenantId: input.tenantId });

    const tenant = await this.prisma.client.tenant.findFirst({
      where: { id: input.tenantId, deletedAt: null },
    });
    if (!tenant) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });

    const name = input.name.trim();
    const slug = await this.freeSlug(input.tenantId, name);

    const site = await this.prisma.client.site.create({
      data: {
        tenantId: input.tenantId,
        name,
        slug,
        description: trimmed(input.description),
        locality: trimmed(input.locality),
        country: trimmed(input.country)?.toUpperCase() ?? null,
        timezone: trimmed(input.timezone),
        contactName: trimmed(input.contactName),
        contactEmail: trimmed(input.contactEmail)?.toLowerCase() ?? null,
        contactPhone: trimmed(input.contactPhone),
      },
      include: { tenant: { select: { name: true } } },
    });

    await this.audit.success(AUDIT_ACTIONS.siteCreated, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: site.tenantId,
      resourceType: 'site',
      resourceId: site.id,
      resourceLabel: site.name,
      metadata: { slug },
    });

    return this.describe(site, 0);
  }

  async update(id: string, input: Partial<Omit<SiteInput, 'tenantId'>>, actor: Actor) {
    const existing = await this.prisma.client.site.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });

    assertAllowedAt(actor, PERMISSIONS.sitesManage, {
      tenantId: existing.tenantId,
      siteId: existing.id,
    });

    const site = await this.prisma.client.site.update({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...pick(input, 'description', 'locality', 'timezone', 'contactName', 'contactPhone'),
        ...(input.country === undefined
          ? {}
          : { country: trimmed(input.country)?.toUpperCase() ?? null }),
        ...(input.contactEmail === undefined
          ? {}
          : { contactEmail: trimmed(input.contactEmail)?.toLowerCase() ?? null }),
      },
      include: { tenant: { select: { name: true } } },
    });

    await this.audit.success(AUDIT_ACTIONS.siteUpdated, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: site.tenantId,
      resourceType: 'site',
      resourceId: site.id,
      resourceLabel: site.name,
      metadata: { fields: Object.keys(input).sort().join(',') },
    });

    const grantCounts = await this.countGrantsFor([site.id]);
    return this.describe(site, grantCounts.get(site.id) ?? 0);
  }

  /**
   * Remove a site.
   *
   * Refused while a grant is scoped to it. Deleting the site would leave role
   * assignments pointing at nothing: the `scope_id` column is polymorphic, so no
   * foreign key can catch it, and the grants would quietly stop covering
   * anything at all. A permission that silently becomes inert is worse than one
   * that was never given, because nobody goes looking for it.
   */
  async remove(id: string, actor: Actor): Promise<{ id: string }> {
    const site = await this.prisma.client.site.findFirst({ where: { id, deletedAt: null } });
    if (!site) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });

    assertAllowedAt(actor, PERMISSIONS.sitesManage, { tenantId: site.tenantId, siteId: site.id });

    const grants = await this.prisma.client.roleAssignment.count({
      where: { scopeType: 'SITE', scopeId: id },
    });

    if (grants > 0) {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 409,
        message: 'Revoke the grants scoped to this site before removing it',
        params: { reason: 'site_has_grants', count: grants },
      });
    }

    await this.prisma.client.site.update({ where: { id }, data: { deletedAt: new Date() } });

    await this.audit.success(AUDIT_ACTIONS.siteDeleted, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: site.tenantId,
      resourceType: 'site',
      resourceId: site.id,
      resourceLabel: site.name,
    });

    return { id };
  }

  /** How many grants each of these sites carries, in one query rather than N. */
  private async countGrantsFor(siteIds: string[]): Promise<Map<string, number>> {
    if (siteIds.length === 0) return new Map();

    const rows = await this.prisma.client.roleAssignment.groupBy({
      by: ['scopeId'],
      where: { scopeType: 'SITE', scopeId: { in: siteIds } },
      _count: { _all: true },
    });

    return new Map(
      rows
        .filter((row): row is typeof row & { scopeId: string } => row.scopeId !== null)
        .map((row) => [row.scopeId, row._count._all]),
    );
  }

  private async freeSlug(tenantId: string, name: string): Promise<string> {
    const existing = await this.prisma.client.site.findMany({
      where: { tenantId },
      select: { slug: true },
    });
    return uniqueSlug(name, new Set(existing.map((row) => row.slug)), 'site');
  }

  private describe(
    site: {
      id: string;
      tenantId: string;
      name: string;
      slug: string;
      description: string | null;
      locality: string | null;
      country: string | null;
      timezone: string | null;
      contactName: string | null;
      contactEmail: string | null;
      contactPhone: string | null;
      createdAt: Date;
      tenant: { name: string };
    },
    grantCount: number,
  ): SiteSummary {
    return {
      id: site.id,
      tenantId: site.tenantId,
      tenantName: site.tenant.name,
      name: site.name,
      slug: site.slug,
      description: site.description,
      locality: site.locality,
      // Stored as CHAR(2), which pads. Nobody wants "NL " in a table cell.
      country: site.country?.trim() || null,
      timezone: site.timezone,
      contactName: site.contactName,
      contactEmail: site.contactEmail,
      contactPhone: site.contactPhone,
      grantCount,
      createdAt: site.createdAt.toISOString(),
    };
  }
}

const trimmed = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  return text === '' ? null : text;
};

/** Copy only the keys that were actually sent, so a PATCH does not blank a field. */
function pick<T extends object, K extends keyof T>(input: T, ...keys: K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const key of keys) {
    if (input[key] !== undefined) out[key] = trimmed(input[key] as string | null) as T[K];
  }
  return out;
}
