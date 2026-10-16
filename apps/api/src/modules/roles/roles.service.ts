import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  PERMISSIONS,
  VelnoxError,
  customRoleProblems,
  isPermission,
  withReadsFor,
  type CustomRoleProblem,
  type Permission,
} from '@velnox/shared';
import { PrismaService } from '../infrastructure/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { assertAllowedAt, type Actor } from '../../common/actor';

/**
 * Roles, as they exist in this installation.
 *
 * The catalogue in `@velnox/shared` says which permissions can exist; these rows
 * say which ones each role actually holds. Reading from the database rather than
 * from the catalogue matters — a role edited later must be reported as it is,
 * not as it was seeded.
 *
 * Custom roles (ADR-054) are made here by the MSP: installation-wide, like the
 * system roles, so a customer's session can see one it may be given. What one
 * may hold is decided by `customRoleProblems`, never here: nothing its maker
 * does not hold, never system settings or making roles, and for a role a
 * customer may be given, no more than a Tenant Administrator.
 */

export interface RoleSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  mspOnly: boolean;
  /** False for a custom role, which the MSP can change and remove. */
  isSystem: boolean;
  /** Only permissions this build still recognises. */
  permissions: Permission[];
  /** Permission strings stored against the role that this build does not know. */
  unknownPermissions: string[];
  assignmentCount: number;
}

export interface CustomRoleInput {
  name: string;
  description?: string | null;
  mspOnly: boolean;
  permissions: string[];
}

