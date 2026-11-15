import { describe, expect, it } from 'vitest';
import {
  linuxTemplateSchema,
  parseTenantSecretKey,
  perTenantAccount,
  requiredTemplateSecrets,
  tenantSecretKey,
  VIRTIO_WIN_PATTERN,
  windowsTemplateSchema,
  type TemplateSettings,
} from './autoconfig';

const windows = (extra: Record<string, unknown> = {}) =>
  windowsTemplateSchema.parse({
    family: 'WINDOWS',
    isoFilename: 'win.iso',
    imageName: 'Windows Server 2025 Standard',
    virtioIsoFilename: 'virtio-win.iso',
    ...extra,
  }) as TemplateSettings;

const linux = (extra: Record<string, unknown> = {}) =>
  linuxTemplateSchema.parse({
    family: 'LINUX',
    distribution: 'UBUNTU',
    imageFilename: 'noble.img',
    users: [{ name: 'ops', password: 'GENERATE' }],
    ...extra,
  }) as TemplateSettings;

const TENANT = '5b0c8f9e-2d4a-4c1e-9f3b-7a6d2e1c0b9a';
const delivery = { credentialDelivery: 'VELNOX_ONLY', pdfPasswordSource: 'SHOWN_ONCE' } as const;

describe('a password per tenant', () => {
  it('is the Administrator on Windows and root on Linux', () => {
    expect(perTenantAccount(windows({ administratorPassword: 'PER_TENANT' }))).toBe(
      'administrator',
    );
    expect(perTenantAccount(linux({ root: { password: 'PER_TENANT' } }))).toBe('root');
    expect(perTenantAccount(windows({ administratorPassword: 'FIXED' }))).toBeNull();
    expect(perTenantAccount(linux())).toBeNull();
  });

  it('is not offered for other accounts', () => {
    expect(() =>
      windows({ accounts: [{ name: 'beheer', administrator: true, password: 'PER_TENANT' }] }),
    ).toThrow();
    expect(() => linux({ users: [{ name: 'ops', password: 'PER_TENANT' }] })).toThrow();
  });

  it('never makes a template incomplete: a tenant without one gets one generated', () => {
    expect(
      requiredTemplateSecrets(windows({ administratorPassword: 'PER_TENANT' }), delivery),
    ).toEqual([]);
    expect(requiredTemplateSecrets(linux({ root: { password: 'PER_TENANT' } }), delivery)).toEqual(
      [],
    );
  });

  it('counts as a way in for a Linux machine', () => {
    expect(() =>
      linux({
        users: [{ name: 'ops', password: 'NONE' }],
        ssh: { enabled: false },
        root: { allowLogin: true, password: 'PER_TENANT' },
      }),
    ).not.toThrow();
  });

  it('is stored under a key that names the tenant, and is read back from it', () => {
    const key = tenantSecretKey(TENANT, 'administrator');
    expect(key).toBe(`tenant:${TENANT}:administrator`);
    expect(parseTenantSecretKey(key)).toEqual({ tenantId: TENANT, account: 'administrator' });
    expect(parseTenantSecretKey(`tenant:${TENANT.toUpperCase()}:root`)).toEqual({
      tenantId: TENANT,
      account: 'root',
    });
    expect(parseTenantSecretKey('administrator')).toBeNull();
    expect(parseTenantSecretKey(`tenant:${TENANT}:productKey`)).toBeNull();
    expect(parseTenantSecretKey('tenant:not-a-tenant:root')).toBeNull();
  });
});

describe('VirtIO ISO: Yes (0.7.20)', () => {
  const base = { family: 'WINDOWS', isoFilename: 'win.iso', imageName: 'Windows Server 2025 Standard' };

  it('needs no filename: the library has one or Velnox fetches it', () => {
    const parsed = windowsTemplateSchema.safeParse({ ...base, virtioIsoAuto: true });
    expect(parsed.success).toBe(true);
  });

  it('still needs one or the other for the drivers and the guest agent', () => {
    const parsed = windowsTemplateSchema.safeParse({ ...base });
    expect(parsed.success).toBe(false);
  });

  it('is not both a chosen file and Yes', () => {
    const parsed = windowsTemplateSchema.safeParse({
      ...base,
      virtioIsoAuto: true,
      virtioIsoFilename: 'virtio-win.iso',
    });
    expect(parsed.success).toBe(false);
  });

  it('defaults to off, so a template saved before keeps its chosen file', () => {
    expect(windowsTemplateSchema.parse({ ...base, virtioIsoFilename: 'virtio-win.iso' }).virtioIsoAuto).toBe(false);
  });

  it('recognises the VirtIO ISOs a library may already hold', () => {
    for (const name of ['virtio-win.iso', 'VirtIO-Win-0.1.271.iso', 'virtio-win-gt.iso']) {
      expect(VIRTIO_WIN_PATTERN.test(name)).toBe(true);
    }
    for (const name of ['virtio.iso', 'win11.iso', 'virtio-win.iso.part']) {
      expect(VIRTIO_WIN_PATTERN.test(name)).toBe(false);
    }
  });
});

describe('the display language (0.7.20)', () => {
  const ui = (tag: string) =>
    windowsTemplateSchema.safeParse({
      family: 'WINDOWS',
      isoFilename: 'win.iso',
      imageName: 'Windows Server 2025 Standard',
      virtioIsoFilename: 'virtio-win.iso',
      locale: { uiLanguage: tag },
    }).success;

  it('takes any language an ISO can carry, not only the fixed list', () => {
    expect(ui('cs-CZ')).toBe(true);
    expect(ui('sr-Latn-RS')).toBe(true);
    expect(ui('nl-NL')).toBe(true);
  });

  it('refuses what is not a language tag', () => {
    expect(ui('dutch')).toBe(false);
    expect(ui('nl')).toBe(false);
    expect(ui('nl-NL<x>')).toBe(false);
  });
});
