import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_ATTRIBUTION, UPSTREAM_PRODUCT_NAME } from '@velnox/shared';

/**
 * The attribution survives rebranding.
 *
 * Velnox is deliberately white-labellable: `system_settings.product_name` drives
 * the name everywhere in the interface, which is a legitimate thing for an MSP
 * to do. AGPLv3 section 7(b) is where the boundary of that sits — the notice in
 * the Appropriate Legal Notices has to be preserved, including by a copy
 * distributed under another name.
 *
 * A licence term is only worth the code that enforces it, and the failure mode
 * here is quiet: someone refactors the source offer to build its strings from
 * settings "for consistency", every screen still looks right, and the one line
 * the licence names is now editable by the party it binds. So this pins it.
 */

// `vi.hoisted` because `vi.mock` is lifted above the imports: a plain const
// declared here would still be in its temporal dead zone when the factory runs.
const { ensureSystemSettings } = vi.hoisted(() => ({ ensureSystemSettings: vi.fn() }));
vi.mock('@velnox/db', () => ({ ensureSystemSettings }));

import { SystemService } from './system.service';

const CONFIG = {
  VELNOX_VERSION: '9.9.9',
  VELNOX_BUILD_COMMIT: 'abc1234',
  VELNOX_BUILD_TIME: '',
  VELNOX_SOURCE_URL: 'https://github.com/DaanBusman/Velnox',
  NODE_ENV: 'test',
  VELNOX_DEFAULT_LOCALE: 'en',
  METRICS_ENABLED: false,
} as never;

const service = (productName: string) => {
  ensureSystemSettings.mockResolvedValue({
    productName,
    defaultLocale: 'en',
    defaultTimezone: 'Europe/Amsterdam',
    initialized: true,
    sourceUrl: null,
  });
  return new SystemService(CONFIG, { client: {} } as never);
};

describe('the source offer', () => {
  it('carries the attribution verbatim', async () => {
    const offer = await service(UPSTREAM_PRODUCT_NAME).source();
    expect(offer.attribution).toBe(REQUIRED_ATTRIBUTION);
  });

  it('still carries it when the installation has been rebranded', async () => {
    // The case the licence term exists for.
    const offer = await service('Contoso Cloud Console').source();

    expect(offer.product).toBe('Contoso Cloud Console');
    expect(offer.attribution).toBe(REQUIRED_ATTRIBUTION);
    expect(offer.attribution).toContain(UPSTREAM_PRODUCT_NAME);
  });

  it('does not build the attribution out of the product name', async () => {
    // The refactor this guards against: composing the notice from settings
    // would leave it correct on an unmodified install and empty of Velnox on a
    // rebranded one.
    const offer = await service('Contoso Cloud Console').source();
    expect(offer.attribution).not.toContain('Contoso');
  });
});

describe('REQUIRED_ATTRIBUTION', () => {
  it('names the project, the holder and the licence', () => {
    // What section 7(b) lets us require is "specified reasonable legal notices
    // or author attributions". Each of these three is why it qualifies.
    expect(REQUIRED_ATTRIBUTION).toContain('Velnox');
    expect(REQUIRED_ATTRIBUTION).toContain('The Velnox Foundation');
    expect(REQUIRED_ATTRIBUTION).toMatch(/Affero General Public License/);
  });

  it('is a constant, not a template', () => {
    // No interpolation holes: a notice with a placeholder in it is a notice
    // somebody fills in.
    expect(REQUIRED_ATTRIBUTION).not.toMatch(/\{|\}|\$\{/);
  });
});
