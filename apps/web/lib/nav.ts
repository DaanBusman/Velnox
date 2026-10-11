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
  /**
   * Other paths that belong to this entry, so it stays highlighted on them.
   *
   * One use: building VMs. Its pages live under `/provisioning` — the mailed
   * links to a record point there — but it is reached from Virtual Machines,
   * which is where a VM being built is shown.
   */
  alsoMatches?: string[];
  /**
   * Shown to a customer only when they reach more than one tenant — a main
   * tenant with sub-tenants, or several sub-tenants (Phase 5C). MSP staff
   * always see it. A list of one is not worth a menu entry.
   */
  needsSeveralTenants?: boolean;
}

/** Who is looking, for the entries that depend on more than permissions. */
export interface NavViewer {
  isMspRoot: boolean;
  reachableTenants: number;
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
      {
        key: 'tenants',
        href: '/tenants',
        phase: null,
        requiresPermission: 'tenants.read',
        needsSeveralTenants: true,
      },
      { key: 'sites', href: '/sites', phase: null, requiresPermission: 'sites.read' },
    ],
  },
  {
    labelKey: 'sectionInfrastructure',
    items: [
      { key: 'clusters', href: '/clusters', phase: null, requiresPermission: 'clusters.read' },
      { key: 'nodes', href: '/nodes', phase: null, requiresPermission: 'nodes.read' },
      {
        key: 'virtualMachines',
        href: '/virtual-machines',
        phase: null,
        requiresPermission: 'workloads.read',
        alsoMatches: ['/provisioning'],
      },
      { key: 'containers', href: '/containers', phase: null, requiresPermission: 'workloads.read' },
      { key: 'storage', href: '/storage', phase: null, requiresPermission: 'storage.read' },
      { key: 'networks', href: '/networks', phase: null, requiresPermission: 'networks.read' },
      { key: 'library', href: '/library', phase: null, requiresPermission: 'library.read' },
    ],
  },
  {
    labelKey: 'sectionOperations',
    items: [
      // Updates and major upgrades are one destination, as the owner asked:
      // minor updates (Phase 6) and major upgrades (Phases 8–9B) of the same
      // nodes are read side by side.
      {
        key: 'updates',
        href: '/updates',
        phase: null,
        requiresPermission: 'updates.read',
        alsoMatches: ['/major-upgrades'],
      },
      { key: 'migrations', href: '/migrations', phase: 11 },
      { key: 'automation', href: '/automation', phase: 8 },
      {
        key: 'autoconfig',
        href: '/autoconfig',
        phase: null,
        requiresPermission: 'autoconfig.read',
      },
      { key: 'jobs', href: '/jobs', phase: null, requiresPermission: 'jobs.read' },
      { key: 'alerts', href: '/alerts', phase: null, requiresPermission: 'alerts.read' },
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
      // Open to everyone, for two reasons. It holds per-viewer preferences,
      // which every account has; and it carries the source offer, which AGPL
      // section 13 requires to be reachable by anyone interacting with the
      // software — Server management, where the fuller version lives, is
      // administrators only.
      { key: 'settings', href: '/settings', phase: null },
    ],
  },
  {
    // How Velnox tells people things. Mail first; other channels join it here.
    labelKey: 'sectionNotifications',
    items: [
      { key: 'mail', href: '/settings/mail', phase: null, requiresPermission: 'system.manage' },
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
export function isNavItemVisible(
  item: NavItem,
  permissions: ReadonlySet<string>,
  viewer?: NavViewer,
): boolean {
  if (item.requiresPermission && !permissions.has(item.requiresPermission)) return false;
  if (item.supersededBy && permissions.has(item.supersededBy)) return false;
  if (item.needsSeveralTenants && viewer && !viewer.isMspRoot && viewer.reachableTenants < 2) {
    return false;
  }
  return true;
}

/** How closely an entry matches a path: the length of its matching prefix, or -1. */
function matchLength(item: NavItem, pathname: string): number {
  if (item.href === '/') return pathname === '/' ? 1 : -1;
  return Math.max(
    -1,
    ...[item.href, ...(item.alsoMatches ?? [])]
      .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
      .map((href) => href.length),
  );
}

/**
 * The one entry to highlight at this path: the most specific match among the
 * entries shown. `/settings/security` lights Security, not Settings as well —
 * a prefix match alone lit both.
 */
export function activeNavHref(items: NavItem[], pathname: string): string | null {
  let best: { href: string; length: number } | null = null;
  for (const item of items) {
    const length = matchLength(item, pathname);
    if (length > (best?.length ?? -1)) best = { href: item.href, length };
  }
  return best?.href ?? null;
}

const BY_HREF = new Map<string, NavItem>(
  NAVIGATION.flatMap((group) => group.items).flatMap((item) =>
    [item.href, ...(item.alsoMatches ?? [])].map((href) => [href, item] as const),
  ),
);

/** Look up a nav entry for a path, so an unknown URL can still 404 properly. */
export const findNavItem = (href: string): NavItem | undefined => BY_HREF.get(href);
