import type { ReactElement, SVGProps } from 'react';

/**
 * The icon set.
 *
 * Hand-written rather than pulled from an icon package, for the same reason the
 * layout primitives are: the whole product needs about two dozen glyphs, and a
 * dependency shipping two thousand of them would be carried into every licence
 * review for no benefit. These are one consistent family — 16px grid, 1.5
 * stroke, round caps, `currentColor` — so they inherit their colour from the
 * thing they sit in and stay legible in both themes without a second set.
 *
 * They are decorative. Every one of them sits next to its own label, so they are
 * `aria-hidden` and never the only way to tell two things apart.
 */

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className="size-4 shrink-0"
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconDashboard = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2" y="2" width="5" height="6" rx="1" />
    <rect x="9" y="2" width="5" height="4" rx="1" />
    <rect x="2" y="10" width="5" height="4" rx="1" />
    <rect x="9" y="8" width="5" height="6" rx="1" />
  </Icon>
);

export const IconTenants = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 14V4l5-2v12" />
    <path d="M7 14V7l7 2v5" />
    <path d="M2 14h12" />
    <path d="M10 11h1M4 6h1M4 9h1" />
  </Icon>
);

export const IconSites = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 14s5-4.2 5-8A5 5 0 0 0 3 6c0 3.8 5 8 5 8Z" />
    <circle cx="8" cy="6" r="1.75" />
  </Icon>
);

export const IconClusters = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="3.5" r="2" />
    <circle cx="3.5" cy="12" r="2" />
    <circle cx="12.5" cy="12" r="2" />
    <path d="M6.6 5.1 4.6 10.3M9.4 5.1l2 5.2M5.5 12h5" />
  </Icon>
);

export const IconNodes = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2" y="3" width="12" height="4" rx="1" />
    <rect x="2" y="9" width="12" height="4" rx="1" />
    <path d="M4.5 5h.01M4.5 11h.01" />
  </Icon>
);

export const IconVirtualMachine = (p: IconProps) => (
  <Icon {...p}>
    <rect x="1.75" y="3" width="12.5" height="8" rx="1.5" />
    <path d="M5.5 13.5h5M8 11v2.5" />
  </Icon>
);

export const IconContainer = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 1.75 14 5v6l-6 3.25L2 11V5Z" />
    <path d="M2 5l6 3.25L14 5M8 8.25v6" />
  </Icon>
);

export const IconStorage = (p: IconProps) => (
  <Icon {...p}>
    <ellipse cx="8" cy="3.75" rx="5.5" ry="2" />
    <path d="M2.5 3.75v8.5c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-8.5" />
    <path d="M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" />
  </Icon>
);

export const IconNetwork = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M1.75 8h12.5" />
    <path d="M8 1.75c1.6 1.7 2.5 3.9 2.5 6.25S9.6 12.55 8 14.25C6.4 12.55 5.5 10.35 5.5 8S6.4 3.45 8 1.75Z" />
  </Icon>
);

export const IconUpdates = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2.5v7" />
    <path d="M5.25 7 8 9.75 10.75 7" />
    <path d="M2.5 11.5v1a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1" />
  </Icon>
);

export const IconUpgrades = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 13.5v-7" />
    <path d="M5.25 9 8 6.25 10.75 9" />
    <path d="M2.5 3.5h11" />
  </Icon>
);

export const IconMigrations = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 5.5h9" />
    <path d="M8.5 3 11 5.5 8.5 8" />
    <path d="M14 10.5H5" />
    <path d="M7.5 8 5 10.5 7.5 13" />
  </Icon>
);

export const IconAutomation = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.5v1.7M8 12.8v1.7M14.5 8h-1.7M3.2 8H1.5M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2M12.6 12.6l-1.2-1.2M4.6 4.6 3.4 3.4" />
  </Icon>
);

export const IconJobs = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 4.5V8l2.5 1.5" />
  </Icon>
);

