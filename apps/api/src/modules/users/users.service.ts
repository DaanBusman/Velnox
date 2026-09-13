import { Injectable } from '@nestjs/common';
import {
  isPermission,
  holdsPrivilegedPermission,
  type Grant,
  type ScopeType,
} from '@velnox/shared';
import { PrismaService } from '../infrastructure/prisma.service';

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  status: string;
  tenantId: string;
  tenantName: string;
  /**
   * Whether this account lives in the MSP organisation rather than a customer's.
   *
   * The users list groups by it and the second-factor reset is gated on it, so
   * it is reported rather than inferred from the tenant name — which an operator
   * can rename to anything.
   */
  tenantIsMspRoot: boolean;
  mfaEnrolled: boolean;
  /** The account setup created. Its roles cannot be revoked by anyone. */
  isFoundingAdministrator: boolean;
  /** Whether this account can change customer infrastructure. */
  privileged: boolean;
  /**
   * Grants, with the assignment id so one can be taken away again.
   *
   * Each carries the scope it covers and a label for it, because "MSP Engineer"
   * says nothing useful on its own once grants can be narrower than everything:
   * the interesting half of a grant is which customer it reaches.
   */
  roles: {
    assignmentId: string;
    roleId: string;
    name: string;
    scopeType: string;
    scopeId: string | null;
    /** The tenant or site the scope names. Null for a global grant. */
    scopeLabel: string | null;
  }[];
  lastLoginAt: string | null;
  createdAt: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `null` lists every tenant the caller may reach; an id narrows it to one.
   *
   * Narrows, never widens — the tenancy extension has already limited the query
   * before this filter is applied.
   */
  async list(tenantId: string | null): Promise<UserSummary[]> {
    const users = await this.prisma.client.user.findMany({
      where: { deletedAt: null, ...(tenantId ? { tenantId } : {}) },
      orderBy: [{ displayName: 'asc' }],
      include: {
        tenant: { select: { name: true, kind: true } },
        roleAssignments: {
          where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
          include: { role: { select: { name: true, permissions: true } } },
        },
      },
    });

    const scopeLabels = await this.labelScopes(users.flatMap((user) => user.roleAssignments));

    return users.map((user) => {
      const grants: Grant[] = [];
      for (const assignment of user.roleAssignments) {
        for (const { permission } of assignment.role.permissions) {
          if (!isPermission(permission)) continue;
          grants.push({
            permission,
            scopeType: assignment.scopeType as ScopeType,
            scopeId: assignment.scopeId,
          });
        }
      }

      return {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        status: user.status,
        tenantId: user.tenantId,
        tenantName: user.tenant.name,
        tenantIsMspRoot: user.tenant.kind === 'MSP_ROOT',
        mfaEnrolled: user.mfaEnrolled,
        isFoundingAdministrator: user.isFoundingAdministrator,
        // Surfaced so the users list can recommend a second factor to exactly
        // the accounts whose compromise would be felt outside Velnox.
        privileged: holdsPrivilegedPermission(grants),
        roles: user.roleAssignments
          .map((assignment) => ({
            assignmentId: assignment.id,
            roleId: assignment.roleId,
            name: assignment.role.name,
            scopeType: assignment.scopeType as string,
            scopeId: assignment.scopeId,
            scopeLabel: assignment.scopeId ? (scopeLabels.get(assignment.scopeId) ?? null) : null,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
        createdAt: user.createdAt.toISOString(),
      };
    });
  }

  /**
   * Names for the scopes these grants point at.
   *
   * Two queries for the whole page rather than one per grant. Both run through
   * the scoped client, so a scope the caller cannot reach comes back unlabelled
   * rather than leaking the name of a tenant they cannot see — which matters,
   * because a grant row can name a tenant the reader has no access to.
   */
  private async labelScopes(
    assignments: { scopeType: string; scopeId: string | null }[],
  ): Promise<Map<string, string>> {
    const tenantIds = ids(assignments, 'TENANT');
    const siteIds = ids(assignments, 'SITE');
    if (tenantIds.length === 0 && siteIds.length === 0) return new Map();

    const [tenants, sites] = await Promise.all([
      tenantIds.length
        ? this.prisma.client.tenant.findMany({
            where: { id: { in: tenantIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      siteIds.length
        ? this.prisma.client.site.findMany({
            where: { id: { in: siteIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);

    return new Map([...tenants, ...sites].map((row) => [row.id, row.name]));
  }
}

const ids = (
  assignments: { scopeType: string; scopeId: string | null }[],
  scopeType: string,
): string[] => [
  ...new Set(
    assignments
      .filter((a) => a.scopeType === scopeType && a.scopeId !== null)
      .map((a) => a.scopeId as string),
  ),
];