const describeProblems = (problems: CustomRoleProblem[]) =>
  problems.map((p) => `${p.permission} (${p.reason})`).join(', ');

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<RoleSummary[]> {
    const roles = await this.prisma.client.role.findMany({
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      include: {
        permissions: true,
        _count: { select: { assignments: true } },
      },
    });

    return roles.map((role) => {
      const stored = role.permissions.map((entry) => entry.permission);

      return {
        id: role.id,
        key: role.key,
        name: role.name,
        description: role.description,
        mspOnly: role.mspOnly,
        isSystem: role.isSystem,
        permissions: stored.filter((permission): permission is Permission =>
          isPermission(permission),
        ),
        /*
         * Reported rather than hidden.
         *
         * A row naming a permission this build does not have is either a
         * downgrade or a bad migration. The guard already ignores such rows when
         * building a principal, so they grant nothing — but silently dropping
         * them from this list would hide the fact that the database and the code
         * disagree.
         */
        unknownPermissions: stored.filter((permission) => !isPermission(permission)),
        assignmentCount: role._count.assignments,
      };
    });
  }

  /** The full catalogue, so the interface can show what a role does not have. */
  catalogue(): Permission[] {
    return [...Object.values(PERMISSIONS)].sort();
  }

  /** Only the MSP makes roles, with `roles.manage` everywhere — not a tenant's. */
  private assertMayMakeRoles(actor: Actor): void {
    if (!actor.isMspRoot) {
      throw new VelnoxError(ERROR_CODES.authzForbidden, {
        status: 403,
        params: { permission: PERMISSIONS.rolesManage },
      });
    }
    assertAllowedAt(actor, PERMISSIONS.rolesManage, {});
  }

  /** What the role will hold, or why it cannot. Reads come with what changes. */
  private validated(input: CustomRoleInput, actor: Actor): Permission[] {
    const first = customRoleProblems(input, actor.grants);
    if (first.length) {
      throw new VelnoxError(ERROR_CODES.roleInvalid, {
        status: 400,
        params: { problems: describeProblems(first) },
      });
    }
    const permissions = withReadsFor(input.permissions.filter(isPermission));
    const added = customRoleProblems({ ...input, permissions }, actor.grants);
    if (added.length) {
      throw new VelnoxError(ERROR_CODES.roleInvalid, {
        status: 400,
        params: { problems: describeProblems(added) },
      });
    }
    return permissions;
  }

  private async assertNameFree(name: string, exceptId?: string): Promise<void> {
    const same = await this.prisma.client.role.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (same) {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 409,
        message: 'Another role has that name',
        params: { field: 'name' },
      });
    }
  }

  private async customRole(id: string) {
    const role = await this.prisma.client.role.findUnique({
      where: { id },
      include: { permissions: true, assignments: { select: { userId: true } } },
    });
    if (!role) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    if (role.isSystem) {
      throw new VelnoxError(ERROR_CODES.roleSystem, { status: 409, params: { role: role.name } });
    }
    return role;
  }

  async create(input: CustomRoleInput, actor: Actor): Promise<RoleSummary> {
    this.assertMayMakeRoles(actor);
    const permissions = this.validated(input, actor);
    const name = input.name.trim();
    await this.assertNameFree(name);

    const role = await this.prisma.client.role.create({
      data: {
        key: `custom_${randomUUID().slice(0, 8)}`,
        name,
        description: input.description?.trim() || null,
        isSystem: false,
        mspOnly: input.mspOnly,
        tenantId: null,
        permissions: { create: permissions.map((permission) => ({ permission })) },
      },
    });

    await this.audit.success(AUDIT_ACTIONS.roleCreated, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      resourceType: 'role',
      resourceId: role.id,
      resourceLabel: role.name,
      metadata: { mspOnly: role.mspOnly, permissions },
    });
    return this.summary(role.id);
  }

  async update(id: string, input: CustomRoleInput, actor: Actor): Promise<RoleSummary> {
    this.assertMayMakeRoles(actor);
    const role = await this.customRole(id);
    const permissions = this.validated(input, actor);
    const name = input.name.trim();
    await this.assertNameFree(name, id);

    // Made MSP-only while a customer's account holds it would leave a grant
    // the database refuses for every new one.
    if (input.mspOnly && !role.mspOnly && role.assignments.length) {
      const outside = await this.prisma.client.user.count({
        where: {
          id: { in: role.assignments.map((a) => a.userId) },
          tenant: { kind: { not: 'MSP_ROOT' } },
        },
      });
      if (outside > 0) {
        throw new VelnoxError(ERROR_CODES.roleInUse, {
          status: 409,
          params: { count: outside, reason: 'customers' },
        });
      }
    }

    const before = role.permissions.map((p) => p.permission).sort();
    await this.prisma.client.$transaction([
      this.prisma.client.rolePermission.deleteMany({ where: { roleId: id } }),
      this.prisma.client.role.update({
        where: { id },
        data: {
          name,
          description: input.description?.trim() || null,
          mspOnly: input.mspOnly,
          permissions: { create: permissions.map((permission) => ({ permission })) },
        },
      }),
      // Tokens already issued were built from the role as it was.
      this.prisma.client.user.updateMany({
        where: { id: { in: role.assignments.map((a) => a.userId) } },
        data: { tokenVersion: { increment: 1 } },
      }),
    ]);

    await this.audit.success(AUDIT_ACTIONS.roleUpdated, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      resourceType: 'role',
      resourceId: id,
      resourceLabel: name,
      metadata: {
        mspOnly: input.mspOnly,
        added: permissions.filter((p) => !before.includes(p)),
        removed: before.filter((p) => !(permissions as string[]).includes(p)),
      },
    });
    return this.summary(id);
  }

  async remove(id: string, actor: Actor): Promise<void> {
    this.assertMayMakeRoles(actor);
    const role = await this.customRole(id);
    if (role.assignments.length) {
      throw new VelnoxError(ERROR_CODES.roleInUse, {
        status: 409,
        params: { count: role.assignments.length, reason: 'assigned' },
      });
    }
    await this.prisma.client.role.delete({ where: { id } });
    await this.audit.success(AUDIT_ACTIONS.roleDeleted, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      resourceType: 'role',
      resourceId: id,
      resourceLabel: role.name,
      metadata: { permissions: role.permissions.map((p) => p.permission).sort() },
    });
  }

  private async summary(id: string): Promise<RoleSummary> {
    const role = (await this.list()).find((r) => r.id === id);
    if (!role) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    return role;
  }
}
