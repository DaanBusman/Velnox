import { Injectable } from '@nestjs/common';
import { checkPasswordStrength, hashPassword } from '@velnox/crypto';
import { ERROR_CODES, PERMISSIONS, VelnoxError } from '@velnox/shared';
import { PrismaService } from '../infrastructure/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { SessionService } from '../auth/session.service';

/**
 * Creating and changing accounts.
 *
 * Kept apart from `UsersService`, which only reads. The read path is used by any
 * page that lists people; this one changes who can sign in, and every method
 * here writes an audit record.
 *
 * There is no invitation email, because Velnox sends no email yet. An
 * administrator sets an initial password and passes it on out of band, which is
 * honest about what the product does rather than pretending a mail server
 * exists.
 */

export interface Actor {
  id: string;
  email: string;
  tenantId: string;
  isMspRoot: boolean;
}

@Injectable()
export class UserAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  async create(
    input: { email: string; displayName: string; password: string; tenantId?: string },
    actor: Actor,
  ) {
    const email = input.email.trim().toLowerCase();

    const strength = checkPasswordStrength(input.password, { email });
    if (!strength.ok) {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 400,
        message: 'Password does not meet the minimum strength requirement',
        params: { problems: strength.problems.join(',') },
      });
    }

    const existing = await this.prisma.client.user.findUnique({ where: { email } });
    if (existing) {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 409,
        message: 'An account with that email address already exists',
        params: { field: 'email' },
      });
    }

    /*
     * The tenant comes from the actor unless they are MSP root.
     *
     * Taking it from the request would let anyone who can create a user place
     * that user in someone else's tenant. Proper cross-tenant delegation arrives
     * with multi-tenancy; until then the strict rule applies.
     */
    const tenantId =
      actor.isMspRoot && input.tenantId ? input.tenantId : actor.tenantId;

    const user = await this.prisma.client.user.create({
      data: {
        email,
        displayName: input.displayName.trim(),
        tenantId,
        passwordHash: await hashPassword(input.password),
        passwordUpdatedAt: new Date(),
        status: 'ACTIVE',
      },
    });

    await this.audit.success(AUDIT_ACTIONS.userCreated, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId,
      resourceType: 'user',
      resourceId: user.id,
      resourceLabel: user.email,
    });

    return { id: user.id, email: user.email, displayName: user.displayName };
  }

  /**
   * Enable or disable an account.
   *
   * Disabling revokes every session the account holds, or it would keep working
   * until its tokens expired — which is up to eight hours of continued access
   * after someone decided it should stop.
   */
  async setStatus(userId: string, status: 'ACTIVE' | 'DISABLED', actor: Actor) {
    if (userId === actor.id && status === 'DISABLED') {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 409,
        message: 'You cannot disable your own account',
        params: { reason: 'self' },
      });
    }

    const user = await this.prisma.client.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) {
      throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    }

    this.assertSameTenant(user.tenantId, actor);

    /*
     * Disabling the founding administrator is allowed, but not when they are the
     * last way in.
     *
     * Their grants cannot be taken away, so the account is the recovery path for
     * the whole installation. Disabling it while nobody else can administer
     * anything reproduces the lockout by a different route.
     */
    if (user.isFoundingAdministrator && status === 'DISABLED') {
      const otherAdmins = await this.countOtherEnabledAdministrators(user.id);
      if (otherAdmins === 0) {
        throw new VelnoxError(ERROR_CODES.authzFoundingAdministrator, {
          status: 409,
          message:
            'The founding administrator cannot be disabled while no other enabled account can administer this installation',
          params: { reason: 'last_administrator' },
        });
      }
    }

    await this.prisma.client.user.update({
      where: { id: userId },
      // The version bump invalidates every access token already issued, without
      // needing a revocation list.
      data: { status, tokenVersion: { increment: 1 } },
    });

    if (status === 'DISABLED') {
      await this.sessions.revokeAllForUser(userId, 'account_disabled');
    }

    await this.audit.success(AUDIT_ACTIONS.userUpdated, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: user.tenantId,
      resourceType: 'user',
      resourceId: user.id,
      resourceLabel: user.email,
      metadata: { status },
    });

    return { id: user.id, status };
  }

  async assignRole(userId: string, roleId: string, actor: Actor) {
    const [user, role] = await Promise.all([
      this.prisma.client.user.findUnique({ where: { id: userId } }),
      this.prisma.client.role.findUnique({ where: { id: roleId } }),
    ]);

    if (!user || user.deletedAt || !role) {
      throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    }

    this.assertSameTenant(user.tenantId, actor);

    // An MSP-only role outside the MSP root tenant is refused by a database
    // trigger as well; failing here gives a usable error instead of a 500.
    if (role.mspOnly && !actor.isMspRoot) {
      throw new VelnoxError(ERROR_CODES.authzForbidden, {
        status: 403,
        params: { reason: 'msp_only_role' },
      });
    }

    /*
     * Find, then create — not upsert.
     *
     * The unique key is (userId, roleId, scopeType, scopeId) and scopeId is null
     * for a global grant. Prisma will not accept null in a compound unique
     * lookup, so `upsert` cannot express "the global grant of this role to this
     * user". Two statements say the same thing and compile.
     */
    const existingAssignment = await this.prisma.client.roleAssignment.findFirst({
      where: { userId, roleId, scopeType: 'GLOBAL', scopeId: null },
    });

    const assignment = existingAssignment
      ? await this.prisma.client.roleAssignment.update({
          where: { id: existingAssignment.id },
          data: { grantedBy: actor.id, grantedAt: new Date() },
        })
      : await this.prisma.client.roleAssignment.create({
          data: {
            userId,
            roleId,
            scopeType: 'GLOBAL',
            scopeId: null,
            grantedBy: actor.id,
          },
        });

    // Permissions are baked into the access token's principal at request time,
    // but a token already issued was built from the old grants.
    await this.prisma.client.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });

    await this.audit.success(AUDIT_ACTIONS.roleAssigned, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: user.tenantId,
      resourceType: 'user',
      resourceId: user.id,
      resourceLabel: user.email,
      metadata: { role: role.name, scopeType: 'GLOBAL' },
    });

    return { id: assignment.id };
  }

  async revokeRole(userId: string, assignmentId: string, actor: Actor) {
    const assignment = await this.prisma.client.roleAssignment.findUnique({
      where: { id: assignmentId },
      include: { role: true, user: true },
    });

    if (!assignment || assignment.userId !== userId) {
      throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    }

    this.assertSameTenant(assignment.user.tenantId, actor);

    /*
     * The founding administrator's grants are inalienable.
     *
     * Before this existed, an administrator could revoke their own last role.
     * On an installation with one account — which is every installation on its
     * first day — that removed the last permission in the system and locked
     * every human out: signing in still worked, and nothing was allowed. The
     * only way back was a psql prompt.
     *
     * Refused for everyone, including the account itself. Disabling it remains
     * possible, because that is reversible by anyone who still has permissions;
     * taking its permissions away is not.
     */
    if (assignment.user.isFoundingAdministrator) {
      throw new VelnoxError(ERROR_CODES.authzFoundingAdministrator, {
        status: 409,
        message: 'The founding administrator cannot have roles removed',
      });
    }

    await this.prisma.client.roleAssignment.delete({ where: { id: assignmentId } });
    await this.prisma.client.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });

    await this.audit.success(AUDIT_ACTIONS.roleRevoked, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: assignment.user.tenantId,
      resourceType: 'user',
      resourceId: userId,
      resourceLabel: assignment.user.email,
      metadata: { role: assignment.role.name },
    });
  }

  /**
   * Enabled accounts other than this one that hold `roles.manage`.
   *
   * That is the permission recovery actually needs: granting a role back to
   * whoever lost one. `system.manage` would have been the stricter test and the
   * wrong one — it governs installation settings, and an account that can manage
   * roles but not those settings can still put access back together. Counting
   * role assignments instead would be wrong in the other direction, satisfied by
   * a read-only role that can fix nothing.
   */
  private async countOtherEnabledAdministrators(excludeUserId: string): Promise<number> {
    return this.prisma.client.user.count({
      where: {
        id: { not: excludeUserId },
        status: 'ACTIVE',
        deletedAt: null,
        roleAssignments: {
          some: {
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            role: { permissions: { some: { permission: PERMISSIONS.rolesManage } } },
          },
        },
      },
    });
  }

  /** Anyone outside the MSP root tenant may only touch their own tenant. */
  private assertSameTenant(tenantId: string, actor: Actor): void {
    if (actor.isMspRoot || tenantId === actor.tenantId) return;
    throw new VelnoxError(ERROR_CODES.authzTenantForbidden, { status: 403 });
  }
}
