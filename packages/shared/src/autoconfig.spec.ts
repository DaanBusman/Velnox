import { describe, expect, it } from 'vitest';
import {
  linuxTemplateSchema,
  parseTenantSecretKey,
  perTenantAccount,
  requiredTemplateSecrets,
  tenantSecretKey,
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
