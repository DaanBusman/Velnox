import { Injectable } from '@nestjs/common';
import { checkPasswordStrength, hashPassword } from '@velnox/crypto';
import {
  ERROR_CODES,
  FIRST_ADMINISTRATOR_ROLE,
  SYSTEM_ROLES,
  VelnoxError,
} from '@velnox/shared';
import { PrismaService } from '../infrastructure/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';

/**
 * First-run setup.
 *
 * There is no default administrator and no default password at any point in the
 * product's life. The only way an account comes into existence is this wizard,
 * and it can run exactly once: everything below happens inside a single
 * transaction that ends by setting `initialized`, and the endpoint is closed
 * permanently afterwards.
 */

export interface SetupStatus {
  initialized: boolean;
  productName: string;
}

export interface InitializeInput {
  organisationName: string;
  displayName: string;
  email: string;
  password: string;
}

@Injectable()
export class SetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async status(): Promise<SetupStatus> {
    const settings = await this.prisma.client.systemSettings.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1 },
    });
    return { initialized: settings.initialized, productName: settings.productName };
  }

  async initialize(input: InitializeInput): Promise<{ userId: string; tenantId: string }> {
    const email = input.email.trim().toLowerCase();

    const strength = checkPasswordStrength(input.password, { email });
    if (!strength.ok) {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 400,
        message: 'Password does not meet the minimum strength requirement',
        params: { problems: strength.problems.join(',') },
      });
    }

    const passwordHash = await hashPassword(input.password);

    try {
      const result = await this.prisma.client.$transaction(async (tx) => {
        // Re-read inside the transaction. Two simultaneous requests both see
        // "not initialized" outside it; only one can win in here.
        const settings = await tx.systemSettings.findUnique({ where: { id: 1 } });
        if (settings?.initialized) {
          throw new VelnoxError(ERROR_CODES.setupAlreadyInitialized, { status: 409 });
        }

        const tenant = await tx.tenant.create({
          data: {
            name: input.organisationName.trim(),
            slug: slugify(input.organisationName),
            kind: 'MSP_ROOT',
          },
        });

        // Seed every system role, not just the one being granted: the roles are
        // the vocabulary the rest of the product assigns from, and creating them
        // lazily later would mean a half-populated Roles screen.
        const roleIds = new Map<string, string>();
        for (const definition of SYSTEM_ROLES) {
          const role = await tx.role.create({
            data: {
              key: definition.key,
              name: definition.name,
              description: definition.description,
              isSystem: true,
              mspOnly: definition.mspOnly,
              permissions: {
                create: definition.permissions.map((permission) => ({ permission })),
              },
            },
          });
          roleIds.set(definition.key, role.id);
        }

        const user = await tx.user.create({
          data: {
            tenantId: tenant.id,
            email,
            displayName: input.displayName.trim(),
            passwordHash,
            passwordUpdatedAt: new Date(),
            status: 'ACTIVE',
          },
        });

        await tx.roleAssignment.create({
          data: {
            userId: user.id,
            roleId: roleIds.get(FIRST_ADMINISTRATOR_ROLE)!,
            scopeType: 'GLOBAL',
            scopeId: null,
            grantedBy: user.id,
          },
        });

        await tx.systemSettings.update({
          where: { id: 1 },
          data: { initialized: true, initializedAt: new Date() },
        });

        return { userId: user.id, tenantId: tenant.id };
      });

      await this.audit.success(AUDIT_ACTIONS.setupInitialized, {
        actorType: 'USER',
        actorId: result.userId,
        actorLabel: email,
        tenantId: result.tenantId,
        resourceType: 'installation',
        metadata: { organisation: input.organisationName, role: FIRST_ADMINISTRATOR_ROLE },
      });

      return result;
    } catch (error) {
      if (error instanceof VelnoxError && error.code === ERROR_CODES.setupAlreadyInitialized) {
        await this.audit.denied(AUDIT_ACTIONS.setupRejected, {
          actorType: 'ANONYMOUS',
          actorLabel: email,
          metadata: { reason: 'already_initialized' },
        });
      }
      throw error;
    }
  }

  /** Guard for the setup endpoint: open only while uninitialised. */
  async assertNotInitialized(): Promise<void> {
    const { initialized } = await this.status();
    if (initialized) {
      throw new VelnoxError(ERROR_CODES.setupAlreadyInitialized, { status: 409 });
    }
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'msp';
}
