import { X509Certificate, createPrivateKey, type KeyObject } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ApiConfig } from '@velnox/config';
import type { TlsMode as DbTlsMode } from '@velnox/db';
import {
  ERROR_CODES,
  VelnoxError,
  type TlsChangeRequest,
  type TlsChangeResponse,
  type TlsStatusResponse,
} from '@velnox/shared';
import { API_CONFIG } from '../../config/config.module';
import { PrismaService } from '../infrastructure/prisma.service';
import { SecretStoreService } from '../auth/secret-store.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import type { Actor } from '../../common/actor';
import { CaddyAdminService } from './caddy-admin.service';
import { TlsService } from './tls.service';

/**
 * Changing the certificate from Server management (Phase 5C, ADR-045).
 *
 * **Where the choice lives.** In `system_settings`, with an uploaded key in the
 * secret store. The files Caddy reads — `tls.caddy`, and the certificate, key
 * or ACME root it names — are written from there into a volume only Caddy and
 * the API mount, at start-up and on every change. Losing that volume loses
 * nothing; a restart writes it again.
 *
 * **How it is applied.** The files are written, then Caddy is asked through its
 * admin socket to load the Caddyfile again. Caddy either serves the new
 * certificate or refuses the configuration and keeps the old one; on a refusal
 * the previous files are put back, so a later restart does not pick up what
 * Caddy refused. Only then is the choice stored, and the certificate actually
 * served is read back over a real handshake.
 *
 * **Handing it back.** Choosing "the installer's" — or running scripts/tls.sh on
 * the host, which is the way back when the interface cannot be reached — makes
 * `tls.caddy` one line importing the installer's file again.
 */

/** Where Caddy sees the files this writes: the same volume, mounted read-only. */
const CADDY_DIR = '/etc/caddy/managed';
const FILES = {
  directive: 'tls.caddy',
  certificate: 'velnox.crt',
  key: 'velnox.key',
  acmeRoot: 'acme-ca.pem',
} as const;
/** A handshake after a reload: how long to wait for the new certificate to be the one served. */
const VERIFY_ATTEMPTS = 12;
const VERIFY_INTERVAL_MS = 1000;
const CADDY_INTERNAL_ISSUER = /Caddy Local Authority/i;

interface Desired {
  mode: DbTlsMode | null;
  acmeEmail: string | null;
  acmeDirectory: string | null;
  acmeCaRoot: string | null;
  certificatePem: string | null;
  keyPem: string | null;
}

type FileSet = Record<(typeof FILES)[keyof typeof FILES], string | null>;

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

export function certificatesIn(pem: string): string[] {
  return pem.match(PEM_CERTIFICATE) ?? [];
}

/**
 * An uploaded certificate and key, checked the way scripts/tls.sh checks them:
 * a certificate, a key that is readable without a passphrase and belongs to
 * it, not expired. A certificate that does not cover the address, or comes
 * without its chain, is a warning — an operator may be installing ahead of a
 * DNS change.
 */
export function checkCertificate(
  certificatePem: string,
  keyPem: string,
  siteAddress: string,
  now = new Date(),
): { certificate: string; key: string; leaf: X509Certificate; warnings: string[] } {
  const blocks = certificatesIn(certificatePem);
  let leaf: X509Certificate;
  try {
    if (blocks.length === 0) throw new Error('no certificate');
    leaf = new X509Certificate(blocks[0]!);
    for (const block of blocks.slice(1)) new X509Certificate(block);
  } catch {
    throw new VelnoxError(ERROR_CODES.tlsCertificateInvalid, { status: 400 });
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: keyPem, format: 'pem' });
  } catch {
    throw new VelnoxError(ERROR_CODES.tlsKeyInvalid, { status: 400 });
  }
  if (!leaf.checkPrivateKey(key)) {
    throw new VelnoxError(ERROR_CODES.tlsKeyMismatch, { status: 400 });
  }
  if (new Date(leaf.validTo).getTime() <= now.getTime()) {
    throw new VelnoxError(ERROR_CODES.tlsCertificateExpired, {
      status: 400,
      params: { notAfter: new Date(leaf.validTo).toISOString() },
    });
  }
  const warnings: string[] = [];
  const isIp = /^\d+\.\d+\.\d+\.\d+$|:/.test(siteAddress);
  const covers = isIp ? leaf.checkIP(siteAddress) : leaf.checkHost(siteAddress);
  if (!covers) warnings.push('tls.warning_not_covering');
  if (blocks.length === 1 && leaf.issuer !== leaf.subject) warnings.push('tls.warning_no_chain');
  return {
    certificate: `${blocks.join('\n')}\n`,
    key: key.export({ type: 'pkcs8', format: 'pem' }).toString(),
    leaf,
    warnings,
  };
}

