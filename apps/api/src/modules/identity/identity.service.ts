import { Inject, Injectable } from '@nestjs/common';
import type { IdentityProvider } from '@velnox/db';
import type { ApiConfig } from '@velnox/config';
import { API_CONFIG } from '../../config/config.module';
import { PrismaService } from '../infrastructure/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { SecretStoreService } from '../auth/secret-store.service';
import { fetchDiscoveryDocument } from './oidc-discovery';

/**
 * Microsoft Entra ID configuration.
 *
 * This phase builds the configuration and the means to check it, not the
 * sign-in itself. The authorization code + PKCE flow arrives later
 * (docs/roadmap.md), and until it does the sign-in button stays off — a button
 * that starts a flow which does not exist would be worse than no button.
 *
 * Two rules the product does not bend on, both recorded in
 * docs/architecture.md:
 *
 *   - local sign-in cannot be turned off by configuring SSO. An identity
 *     provider is something Velnox depends on; a directory outage must not lock
 *     an MSP out of the tool they use to fix outages.
 *   - the client secret goes into the credential store like any other secret.
 *     It is never returned by this API, in any response, to anyone.
 */

export const ENTRA_PROVIDER_NAME = 'Microsoft Entra ID';

/**
 * Where Entra ID sends the browser back after someone signs in.
 *
 * It has to be registered in the directory long before the flow that uses it
 * exists, so it is defined once here and handed to the interface rather than
 * typed by hand into both places. Changing it later means editing the app
 * registration in Entra too — exactly the kind of two-sided change that should
 * be visible in a diff.
 */
export const OIDC_CALLBACK_PATH = '/api/v1/auth/oidc/callback';

export interface ProviderView {
  configured: boolean;
  enabled: boolean;
  name: string;
  discoveryUrl: string | null;
  issuer: string | null;
  clientId: string | null;
  /** Whether a secret is stored. Never the secret. */
  clientSecretSet: boolean;
  allowedEmailDomains: string[];
  autoProvision: boolean;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  /**
   * Whether signing in through this provider actually works yet. False in this
   * build, and reported rather than implied.
   */
  signInAvailable: boolean;

  /** What to paste into the app registration. Derived, never stored. */
  redirectUri: string;
  /** A name for the app registration that says which installation it belongs to. */
  suggestedAppName: string;
}

export interface ProviderUpdate {
  enabled?: boolean;
  discoveryUrl?: string | null;
  issuer?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
  allowedEmailDomains?: string[];
  autoProvision?: boolean;
}