export const IconAlerts = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2a4 4 0 0 0-4 4c0 3-1.25 4-1.25 4h10.5S12 9 12 6a4 4 0 0 0-4-4Z" />
    <path d="M6.6 12a1.5 1.5 0 0 0 2.8 0" />
  </Icon>
);

export const IconReports = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 13.5h11" />
    <rect x="3.5" y="8" width="2.5" height="4" rx="0.75" />
    <rect x="7" y="5" width="2.5" height="7" rx="0.75" />
    <rect x="10.5" y="2.5" width="2.5" height="9.5" rx="0.75" />
  </Icon>
);

export const IconUsers = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="6" cy="5.5" r="2.5" />
    <path d="M1.75 13.5a4.25 4.25 0 0 1 8.5 0" />
    <path d="M11 3.4a2.5 2.5 0 0 1 0 4.7M12 13.5a4.25 4.25 0 0 0-1.4-3.17" />
  </Icon>
);

export const IconRoles = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 1.75 13.25 4v3.9c0 3-2.2 5.3-5.25 6.35C4.95 13.2 2.75 10.9 2.75 7.9V4Z" />
    <path d="M5.9 8.1 7.4 9.6l2.9-3" />
  </Icon>
);

export const IconAudit = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.25 2.5h6.5l3 3v8a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z" />
    <path d="M9.5 2.5v3.25h3.25" />
    <path d="M5.5 9h5M5.5 11.5h3" />
  </Icon>
);

export const IconSecurity = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="7" width="10" height="6.5" rx="1.25" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    <path d="M8 9.75v1.5" />
  </Icon>
);

export const IconSso = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6.5 2.5h5.75a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6.5" />
    <path d="M9 8H2.25" />
    <path d="M4.5 5.5 2 8l2.5 2.5" />
  </Icon>
);

export const IconSettings = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 5.25v3.5M8 10.75h.01" />
  </Icon>
);

export const IconDocumentation = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 3.25A1.25 1.25 0 0 1 3.75 2H7a1.5 1.5 0 0 1 1 2.6V13.5a1.5 1.5 0 0 0-1-1.75H2.5Z" />
    <path d="M13.5 3.25A1.25 1.25 0 0 0 12.25 2H9a1.5 1.5 0 0 0-1 2.6V13.5a1.5 1.5 0 0 1 1-1.75h4.5Z" />
  </Icon>
);

export const IconServer = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2" y="2.5" width="12" height="4.5" rx="1.25" />
    <rect x="2" y="9" width="12" height="4.5" rx="1.25" />
    <path d="M4.5 4.75h.01M4.5 11.25h.01" />
    <path d="M8.5 4.75h3M8.5 11.25h3" />
  </Icon>
);

export const IconCertificate = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="6" r="3.75" />
    <path d="M6.1 9.2 5.25 14 8 12.5 10.75 14 9.9 9.2" />
  </Icon>
);

export const IconClose = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
);

/** Nav-key to glyph. A key with no entry simply renders without one. */
export const NAV_ICONS: Record<string, (props: IconProps) => ReactElement> = {
  dashboard: IconDashboard,
  tenants: IconTenants,
  sites: IconSites,
  clusters: IconClusters,
  nodes: IconNodes,
  virtualMachines: IconVirtualMachine,
  containers: IconContainer,
  storage: IconStorage,
  networks: IconNetwork,
  updates: IconUpdates,
  majorUpgrades: IconUpgrades,
  migrations: IconMigrations,
  automation: IconAutomation,
  jobs: IconJobs,
  alerts: IconAlerts,
  reports: IconReports,
  users: IconUsers,
  rolesPermissions: IconRoles,
  auditLog: IconAudit,
  security: IconSecurity,
  sso: IconSso,
  settings: IconSettings,
  documentation: IconDocumentation,
  serverManagement: IconServer,
  certificate: IconCertificate,
};
