import { Injectable } from '@nestjs/common';
import { isPermission, holdsPrivilegedPermission, type Grant, type ScopeType } from '@velnox/shared';
import { PrismaService } from '../infrastructure/prisma.service';

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  status: string;
  tenantId: string;
  tenantName: string;
  mfaEnrolled: boolean;
  /** Whether this account can change customer infrastructure. */
  privileged: boolean;
  /** Grants, with the assignment id so one can be taken away again. */
  roles: { assignmentId: string; roleId: string; name: string; scopeType: string }[];
  lastLoginAt: string | null;
  createdAt: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /** `null` lists every tenant; otherwise only the one named. */
  async list(tenantId: string | null): Promise<UserSummary[]> {
    const users = await this.prisma.client.user.findMany({
      where: { deletedAt: null, ...(tenantId ? { tenantId } : {}) },
      orderBy: [{ displayName: 'asc' }],
      include: {
        tenant: { select: { name: true } },
        roleAssignments: {
          where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
          include: { role: { select: { name: true, permissions: true } } },
        },
      },
    });

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
        mfaEnrolled: user.mfaEnrolled,
        // Surfaced so the users list can recommend a second factor to exactly
        // the accounts whose compromise would be felt outside Velnox.
        privileged: holdsPrivilegedPermission(grants),
        roles: user.roleAssignments
          .map((assignment) => ({
            assignmentId: assignment.id,
            roleId: assignment.roleId,
            name: assignment.role.name,
            scopeType: assignment.scopeType as string,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
        createdAt: user.createdAt.toISOString(),
      };
    });
  }
}
