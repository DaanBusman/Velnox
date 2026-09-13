import { Injectable } from '@nestjs/common';
import { checkPasswordStrength, hashPassword } from '@velnox/crypto';
import { ERROR_CODES, PERMISSIONS, VelnoxError, canResetMfa, type ScopeType } from '@velnox/shared';
import { PrismaService } from '../infrastructure/prisma.service';
import { assertAllowedAt, type Actor } from '../../common/actor';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { SessionService } from '../auth/session.service';
import { MfaService } from '../auth/mfa.service';

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

// `Actor` moved to common/actor.ts once tenants and sites needed the same
// thing. Re-exported so existing imports keep working and there is still only
// one definition.
export type { Actor };

@Injectable()
export class UserAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
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
     * The tenant may come from the request, and is then checked at that scope.
     *
     * Phase 2 took it from the actor and ignored anything sent, because there
     * was one tenant and no way to express "may create users for this customer".
     * Now there is: the caller has to hold `users.manage` covering the tenant
     * they are placing the account in, and the tenancy extension refuses the
     * write outright if that tenant is outside their scope. Two independent
     * checks, neither of which is "trust the body".
     */
    const tenantId = input.tenantId ?? actor.tenantId;
    assertAllowedAt(actor, PERMISSIONS.usersManage, { tenantId });

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

    assertAllowedAt(actor, PERMISSIONS.usersManage, { tenantId: user.tenantId });

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

  /**
   * Grant a role, at a scope.
   *
   * Phase 2 could only grant at GLOBAL, which was honest for an installation
   * with one tenant and is the wrong default for one with fifty: it means every
   * grant reaches every customer. A grant now names what it covers, and
   * `resolveGrantScope` below decides whether it is allowed to.
   */
  async assignRole(
    userId: string,
    input: { roleId: string; scopeType: ScopeType; scopeId?: string | null },
    actor: Actor,
  ) {
    const roleId = input.roleId;

    const [user, role] = await Promise.all([
      this.prisma.client.user.findUnique({
        where: { id: userId },
        include: { tenant: { select: { kind: true } } },
      }),
      this.prisma.client.role.findUnique({ where: { id: roleId } }),
    ]);

    if (!user || user.deletedAt || !role) {
      throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    }

    assertAllowedAt(actor, PERMISSIONS.rolesManage, { tenantId: user.tenantId });

    // An MSP-only role outside the MSP root tenant is refused by a database
    // trigger as well; failing here gives a usable error instead of a 500.
    if (role.mspOnly && !actor.isMspRoot) {
      throw new VelnoxError(ERROR_CODES.authzForbidden, {
        status: 403,
        params: { reason: 'msp_only_role' },
      });
    }

    const scope = await this.resolveGrantScope(
      input,
      { tenantId: user.tenantId, isMspRoot: user.tenant.kind === 'MSP_ROOT' },
      actor,
    );

    /*
     * Find, then create — not upsert.
     *
     * The unique key is (userId, roleId, scopeType, scopeId) and scopeId is null
     * for a global grant. Prisma will not accept null in a compound unique
     * lookup, so `upsert` cannot express "the global grant of this role to this
     * user". Two statements say the same thing and compile.
     */
    const existingAssignment = await this.prisma.client.roleAssignment.findFirst({
      where: { userId, roleId, scopeType: scope.scopeType, scopeId: scope.scopeId },
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
            scopeType: scope.scopeType,
            scopeId: scope.scopeId,
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
      metadata: {
        role: role.name,
        scopeType: scope.scopeType,
        ...(scope.scopeId ? { scopeId: scope.scopeId } : {}),
      },
    });

    return { id: assignment.id };
  }

  /**
   * Decide what a grant is allowed to cover.
   *
   * Four rules, each closing a way to hand out more access than the person doing
   * the handing has:
   *
   * 1. **GLOBAL needs a home in the MSP organisation.** A database trigger
   *    refuses it outright; checking here turns a 500 into an explanation.
   * 2. **The actor must already hold `roles.manage` at that scope.** Without
   *    this, an administrator given one customer could grant anyone — including
   *    themselves — a role covering all of them. This is the rule that keeps
   *    delegation from being an escalation.
   * 3. **The scope has to exist.** Loaded through the scoped client, so a site
   *    the actor cannot reach reads as one that does not exist; a database
   *    trigger refuses a dangling scope id as well, because a grant covering a
   *    deleted site looks identical to a grant that was never given.
   * 4. **A customer's account stays inside its own tenant.** Only an account in
   *    the MSP organisation may hold a grant pointing somewhere else — that is
   *    what managing other people's infrastructure *is*. For anyone else it
   *    would be the isolation boundary failing by administration rather than by
   *    code.
   */
  private async resolveGrantScope(
    input: { scopeType: ScopeType; scopeId?: string | null },
    target: { tenantId: string; isMspRoot: boolean },
    actor: Actor,
  ): Promise<{ scopeType: ScopeType; scopeId: string | null }> {
    if (input.scopeType === 'GLOBAL') {
      if (!target.isMspRoot) {
        throw new VelnoxError(ERROR_CODES.authzForbidden, {
          status: 409,
          message:
            'A grant at global scope is only possible for an account in the MSP organisation',
          params: { reason: 'global_requires_msp' },
        });
      }

      assertAllowedAt(actor, PERMISSIONS.rolesManage, {});
      return { scopeType: 'GLOBAL', scopeId: null };
    }

    const scopeId = input.scopeId ?? null;
    if (!scopeId) {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 400,
        message: `A grant at ${input.scopeType} scope has to name what it covers`,
        params: { field: 'scopeId' },
      });
    }

    if (input.scopeType === 'TENANT') {
      const tenant = await this.prisma.client.tenant.findFirst({
        where: { id: scopeId, deletedAt: null },
      });
      if (!tenant) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });

      assertAllowedAt(actor, PERMISSIONS.rolesManage, { tenantId: scopeId });
      assertScopeStaysInTenant(scopeId, target);
      return { scopeType: 'TENANT', scopeId };
    }

    if (input.scopeType === 'SITE') {
      const site = await this.prisma.client.site.findFirst({
        where: { id: scopeId, deletedAt: null },
        select: { id: true, tenantId: true },
      });
      if (!site) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });

      assertAllowedAt(actor, PERMISSIONS.rolesManage, {
        tenantId: site.tenantId,
        siteId: site.id,
      });
      assertScopeStaysInTenant(site.tenantId, target);
      return { scopeType: 'SITE', scopeId };
    }

    /*
     * CLUSTER is in the catalogue and has nothing to point at yet.
     *
     * Refusing is better than accepting: a grant naming a cluster id that does
     * not exist covers nothing, looks like a grant that was given, and would be
     * discovered during an incident.
     */
    throw new VelnoxError(ERROR_CODES.featureDisabled, {
      status: 409,
      message: 'Grants at cluster scope arrive with the Proxmox inventory in Phase 4',
      params: { scopeType: input.scopeType, phase: 4 },
    });
  }

  async revokeRole(userId: string, assignmentId: string, actor: Actor) {
    const assignment = await this.prisma.client.roleAssignment.findUnique({
      where: { id: assignmentId },
      include: { role: true, user: true },
    });

    if (!assignment || assignment.userId !== userId) {
      throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    }

    assertAllowedAt(actor, PERMISSIONS.rolesManage, { tenantId: assignment.user.tenantId });

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
   * Remove another account's second factor so they can enrol again.
   *
   * Velnox used to have no administrator override at all, and said so: an
   * override is a standing bypass of the second factor for anyone who reaches an
   * administrator account. The replacement for a colleague who had lost both
   * their authenticator and their recovery codes was a new account, which loses
   * nothing but is slow and leaves a disabled account behind for every mislaid
   * phone. This is the deliberate reversal of that decision, narrowed so the
   * bypass is as small as the problem.
   *
   * Three things keep it small.
   *
   * **Never your own account.** Checked first, and checked here rather than only
   * in the interface. Self-service disable exists and asks for a valid code,
   * which proves possession; if an administrator could clear their own factor,
   * every privileged second factor would be removable by its own password.
   *
   * **A colleague is not a customer.** `users.reset_mfa` reaches customer
   * accounts. Reaching an account in the MSP root tenant — one that can see
   * every customer — additionally needs `users.reset_mfa_msp`, which only the
   * Super Administrator holds. `canResetMfa` is where that lives, as a pure
   * function with the whole matrix under test.
   *
   * **It is loud.** The target's sessions are revoked and the act is audited
   * under its own action, separately from a self-service disable, because "an
   * administrator removed someone's second factor" and "someone removed their
   * own" are different events and an auditor should not have to infer which.
   */
  async resetMfa(userId: string, actor: Actor) {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      include: { tenant: { select: { kind: true } } },
    });

    if (!user || user.deletedAt) {
      throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    }

    /*
     * `users.reset_mfa` has to cover the target's tenant, not merely be held.
     *
     * `canResetMfa` below checks the same thing and more, but it is reached only
     * after this — so an engineer granted one customer cannot reach another
     * customer's account even if the decision function were later loosened.
     */
    assertAllowedAt(actor, PERMISSIONS.usersResetMfa, { tenantId: user.tenantId });

    const decision = canResetMfa({
      actorId: actor.id,
      targetId: user.id,
      targetIsMspRoot: user.tenant.kind === 'MSP_ROOT',
      targetTenantId: user.tenantId,
      grants: actor.grants,
    });

    if (!decision.allowed) {
      await this.audit.denied(AUDIT_ACTIONS.mfaResetByAdministrator, {
        actorType: 'USER',
        actorId: actor.id,
        actorLabel: actor.email,
        tenantId: user.tenantId,
        resourceType: 'user',
        resourceId: user.id,
        resourceLabel: user.email,
        metadata: { reason: decision.refusal },
      });

      throw new VelnoxError(ERROR_CODES.authzMfaResetForbidden, {
        status: 403,
        message: `Refused to reset the second factor: ${decision.refusal}`,
        params: { reason: decision.refusal ?? 'no_permission' },
      });
    }

    const { removed } = await this.mfa.clearFactor(user.id);

    /*
     * The account's authentication changed under it, so its sessions go.
     *
     * Leaving them would mean a session that already satisfied the old factor
     * keeps running while the factor it satisfied no longer exists — and if the
     * installation requires a second factor, the account must be sent back
     * through enrolment rather than allowed to continue without one.
     */
    await this.prisma.client.user.update({
      where: { id: user.id },
      data: { tokenVersion: { increment: 1 } },
    });
    await this.sessions.revokeAllForUser(user.id, 'mfa_reset');

    await this.audit.success(AUDIT_ACTIONS.mfaResetByAdministrator, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: user.tenantId,
      resourceType: 'user',
      resourceId: user.id,
      resourceLabel: user.email,
      // Named to survive redaction, and deliberately says whether there was
      // anything to remove: a reset of an account that had no factor is a
      // different fact from one that did.
      metadata: { factorRemoved: removed },
    });

    return { id: user.id, mfaEnrolled: false };
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
}

/**
 * An account outside the MSP organisation may only be granted scopes inside its
 * own tenant.
 *
 * The whole point of an MSP account is the opposite — a grant pointing at
 * somebody else's tenant is how managing their infrastructure works. For a
 * customer's own account it is the isolation boundary being crossed by
 * administration rather than by code, and it is refused.
 */
function assertScopeStaysInTenant(
  scopeTenantId: string,
  target: { tenantId: string; isMspRoot: boolean },
): void {
  if (target.isMspRoot || scopeTenantId === target.tenantId) return;

  throw new VelnoxError(ERROR_CODES.authzTenantForbidden, {
    status: 409,
    params: { reason: 'scope_outside_home_tenant' },
  });
}