/** The directive Caddy imports, from the choice. Values were validated before they got here. */
export function directiveFor(desired: Desired): string {
  const header =
    '# Written by Velnox from the certificate chosen in Server management (ADR-045).\n';
  switch (desired.mode) {
    case null:
      return `${header}# None is chosen: the installer's, from VELNOX_TLS.\nimport /etc/caddy/tls/tls.caddy\n`;
    case 'INTERNAL':
      return `${header}tls internal\n`;
    case 'CERTIFICATE':
      return `${header}tls ${CADDY_DIR}/${FILES.certificate} ${CADDY_DIR}/${FILES.key}\n`;
    case 'ACME':
      if (!desired.acmeDirectory) return `${header}tls ${desired.acmeEmail}\n`;
      return (
        `${header}tls ${desired.acmeEmail} {\n` +
        `\tca ${desired.acmeDirectory}\n` +
        (desired.acmeCaRoot ? `\tca_root ${CADDY_DIR}/${FILES.acmeRoot}\n` : '') +
        '}\n'
      );
  }
}

@Injectable()
export class TlsConfigService implements OnModuleInit {
  private readonly logger = new Logger(TlsConfigService.name);
  private readonly dir: string;

  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    private readonly prisma: PrismaService,
    private readonly secrets: SecretStoreService,
    private readonly audit: AuditService,
    private readonly caddy: CaddyAdminService,
    private readonly tls: TlsService,
  ) {
    this.dir = config.VELNOX_TLS_MANAGED_DIR;
  }

  /**
   * Write Caddy's files from what is stored, before Caddy starts — it waits for
   * the API to be healthy. When Caddy is already running and the files changed
   * (the volume was lost, or scripts/tls.sh handed the choice back), it is asked
   * to load them; when it is not, there is nothing to ask.
   */
  async onModuleInit(): Promise<void> {
    try {
      const desired = await this.stored();
      const changed = await this.write(await this.filesFor(desired));
      if (changed) await this.caddy.reload().catch(() => undefined);
    } catch (error) {
      // Never a reason not to start: the API is what someone needs to fix it.
      this.logger.error(
        `Could not write the certificate files: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  private async stored(): Promise<Desired> {
    const row = await this.prisma.client.systemSettings.findUnique({ where: { id: 1 } });
    if (!row?.tlsMode) {
      return {
        mode: null,
        acmeEmail: null,
        acmeDirectory: null,
        acmeCaRoot: null,
        certificatePem: null,
        keyPem: null,
      };
    }
    let keyPem: string | null = null;
    if (row.tlsMode === 'CERTIFICATE' && row.tlsKeyCredentialId) {
      keyPem = await this.readKey(row.tlsKeyCredentialId);
    }
    return {
      mode: row.tlsMode,
      acmeEmail: row.tlsAcmeEmail,
      acmeDirectory: row.tlsAcmeDirectory,
      acmeCaRoot: row.tlsAcmeCaRoot,
      certificatePem: row.tlsCertificatePem,
      keyPem,
    };
  }

  private async readKey(credentialId: string): Promise<string> {
    const secret = await this.prisma.client.credentialSecret.findFirst({
      where: { credentialId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!secret) throw new Error('The stored certificate key is missing');
    return (await this.secrets.get(secret.id)).toString('utf8');
  }

  private async filesFor(desired: Desired): Promise<FileSet> {
    return {
      [FILES.directive]: directiveFor(desired),
      [FILES.certificate]: desired.mode === 'CERTIFICATE' ? desired.certificatePem : null,
      [FILES.key]: desired.mode === 'CERTIFICATE' ? desired.keyPem : null,
      [FILES.acmeRoot]: desired.mode === 'ACME' ? desired.acmeCaRoot : null,
    } as FileSet;
  }

  private async current(): Promise<FileSet> {
    const out = {} as FileSet;
    for (const name of Object.values(FILES)) {
      out[name] = await readFile(join(this.dir, name), 'utf8').catch(() => null);
    }
    return out;
  }

  /**
   * Make the directory hold exactly these files. Each is written beside its
   * place and renamed into it, so Caddy never reads half of one; the key is
   * readable by its owner only. Returns whether anything changed.
   */
  private async write(files: FileSet): Promise<boolean> {
    const before = await this.current();
    let changed = false;
    for (const [name, content] of Object.entries(files)) {
      const path = join(this.dir, name);
      if (before[name as keyof FileSet] === content) continue;
      changed = true;
      if (content === null) {
        await rm(path, { force: true });
        continue;
      }
      const temp = join(this.dir, `.${name}.new`);
      await writeFile(temp, content, { mode: name === FILES.key ? 0o600 : 0o644 });
      await chmod(temp, name === FILES.key ? 0o600 : 0o644);
      await rename(temp, path);
    }
    return changed;
  }

  async apply(request: TlsChangeRequest, actor: Actor): Promise<TlsChangeResponse> {
    const siteAddress = this.tls.siteAddress();
    const previous = await this.stored();
    const warnings: string[] = [];
    let fingerprint: string | null = null;
    let names: string[] = [];
    let notAfter: string | null = null;

    const desired: Desired = {
      mode: null,
      acmeEmail: null,
      acmeDirectory: null,
      acmeCaRoot: null,
      certificatePem: null,
      keyPem: null,
    };
    switch (request.mode) {
      case 'installer':
        break;
      case 'internal':
        desired.mode = 'INTERNAL';
        break;
      case 'acme':
        if (/^[\d.]+$|:/.test(siteAddress)) {
          throw new VelnoxError(ERROR_CODES.tlsAcmeNeedsHostname, {
            status: 400,
            params: { address: siteAddress },
          });
        }
        desired.mode = 'ACME';
        desired.acmeEmail = request.email;
        desired.acmeDirectory = request.directory ?? null;
        if (request.caRoot) {
          const roots = certificatesIn(request.caRoot);
          try {
            if (roots.length === 0) throw new Error('none');
            for (const root of roots) new X509Certificate(root);
          } catch {
            throw new VelnoxError(ERROR_CODES.tlsCertificateInvalid, {
              status: 400,
              params: { field: 'caRoot' },
            });
          }
          desired.acmeCaRoot = `${roots.join('\n')}\n`;
        }
        break;
      case 'certificate': {
        const checked = checkCertificate(request.certificate, request.key, siteAddress);
        desired.mode = 'CERTIFICATE';
        desired.certificatePem = checked.certificate;
        desired.keyPem = checked.key;
        warnings.push(...checked.warnings);
        fingerprint = checked.leaf.fingerprint256;
        names = (checked.leaf.subjectAltName ?? '')
          .split(',')
          .map((n) => n.trim().replace(/^(DNS|IP Address):/i, ''))
          .filter(Boolean);
        notAfter = new Date(checked.leaf.validTo).toISOString();
        break;
      }
    }

    // Applied first, stored after: what is stored is what Caddy accepted.
    const before = await this.current();
    await this.write(await this.filesFor(desired));
    try {
      await this.caddy.reload();
    } catch (error) {
      await this.write(before).catch(() => undefined);
      await this.caddy.reload().catch(() => undefined);
      await this.audit.failure(AUDIT_ACTIONS.systemTlsChanged, {
        actorType: 'USER',
        actorId: actor.id,
        actorLabel: actor.email,
        tenantId: actor.tenantId,
        resourceType: 'tls',
        metadata: {
          to: request.mode,
          reason: error instanceof VelnoxError ? error.code : 'unknown',
        },
      });
      throw error;
    }

    let keyCredentialId: string | null = null;
    if (desired.mode === 'CERTIFICATE' && desired.keyPem) {
      keyCredentialId = (
        await this.secrets.putForCredential({
          kind: 'TLS_PRIVATE_KEY',
          material: desired.keyPem,
          label: `Certificate key for ${siteAddress}`,
        })
      ).credentialId;
    }
    const old = await this.prisma.client.systemSettings.findUnique({
      where: { id: 1 },
      select: { tlsKeyCredentialId: true },
    });
    await this.prisma.client.systemSettings.update({
      where: { id: 1 },
      data: {
        tlsMode: desired.mode,
        tlsAcmeEmail: desired.acmeEmail,
        tlsAcmeDirectory: desired.acmeDirectory,
        tlsAcmeCaRoot: desired.acmeCaRoot,
        tlsCertificatePem: desired.certificatePem,
        tlsKeyCredentialId: keyCredentialId,
        tlsChangedAt: desired.mode ? new Date() : null,
        tlsChangedBy: desired.mode ? actor.email : null,
      },
    });
    if (old?.tlsKeyCredentialId) {
      await this.secrets.deleteCredential(old.tlsKeyCredentialId).catch(() => undefined);
    }

    const { status, verified } = await this.verify(request.mode, fingerprint);
    await this.audit.success(AUDIT_ACTIONS.systemTlsChanged, {
      actorType: 'USER',
      actorId: actor.id,
      actorLabel: actor.email,
      tenantId: actor.tenantId,
      resourceType: 'tls',
      resourceLabel: siteAddress,
      metadata: {
        from: previous.mode?.toLowerCase() ?? 'installer',
        to: request.mode,
        verified,
        ...(request.mode === 'acme'
          ? { account: request.email, directory: request.directory ?? null }
          : {}),
        ...(fingerprint ? { fingerprint, names, notAfter } : {}),
        ...(warnings.length ? { warnings } : {}),
      },
    });
    return { status, verified, warnings };
  }

  /**
   * Read back what Caddy serves until it is what was asked for, for a few
   * seconds. ACME issuance can take longer; then this says "not yet".
   */
  private async verify(
    mode: TlsChangeRequest['mode'],
    fingerprint: string | null,
  ): Promise<{ status: TlsStatusResponse; verified: boolean }> {
    let status = await this.tls.status();
    for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
      const served = status.certificate;
      const ok =
        mode === 'installer'
          ? status.reachable
          : mode === 'internal'
            ? Boolean(served && CADDY_INTERNAL_ISSUER.test(served.issuer))
            : mode === 'certificate'
              ? Boolean(served && served.fingerprintSha256 === fingerprint)
              : Boolean(served && !CADDY_INTERNAL_ISSUER.test(served.issuer));
      if (ok) return { status, verified: true };
      await new Promise((resolve) => setTimeout(resolve, VERIFY_INTERVAL_MS));
      status = await this.tls.status();
    }
    return { status, verified: false };
  }
}