@Injectable()
export class IdentityService {
  private readonly redirectUri: string;
  private readonly suggestedAppName: string;

  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    private readonly prisma: PrismaService,
    private readonly secrets: SecretStoreService,
    private readonly audit: AuditService,
  ) {
    // Built from the address operators actually reach this installation on, so
    // the value shown in the wizard is the value the flow will send. A URL
    // assembled in the browser could differ — behind a reverse proxy it usually
    // would — and a redirect URI that differs by one character is rejected by
    // Entra with an error that says very little.
    this.redirectUri = new URL(OIDC_CALLBACK_PATH, config.APP_URL).toString();

    // Several Velnox installations can share one directory, so the name says
    // which one this is.
    this.suggestedAppName = `${config.VELNOX_PRODUCT_NAME} (${new URL(config.APP_URL).host})`;
  }

  /** The two values the wizard asks the operator to paste into Entra. */
  private get derived() {
    return { redirectUri: this.redirectUri, suggestedAppName: this.suggestedAppName };
  }

  async view(): Promise<ProviderView> {
    const provider = await this.find();
    return describe(provider, this.derived);
  }

  async update(
    update: ProviderUpdate,
    actor: { id: string; email: string; tenantId: string },
  ): Promise<ProviderView> {
    const existing = await this.find();

    let clientSecretRef = existing?.clientSecretRef ?? null;

    if (update.clientSecret !== undefined) {
      if (update.clientSecret === null || update.clientSecret === '') {
        clientSecretRef = null;
      } else {
        const stored = await this.secrets.putForCredential({
          kind: 'OIDC_CLIENT_SECRET',
          material: update.clientSecret,
          label: `${ENTRA_PROVIDER_NAME} client secret`,
        });
        clientSecretRef = stored.secretRef;
      }
    }

    const data = {
      kind: 'OIDC' as const,
      name: ENTRA_PROVIDER_NAME,
      ...(update.enabled === undefined ? {} : { enabled: update.enabled }),
      ...(update.discoveryUrl === undefined ? {} : { discoveryUrl: update.discoveryUrl }),
      ...(update.issuer === undefined ? {} : { issuer: update.issuer }),
      ...(update.clientId === undefined ? {} : { clientId: update.clientId }),
      ...(update.allowedEmailDomains === undefined
        ? {}
        : { allowedEmailDomains: update.allowedEmailDomains }),
      ...(update.autoProvision === undefined ? {} : { autoProvision: update.autoProvision }),
      clientSecretRef,
    };

    const saved = existing
      ? await this.prisma.client.identityProvider.update({ where: { id: existing.id }, data })
      : await this.prisma.client.identityProvider.create({ data });

    await this.audit.success(AUDIT_ACTIONS.identityProviderUpdated, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: actor.tenantId,
      resourceType: 'identity_provider',
      resourceId: saved.id,
      resourceLabel: saved.name,
      /*
       * What changed, never what it changed to for the secret. `clientSecret`
       * would be redacted by the audit redactor anyway; not passing it at all is
       * the version that does not depend on the redactor being right.
       */
      metadata: {
        fieldsChanged: Object.keys(update).filter((key) => key !== 'clientSecret'),
        // Named to survive redaction. The redactor strips any key starting with
        // "secret" or "credential", which is right — but this is a boolean
        // saying whether a rotation happened, and losing it makes the audit
        // record less useful without making anything safer.
        clientSecretRotated: update.clientSecret !== undefined,
        enabled: saved.enabled,
      },
    });

    return describe(saved, this.derived);
  }

  /**
   * Check the configuration against the provider, and record the answer.
   *
   * The result is stored so the interface can report a real state rather than a
   * hopeful one: "last checked at 14:02 and it worked" is a fact, "configured"
   * is a guess.
   */
  async testConnection(actor: {
    id: string;
    email: string;
    tenantId: string;
  }): Promise<{ ok: boolean; reason?: string; detail?: string; warnings: string[] }> {
    const provider = await this.find();

    if (!provider?.discoveryUrl) {
      return { ok: false, reason: 'not_configured', warnings: [] };
    }

    const outcome = await fetchDiscoveryDocument(provider.discoveryUrl, provider.issuer);

    const message = outcome.ok
      ? outcome.warnings.length > 0
        ? `ok_with_warnings: ${outcome.warnings.join(', ')}`
        : 'ok'
      : `${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ''}`;

    await this.prisma.client.identityProvider.update({
      where: { id: provider.id },
      data: { lastTestedAt: new Date(), lastTestOk: outcome.ok, lastTestMessage: message },
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.identityProviderTested,
      result: outcome.ok ? 'SUCCESS' : 'FAILURE',
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: actor.tenantId,
      resourceType: 'identity_provider',
      resourceId: provider.id,
      metadata: { message },
    });

    if (outcome.ok) {
      // Adopt the issuer the provider announces, once, when nothing was set.
      // Later it is compared rather than overwritten — silently following a
      // changed issuer would defeat the check.
      if (!provider.issuer) {
        await this.prisma.client.identityProvider.update({
          where: { id: provider.id },
          data: { issuer: outcome.document.issuer },
        });
      }
      return { ok: true, warnings: outcome.warnings };
    }

    return {
      ok: false,
      reason: outcome.reason,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
      warnings: [],
    };
  }

  private find(): Promise<IdentityProvider | null> {
    return this.prisma.client.identityProvider.findFirst({ where: { kind: 'OIDC' } });
  }
}

function describe(
  provider: IdentityProvider | null,
  derived: { redirectUri: string; suggestedAppName: string },
): ProviderView {
  return {
    configured: Boolean(provider?.discoveryUrl && provider.clientId),
    enabled: provider?.enabled ?? false,
    name: provider?.name ?? ENTRA_PROVIDER_NAME,
    discoveryUrl: provider?.discoveryUrl ?? null,
    issuer: provider?.issuer ?? null,
    clientId: provider?.clientId ?? null,
    clientSecretSet: Boolean(provider?.clientSecretRef),
    allowedEmailDomains: provider?.allowedEmailDomains ?? [],
    autoProvision: provider?.autoProvision ?? false,
    lastTestedAt: provider?.lastTestedAt?.toISOString() ?? null,
    lastTestOk: provider?.lastTestOk ?? null,
    lastTestMessage: provider?.lastTestMessage ?? null,
    // Stated as a constant, not computed from configuration, because no amount
    // of configuration makes a flow exist that has not been written.
    signInAvailable: false,
    redirectUri: derived.redirectUri,
    suggestedAppName: derived.suggestedAppName,
  };
}
