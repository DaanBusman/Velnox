import { Injectable } from '@nestjs/common';
import { withSystemScope, type AutoconfigTemplate, type Prisma } from '@velnox/db';
import {
  ERROR_CODES,
  PERMISSIONS,
  PRODUCT_KEY,
  VelnoxError,
  isAllowed,
  passwordProblem,
  requiredTemplateSecrets,
  templateSettingsSchema,
  type CredentialDelivery,
  type PdfPasswordSource,
  type TemplateSecretKey,
  type TemplateSettings,
  type TemplateSummary,
  type TemplateVisibility,
} from '@velnox/shared';
import { PrismaService } from '../infrastructure/prisma.service';
import { SecretStoreService } from '../auth/secret-store.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { assertAllowedAt, type Actor } from '../../common/actor';

/**
 * Autoconfig templates: who sees them, who changes them, and their secrets.
 *
 * **Seeing** is the tenancy filter's job (tenancy.ts): a tenant's own templates,
 * and the MSP's shared ones. **Changing** is decided here, against the tenant
 * that owns the template — never inferred from the fact that it is visible,
 * because an MSP template is visible to every tenant and editable by none of
 * them.
 *
 * **Secrets** are one credential each, referenced from `secretRefs`. The API
 * writes them and cannot read them back (ADR-009): changing one password
 * replaces one credential, and nothing ever needs another one decrypted. A
 * clone therefore starts without the source's fixed passwords, and lists them
 * as missing — an MSP's passwords are not handed to a customer by copying a
 * template.
 */

export interface TemplateInput {
  name: string;
  description: string;
  visibility: TemplateVisibility;
  credentialDelivery: CredentialDelivery;
  pdfPasswordSource: PdfPasswordSource;
  settings?: unknown;
  /** New values by key; null removes one. Keys the settings do not call for are refused. */
  secrets: Record<string, string | null>;
}

type SecretRefs = Partial<Record<TemplateSecretKey, string>>;

