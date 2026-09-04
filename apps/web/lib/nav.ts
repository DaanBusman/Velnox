/**
 * Primary navigation.
 *
 * Every destination in docs/architecture.md's layout appears here from Phase 1,
 * each carrying the phase that implements it. Sections that do not exist yet
 * resolve to a page that says so and names the phase — rather than being hidden
 * (which would misrepresent the product's shape) or filled with sample data
 * (which would misrepresent reality).
 */

export interface NavItem {
  /** Translation key under `nav`. */
  key: string;
  href: string;
  /** Phase that implements this section. `null` means it works in this build. */
  phase: number | null;
}

export interface NavGroup {
  /** Translation key under `layout`, or `null` for an unlabelled group. */
  labelKey: string | null;
  items: NavItem[];
}

export const NAVIGATION: NavGroup[] = [
  {
    labelKey: null,
    items: [{ key: 'dashboard', href: '/', phase: null }],
  },
  {
    labelKey: null,
    items: [
      { key: 'tenants', href: '/tenants', phase: 3 },
      { key: 'sites', href: '/sites', phase: 3 },
    ],
  },
  {
    labelKey: 'sectionInfrastructure',
    items: [
      { key: 'clusters', href: '/clusters', phase: 4 },
      { key: 'nodes', href: '/nodes', phase: 4 },
      { key: 'virtualMachines', href: '/virtual-machines', phase: 4 },
      { key: 'containers', href: '/containers', phase: 4 },
      { key: 'storage', href: '/storage', phase: 4 },
      { key: 'networks', href: '/networks', phase: 4 },
    ],
  },
  {
    labelKey: 'sectionOperations',
    items: [
      { key: 'updates', href: '/updates', phase: 6 },
      { key: 'majorUpgrades', href: '/major-upgrades', phase: 8 },
      { key: 'migrations', href: '/migrations', phase: 11 },
      { key: 'automation', href: '/automation', phase: 8 },
      { key: 'jobs', href: '/jobs', phase: 5 },
      { key: 'alerts', href: '/alerts', phase: 4 },
      { key: 'reports', href: '/reports', phase: 8 },
    ],
  },
  {
    labelKey: 'sectionAdministration',
    items: [
      { key: 'users', href: '/users', phase: null },
      { key: 'rolesPermissions', href: '/roles', phase: 2 },
      { key: 'auditLog', href: '/audit-log', phase: 2 },
      { key: 'security', href: '/settings/security', phase: null },
      { key: 'sso', href: '/settings/sso', phase: null },
      { key: 'settings', href: '/settings/about', phase: null },
    ],
  },
];

const BY_HREF = new Map<string, NavItem>(
  NAVIGATION.flatMap((group) => group.items).map((item) => [item.href, item]),
);

/** Look up a nav entry for a path, so an unknown URL can still 404 properly. */
export const findNavItem = (href: string): NavItem | undefined => BY_HREF.get(href);
