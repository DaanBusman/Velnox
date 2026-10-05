import { describe, expect, it } from 'vitest';
import { NAVIGATION, activeNavHref, findNavItem, isNavItemVisible } from './nav';

const items = NAVIGATION.flatMap((group) => group.items);

describe('activeNavHref', () => {
  it('lights only the most specific entry', () => {
    // A prefix match alone lit Settings as well as each of these.
    expect(activeNavHref(items, '/settings/security')).toBe('/settings/security');
    expect(activeNavHref(items, '/settings/mail')).toBe('/settings/mail');
    expect(activeNavHref(items, '/settings')).toBe('/settings');
  });

  it('keeps an entry lit on the pages that belong to it', () => {
    expect(activeNavHref(items, '/provisioning/abc')).toBe('/virtual-machines');
    expect(activeNavHref(items, '/clusters/abc')).toBe('/clusters');
    expect(activeNavHref(items, '/major-upgrades')).toBe('/updates');
  });

  it('does not light the dashboard for every page', () => {
    expect(activeNavHref(items, '/')).toBe('/');
    expect(activeNavHref(items, '/library')).toBe('/library');
  });
});

describe('the navigation', () => {
  it('has single sign-on inside Security, not as an entry of its own', () => {
    expect(items.some((item) => item.key === 'sso')).toBe(false);
  });

  it('has one entry for updates and major upgrades', () => {
    expect(items.some((item) => item.key === 'majorUpgrades')).toBe(false);
    expect(findNavItem('/major-upgrades')?.key).toBe('updates');
  });
});

describe('Tenants in the sidebar (Phase 5C)', () => {
  const tenants = items.find((item) => item.key === 'tenants')!;
  const held = new Set(['tenants.read']);

  it('is shown to MSP staff', () => {
    expect(isNavItemVisible(tenants, held, { isMspRoot: true, reachableTenants: 1 })).toBe(true);
  });

  it('is shown to a customer who reaches several tenants, and not to one who reaches one', () => {
    expect(isNavItemVisible(tenants, held, { isMspRoot: false, reachableTenants: 3 })).toBe(true);
    expect(isNavItemVisible(tenants, held, { isMspRoot: false, reachableTenants: 1 })).toBe(false);
  });
});
