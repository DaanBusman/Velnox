import { z } from 'zod';
import { ruleProblem } from './rrule';

/**
 * Update management (Phase 6): what a node would install, how it is applied,
 * and the policies and windows that decide when.
 */

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Packages Proxmox itself ships, by name. Origin alone does not say it: a
 * Proxmox repository also carries Debian packages it rebuilt.
 */
const PROXMOX_PACKAGE =
  /^(pve-|proxmox-|libpve-|qemu-server$|pve-qemu|lxc-pve|lxcfs$|corosync$|libknet|spiceterm$|vncterm$|novnc-pve$|ceph(-|$)|librados|librbd|libcephfs|python3-ceph|zfs|libzfs|libnvpair|libuutil|smartmontools$|ifupdown2$)/;
/** A kernel: the thing that only takes effect after a reboot. */
const KERNEL_PACKAGE =
  /^(proxmox-kernel-|pve-kernel-|linux-image-|pve-firmware$|proxmox-default-kernel$)/;

export interface UpdateClassification {
  isSecurity: boolean;
  isKernel: boolean;
  isProxmox: boolean;
}

/**
 * How a pending update is classified.
 *
 * Security is taken from where apt would fetch it — Debian's security archive
 * labels its suite `…-security` — when Velnox has that from `apt-get -s` over
 * SSH, and otherwise from the origin and changelog Proxmox's API reports, which
 * is a weaker reading and says so (`securityFrom`).
 */
export function classifyPackage(input: {
  package: string;
  origin?: string | null;
  /** The archive or suite apt names, from `apt-get -s` (`Debian-Security:12/stable-security`). */
  archive?: string | null;
  changelogUrl?: string | null;
}): UpdateClassification {
  const name = input.package.toLowerCase();
  const security =
    /security/i.test(input.archive ?? '') ||
    /security/i.test(input.origin ?? '') ||
    /security\.debian\.org/i.test(input.changelogUrl ?? '');
  return {
    isSecurity: security,
    isKernel: KERNEL_PACKAGE.test(name),
    isProxmox: PROXMOX_PACKAGE.test(name) || /proxmox/i.test(input.origin ?? ''),
  };
}

/**
 * Whether a newer kernel is installed than the one running.
 *
 * `running` is the release Proxmox reports (`6.8.12-4-pve`); `installed` the
 * versions of the kernel packages apt has installed (`6.8.12-5`). Compared
 * numerically part by part, as dpkg would for these simple versions.
 */
export function newerKernelInstalled(running: string | null, installed: string[]): string | null {
  if (!running) return null;
  const run = running.replace(/-pve$/, '');
  let newest: string | null = null;
  for (const version of installed) {
    if (compareVersions(version, run) > 0 && (!newest || compareVersions(version, newest) > 0)) {
      newest = version;
    }
  }
  return newest;
}

/** Numeric part-by-part comparison of versions like `6.8.12-5`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+~]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const pb = b.split(/[.\-+~]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Policies and windows
// ---------------------------------------------------------------------------

export const REBOOT_POLICIES = ['NEVER', 'IF_REQUIRED', 'ALWAYS'] as const;
export type RebootPolicy = (typeof REBOOT_POLICIES)[number];

const isTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

export const maintenanceWindowSchema = z.object({
  name: z.string().trim().min(1).max(100),
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(isTimeZone, 'A time zone such as Europe/Amsterdam'),
  rrule: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .superRefine((value, ctx) => {
      const problem = ruleProblem(value);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    }),
  durationMinutes: z
    .number()
    .int()
    .min(15)
    .max(24 * 60),
  blackoutDates: z
    .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as YYYY-MM-DD'))
    .max(100)
    .default([]),
});
export type MaintenanceWindowInput = z.infer<typeof maintenanceWindowSchema>;

export const updatePolicySchema = z.object({
  name: z.string().trim().min(1).max(100),
  clusterId: z.string().uuid(),
  enabled: z.boolean().default(true),
  /** Start updates by itself when the window opens and a node has some. */
  autoApply: z.boolean().default(false),
  /** Every update under this policy waits for someone to approve it. */
  requireApproval: z.boolean().default(false),
  rebootPolicy: z.enum(REBOOT_POLICIES).default('IF_REQUIRED'),
  /** Updates under this policy run only while this window is open. */
  maintenanceWindowId: z.string().uuid().nullable().default(null),
});
export type UpdatePolicyInput = z.infer<typeof updatePolicySchema>;

export const nodeUpdateRequestSchema = z.object({
  rebootPolicy: z.enum(REBOOT_POLICIES).optional(),
});

// ---------------------------------------------------------------------------
// What the API returns
// ---------------------------------------------------------------------------

export interface PendingPackage {
  package: string;
  currentVersion: string | null;
  candidateVersion: string;
  origin: string | null;
  isSecurity: boolean;
  isKernel: boolean;
  isProxmox: boolean;
}

export interface NodeUpdatesSummary {
  nodeId: string;
  node: string;
  clusterId: string;
  clusterName: string;
  tenantId: string;
  tenantName: string;
  online: boolean;
  pveVersion: string | null;
  runningKernel: string | null;
  total: number;
  security: number;
  kernel: number;
  proxmox: number;
  rebootRequired: boolean;
  rebootReason: string | null;
  checkedAt: string | null;
  /** Whether Velnox can apply updates: SSH configured, and this node's key confirmed. */
  canApply: boolean;
  /** The update job running or waiting on this node, if any. */
  activeJobId: string | null;
  policy: { id: string; name: string } | null;
}

export interface MaintenanceWindowSummary extends MaintenanceWindowInput {
  id: string;
  tenantId: string;
  tenantName: string;
  open: boolean;
  nextOpening: string | null;
  closesAt: string | null;
}

export interface UpdatePolicySummary extends UpdatePolicyInput {
  id: string;
  tenantId: string;
  clusterName: string;
  windowName: string | null;
}

/** What a node.update job is asked to do. Fixed when the job is created. */
export interface NodeUpdateParams {
  clusterId: string;
  nodeId: string;
  node: string;
  rebootPolicy: RebootPolicy;
  requireApproval: boolean;
  /** The policy's window: the update changes nothing unless it is open. */
  maintenanceWindowId: string | null;
  policyId: string | null;
  /** What was pending when it was asked for, for the approval and the record. */
  pending: { total: number; security: number; kernel: number; proxmox: number };
}

/**
 * How many quorum-voting nodes may be unavailable at once without the cluster
 * losing quorum: ⌊(n − 1) / 2⌋. The central safety invariant of updates and
 * rolling updates (docs/architecture.md, section 9). A standalone node has no
 * quorum to lose.
 */
export const maxUnavailableNodes = (votingNodes: number): number =>
  votingNodes <= 1 ? 1 : Math.floor((votingNodes - 1) / 2);