@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretStoreService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** The MSP root's id. Not a secret, and needed by callers who cannot see the MSP. */
  async mspRootId(): Promise<string> {
    // Awaited inside the callback: a Prisma query is lazy, and returned unawaited
    // it would run when the caller awaits it — back in the caller's own scope,
    // where a customer cannot see the MSP root. That is exactly what happened.
    const root = await withSystemScope(
      'the MSP root id decides which templates are shared',
      async () =>
        await this.prisma.client.tenant.findFirst({
          where: { kind: 'MSP_ROOT' },
          select: { id: true },
        }),
    );
    if (!root) throw new VelnoxError(ERROR_CODES.generic, { status: 500, message: 'No MSP root' });
    return root.id;
  }

  /**
   * Every template this actor may see, or — with `offeredTo` — the ones a VM in
   * that tenant may be built from: the tenant's own, the MSP's shared ones, and
   * the MSP's private ones when the actor is MSP staff.
   */
  async list(actor: Actor, offeredTo?: string): Promise<TemplateSummary[]> {
    const rows = await this.prisma.client.autoconfigTemplate.findMany({
      orderBy: [{ name: 'asc' }],
      include: { tenant: { select: { name: true, kind: true } } },
    });
    const root = await this.mspRootId();
    const usable = offeredTo
      ? rows.filter((row) => this.offered(row, offeredTo, root, actor))
      : rows;
    return usable.map((row) => this.summary(row, actor, root));
  }

  async get(id: string, actor: Actor): Promise<TemplateSummary> {
    const row = await this.row(id);
    return this.summary(row, actor, await this.mspRootId());
  }

  /** Whether a VM in `tenantId` may be built from this template by this actor. */
  offered(
    row: { tenantId: string; visibility: TemplateVisibility },
    tenantId: string,
    rootId: string,
    actor: Actor,
  ): boolean {
    if (row.tenantId === tenantId) return true;
    if (row.tenantId !== rootId) return false;
    if (row.visibility === 'SHARED') return true;
    // A private MSP template, offered to MSP staff building for a customer.
    return actor.isMspRoot;
  }

  async row(id: string) {
    const row = await this.prisma.client.autoconfigTemplate.findUnique({
      where: { id },
      include: { tenant: { select: { name: true, kind: true } } },
    });
    if (!row) throw new VelnoxError(ERROR_CODES.notFound, { status: 404 });
    return row;
  }

  summary(
    row: AutoconfigTemplate & { tenant: { name: string; kind: string } },
    actor: Actor,
    rootId: string,
  ): TemplateSummary {
    const settings = row.settings as unknown as TemplateSettings;
    const refs = (row.secretRefs ?? {}) as SecretRefs;
    const required = requiredTemplateSecrets(settings, {
      credentialDelivery: row.credentialDelivery,
      pdfPasswordSource: row.pdfPasswordSource,
    });
    const secretsSet: Partial<Record<TemplateSecretKey, boolean>> = {};
    for (const key of required) secretsSet[key] = Boolean(refs[key]);

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      family: row.family,
      tenantId: row.tenantId,
      tenantName: row.tenant.name,
      ownedByMsp: row.tenantId === rootId,
      visibility: row.visibility,
      credentialDelivery: row.credentialDelivery,
      pdfPasswordSource: row.pdfPasswordSource,
      clonedFromId: row.clonedFromId,
      clonedFromName: row.clonedFromName,
      settings,
      secretsSet,
      secretsMissing: required.filter((key) => !refs[key]),
      canEdit: isAllowed(actor.grants, PERMISSIONS.autoconfigManage, { tenantId: row.tenantId }),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Changing
  // -------------------------------------------------------------------------

  async create(
    input: TemplateInput & { tenantId: string },
    actor: Actor,
  ): Promise<TemplateSummary> {
    assertAllowedAt(actor, PERMISSIONS.autoconfigManage, { tenantId: input.tenantId });
    const settings = this.parseSettings(input.settings);

    const row = await this.insert({
      tenantId: input.tenantId,
      name: input.name.trim(),
      description: input.description.trim(),
      family: settings.family,
      visibility: input.visibility,
      credentialDelivery: input.credentialDelivery,
      pdfPasswordSource: input.pdfPasswordSource,
      settings: settings as unknown as Prisma.InputJsonValue,
      createdById: actor.id,
      createdByLabel: actor.email,
    });

    let refs: SecretRefs;
    try {
      refs = await this.applySecrets(row, settings, {}, input.secrets);
    } catch (error) {
      // A refused secret refuses the template; half of one is not left behind.
      await this.prisma.client.autoconfigTemplate
        .delete({ where: { id: row.id } })
        .catch(() => undefined);
      throw error;
    }
    const saved = await this.prisma.client.autoconfigTemplate.update({
      where: { id: row.id },
      data: { secretRefs: refs as Prisma.InputJsonValue },
      include: { tenant: { select: { name: true, kind: true } } },
    });
    await this.audited(AUDIT_ACTIONS.autoconfigTemplateCreated, saved, actor, {
      family: saved.family,
      visibility: saved.visibility,
      secretsChanged: Object.keys(input.secrets),
    });
    return this.summary(saved, actor, await this.mspRootId());
  }

  async update(id: string, input: Partial<TemplateInput>, actor: Actor): Promise<TemplateSummary> {
    const row = await this.row(id);
    // Against the owner, not the viewer: an MSP template is visible to tenants
    // and editable by none of them.
    assertAllowedAt(actor, PERMISSIONS.autoconfigManage, { tenantId: row.tenantId });

    const settings =
      input.settings !== undefined
        ? this.parseSettings(input.settings)
        : (row.settings as unknown as TemplateSettings);
    if (settings.family !== row.family) {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 400,
        message: 'A template stays Windows or Linux; create a new one instead',
      });
    }
    const delivery = {
      credentialDelivery: input.credentialDelivery ?? row.credentialDelivery,
      pdfPasswordSource: input.pdfPasswordSource ?? row.pdfPasswordSource,
    };

    const refs = await this.applySecrets(
      { ...row, ...delivery },
      settings,
      (row.secretRefs ?? {}) as SecretRefs,
      input.secrets ?? {},
    );

    let saved;
    try {
      saved = await this.prisma.client.autoconfigTemplate.update({
        where: { id: row.id, tenantId: row.tenantId },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined ? { description: input.description.trim() } : {}),
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
          ...delivery,
          settings: settings as unknown as Prisma.InputJsonValue,
          secretRefs: refs as Prisma.InputJsonValue,
        },
        include: { tenant: { select: { name: true, kind: true } } },
      });
    } catch (error) {
      throw this.nameTaken(error, input.name ?? row.name);
    }
    await this.audited(AUDIT_ACTIONS.autoconfigTemplateChanged, saved, actor, {
      fields: Object.keys(input).filter((key) => key !== 'secrets'),
      secretsChanged: Object.keys(input.secrets ?? {}),
    });
    return this.summary(saved, actor, await this.mspRootId());
  }

  /**
   * An independent copy, into a tenant the actor may manage templates in.
   *
   * Settings are copied; secrets are not, because they cannot be read to be
   * copied and should not be shared by copying anyway. The copy says what it
   * was cloned from, by name as well as id, so that stays readable after the
   * source is gone.
   */
  async clone(
    id: string,
    input: { tenantId: string; name: string },
    actor: Actor,
  ): Promise<TemplateSummary> {
    const source = await this.row(id);
    const root = await this.mspRootId();
    if (!this.offered(source, input.tenantId, root, actor)) {
      throw new VelnoxError(ERROR_CODES.autoconfigNotOffered, { status: 403 });
    }
    assertAllowedAt(actor, PERMISSIONS.autoconfigManage, { tenantId: input.tenantId });

    const copy = await this.insert({
      tenantId: input.tenantId,
      name: input.name.trim(),
      description: source.description,
      family: source.family,
      // A customer's copy of an MSP template is theirs, and nobody else's.
      visibility: input.tenantId === root ? source.visibility : 'PRIVATE',
      credentialDelivery: source.credentialDelivery,
      pdfPasswordSource: source.pdfPasswordSource,
      settings: source.settings as Prisma.InputJsonValue,
      clonedFromId: source.id,
      clonedFromName: source.name,
      createdById: actor.id,
      createdByLabel: actor.email,
    });
    const saved = await this.row(copy.id);
    await this.audited(AUDIT_ACTIONS.autoconfigTemplateCloned, saved, actor, {
      from: source.id,
      fromName: source.name,
    });
    return this.summary(saved, actor, root);
  }

  async remove(id: string, actor: Actor): Promise<void> {
    const row = await this.row(id);
    assertAllowedAt(actor, PERMISSIONS.autoconfigManage, { tenantId: row.tenantId });
    await this.prisma.client.autoconfigTemplate.delete({
      where: { id: row.id, tenantId: row.tenantId },
    });
    // Provisioning records keep a copy of the settings and their own
    // credentials; nothing still needs the template's.
    for (const credentialId of Object.values((row.secretRefs ?? {}) as SecretRefs)) {
      if (credentialId) await this.secrets.deleteCredential(credentialId).catch(() => undefined);
    }
    await this.audited(AUDIT_ACTIONS.autoconfigTemplateDeleted, row, actor, {});
  }

  // -------------------------------------------------------------------------
  // Pieces
  // -------------------------------------------------------------------------

  private parseSettings(raw: unknown): TemplateSettings {
    const parsed = templateSettingsSchema.safeParse(raw);
    if (!parsed.success) {
      throw new VelnoxError(ERROR_CODES.validation, {
        status: 400,
        message: 'The template settings are not valid',
        params: {
          issues: parsed.error.issues
            .slice(0, 10)
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; '),
        },
      });
    }
    return parsed.data as TemplateSettings;
  }

  private async insert(data: Prisma.AutoconfigTemplateUncheckedCreateInput) {
    try {
      return await this.prisma.client.autoconfigTemplate.create({ data });
    } catch (error) {
      throw this.nameTaken(error, data.name);
    }
  }

  private nameTaken(error: unknown, name: string): unknown {
    if ((error as { code?: unknown } | null)?.code === 'P2002') {
      return new VelnoxError(ERROR_CODES.autoconfigNameTaken, { status: 409, params: { name } });
    }
    return error;
  }

  /**
   * Write the secrets given, drop the ones no longer called for, and return the
   * new references.
   *
   * A value is checked before it is stored — a product key's shape, a
   * password's strength — because the place it would otherwise fail is an
   * unattended install, where nobody is watching.
   */
  private async applySecrets(
    row: { id: string; tenantId: string; name: string } & {
      credentialDelivery: CredentialDelivery;
      pdfPasswordSource: PdfPasswordSource;
    },
    settings: TemplateSettings,
    current: SecretRefs,
    changes: Record<string, string | null>,
  ): Promise<SecretRefs> {
    const allowed = new Set<string>(
      requiredTemplateSecrets(settings, {
        credentialDelivery: row.credentialDelivery,
        pdfPasswordSource: row.pdfPasswordSource,
      }),
    );

    for (const [key, value] of Object.entries(changes)) {
      if (!allowed.has(key) && value !== null) {
        throw new VelnoxError(ERROR_CODES.autoconfigSecretUnexpected, {
          status: 400,
          params: { key },
        });
      }
      if (value === null) continue;
      if (key === 'productKey') {
        if (!PRODUCT_KEY.test(value.trim().toUpperCase())) {
          throw new VelnoxError(ERROR_CODES.autoconfigProductKeyInvalid, { status: 400 });
        }
      } else {
        const problem = passwordProblem(value);
        if (problem) {
          throw new VelnoxError(ERROR_CODES.validation, {
            status: 400,
            message: `The password for ${key} is ${problem.replace('_', ' ')}`,
            params: { key, problem },
          });
        }
      }
    }

    const next: SecretRefs = { ...current };
    const retired: string[] = [];
    for (const [key, value] of Object.entries(changes)) {
      const previous = next[key as TemplateSecretKey];
      if (previous) retired.push(previous);
      delete next[key as TemplateSecretKey];
      if (value === null) continue;
      const stored = await this.secrets.putForCredential({
        kind: 'TEMPLATE_SECRETS',
        material: key === 'productKey' ? value.trim().toUpperCase() : value,
        tenantId: row.tenantId,
        label: `Template ${row.name}: ${key}`,
        scopeType: 'TENANT',
        scopeId: row.tenantId,
      });
      next[key as TemplateSecretKey] = stored.credentialId;
    }
    // A secret the settings no longer call for goes: a template that stopped
    // fixing a password must not keep it.
    for (const [key, credentialId] of Object.entries(next)) {
      if (!allowed.has(key) && credentialId) {
        retired.push(credentialId);
        delete next[key as TemplateSecretKey];
      }
    }
    for (const credentialId of retired) {
      await this.secrets.deleteCredential(credentialId).catch(() => undefined);
    }
    return next;
  }

  private async audited(
    action: string,
    row: { id: string; name: string; tenantId: string },
    actor: Actor,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.success(action, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: row.tenantId,
      resourceType: 'autoconfig_template',
      resourceId: row.id,
      resourceLabel: row.name,
      // Which secrets changed, never what they are.
      metadata,
    });
  }
}
