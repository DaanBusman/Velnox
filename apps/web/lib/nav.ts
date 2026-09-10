/**
 * Primary navigation.
 *
 * Every destination in docs/architecture.md's layout appears here from Phase 1,
 * each carrying the phase that implements it. Sections that do not exist yet
 * resolve to a page that says so and names the phase — rather than being hidden
 * (which would misrepresent the product's shape) or filled with sample data
 * (which would misrepresent reality).
 *
 * Permission gating here is a courtesy, never the control: the API refuses the
 * request regardless. What it buys is a sidebar that does not offer an
 * administrator's colleague six links that all end in a refusal.
 */

export interface NavItem {
  /** Translation key under `nav`. */
  key: string;
  href: string;
  /** Phase that implements this section. `null` means it works in this build. */
  phase: number | null;
  /** Shown only to someone holding this permission. Absent means everyone. */
  requiresPermission?: string;
  /**
   * Hidden from someone holding this permission, because a better home for it
   * exists for them.
   *
   * One use: the audit log. It lives in Server management for whoever can open
   * that, and stays in the sidebar for an auditor who holds `audit.read` and
   * nothing else — otherwise moving it would have taken the audit log away from
   * exactly the role that exists to read it.
   */
  supersededBy?: string;
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
      { key: 'rolesPermissions', href: '/roles', phase: null },
      {
        key: 'auditLog',
        href: '/audit-log',
        phase: null,
        requiresPermission: 'audit.read',
        supersededBy: 'system.manage',
      },
      { key: 'security', href: '/settings/security', phase: null },
      { key: 'sso', href: '/settings/sso', phase: null, requiresPermission: 'system.manage' },
      // About stays open to everyone: AGPL section 13 requires the source offer
      // to be reachable by anyone interacting with the software, not only by an
      // administrator.
      { key: 'settings', href: '/settings/about', phase: null },
    ],
  },
  {
    // Its own group at the end: the documentation is not an administration
    // task, and everyone who can sign in can read it.
    labelKey: null,
    items: [{ key: 'documentation', href: '/docs', phase: null }],
  },
];

/** Whether this entry should appear for someone holding these permissions. */
export function isNavItemVisible(item: NavItem, permissions: ReadonlySet<string>): boolean {
  if (item.requiresPermission && !permissions.has(item.requiresPermission)) return false;
  if (item.supersededBy && permissions.has(item.supersededBy)) return false;
  return true;
}

const BY_HREF = new Map<string, NavItem>(
  NAVIGATION.flatMap((group) => group.items).map((item) => [item.href, item]),
);

/** Look up a nav entry for a path, so an unknown URL can still 404 properly. */
export const findNavItem = (href: string): NavItem | undefined => BY_HREF.get(href);
