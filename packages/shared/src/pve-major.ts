import { z } from 'zod';
import type { PlaybookStepDef, RemediationDef, UpgradePlaybookDef } from './upgrade';

/**
 * The Proxmox VE 8 → 9 upgrade (Phase 9B), as Proxmox's guide does it:
 * a node too old for pve8to9 brought to the latest Proxmox VE 8 first, then
 * pve8to9 on every node, its findings fixed where Velnox can — the CPU
 * microcode by itself, the rest after approval — then each node emptied of
 * its running guests, its repositories moved to trixie, its packages
 * upgraded, rebooted, checked, and its guests moved back. The first node is a
 * canary: the run waits for a person before the second.
 */

/**
 * The first pve-manager that ships pve8to9 (its changelog: "add initial
 * `pve8to9` upgrade check list tool", 8.4.2). A node below it cannot be
 * checked at all, so it is brought to the latest Proxmox VE 8 first — after
 * approval, before any check runs.
 */
export const PVE8TO9_FROM = '8.4.2';
export const PVE_MAJOR_TARGET = 9;

/**
 * What Velnox can fix of pve8to9's findings, and how it is routed (ADR-050):
 * only a low-risk change Velnox can undo runs by itself.
 */
export const PVE_REMEDIATIONS: RemediationDef[] = [
  {
    // Asked for by the owner on 11 October 2026: install it, do not just warn.
    id: 'pve.microcode',
    title: 'Install the CPU microcode package, with non-free-firmware enabled',
    risk: 'LOW',
    reversible: true,
    fixes: ['pve8to9.microcode-missing'],
  },
  {
    id: 'pve.update-bookworm',
    title: 'Bring Proxmox VE 8 up to date first (bookworm)',
    risk: 'MEDIUM',
    reversible: false,
    fixes: ['pve.pve8to9-missing', 'pve8to9.pve-too-old', 'pve8to9.updates-pending'],
  },
  {
    id: 'pve.sysctl-move',
    title: 'Move the settings in /etc/sysctl.conf to /etc/sysctl.d/',
    risk: 'MEDIUM',
    reversible: true,
    fixes: ['pve8to9.sysctl-conf'],
  },
  {
    id: 'pve.remove-systemd-boot',
    title: 'Remove the systemd-boot meta-package',
    risk: 'HIGH',
    reversible: false,
    fixes: ['pve8to9.systemd-boot'],
  },
  {
    id: 'pve.install-grub-efi',
    title: 'Install grub-efi-amd64',
    risk: 'MEDIUM',
    reversible: false,
    fixes: ['pve8to9.grub-efi'],
  },
  {
    id: 'pve.grub-removable',
    title: 'Let GRUB update the removable EFI bootloader',
    risk: 'MEDIUM',
    reversible: false,
    fixes: ['pve8to9.grub-removable'],
  },
  {
    id: 'pve.lvm-autoactivation',
    title: 'Disable autoactivation of existing LVM guest volumes',
    risk: 'MEDIUM',
    reversible: false,
    fixes: ['pve8to9.lvm-autoactivation'],
  },
];

const steps: PlaybookStepDef[] = [
  { key: 'facts', phase: 'discovery', action: 'pve.facts' },
  // A node too old to have pve8to9 is brought to the latest Proxmox VE 8
  // first, after approval: only then can pve8to9 say what else it needs.
  { key: 'latest-8', phase: 'preflight', action: 'pve.latest-8' },
  { key: 'latest-8-approve', phase: 'preflight', action: 'remediate.approval' },
  { key: 'latest-8-apply', phase: 'preflight', action: 'remediate.approved' },
  { key: 'checks', phase: 'preflight', action: 'checks.run' },
  { key: 'remediate-auto', phase: 'remediation', action: 'remediate.automatic' },
  { key: 'remediate-approve', phase: 'remediation', action: 'remediate.approval' },
  { key: 'remediate-approved', phase: 'remediation', action: 'remediate.approved' },
  { key: 'recheck', phase: 'recheck', action: 'checks.run', params: { recheck: true } },
  { key: 'gate', phase: 'recheck', action: 'checks.gate' },
  { key: 'evacuate', phase: 'upgrade', action: 'pve.evacuate', perTarget: true },
  { key: 'repositories', phase: 'upgrade', action: 'pve.repositories', perTarget: true },
  { key: 'packages', phase: 'upgrade', action: 'pve.dist-upgrade', perTarget: true },
  { key: 'reboot', phase: 'upgrade', action: 'pve.reboot', perTarget: true },
  { key: 'validate', phase: 'upgrade', action: 'pve.validate', perTarget: true },
  { key: 'return', phase: 'upgrade', action: 'pve.return', perTarget: true },
  // After the first node only: the canary. A person looks before the second.
  { key: 'canary', phase: 'upgrade', action: 'gate.canary', perTarget: true },
  { key: 'final', phase: 'validation', action: 'pve.final' },
  { key: 'report', phase: 'report', action: 'report.build' },
];

export const PVE_MAJOR_PLAYBOOK: UpgradePlaybookDef = {
  id: 'velnox.pve-8-to-9',
  version: 1,
  title: 'Proxmox VE 8 → 9',
  kind: 'PVE_MAJOR',
  targetKind: 'NODE',
  internal: false,
  checkProviders: ['pve.cluster', 'pve.pve8to9'],
  cleanup: 'pve.cleanup',
  steps,
};

export const pvePlanOptionsSchema = z
  .object({
    /** A running guest that cannot move live: refuse, or shut it down for its node's turn. */
    nonMigratable: z.enum(['BLOCK', 'SHUTDOWN']).default('BLOCK'),
    /** Minutes a node may take to come back after its reboot. */
    rebootMinutes: z.number().int().min(5).max(120).default(30),
  })
  .strict();
export type PvePlanOptions = z.infer<typeof pvePlanOptionsSchema>;
