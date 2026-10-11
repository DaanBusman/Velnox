import type { ClusterResource, ProxmoxClient } from '@velnox/proxmox';
import type { VelnoxPrismaClient } from '@velnox/db';
import type { PlannedGuest } from '@velnox/shared';

/**
 * The guests a node's reboot affects, and whether each can be moved away live
 * (Phase 7).
 *
 * A VM moves live when every disk is on storage the other nodes see too, and
 * nothing physical is passed through to it. A container cannot move live at
 * all; it is moved by restarting it on the target, which needs its volumes on
 * shared storage the same way. Anything else is a blocker, named.
 */

const QEMU_DISK = /^(scsi|sata|ide|virtio|efidisk|tpmstate)\d+$/;
const LXC_VOLUME = /^(rootfs|mp\d+)$/;
const PASSTHROUGH = /^(hostpci|usb)\d+$/;

/** The storages a guest's disks live on, from its configuration. */
export function storagesOf(
  kind: 'qemu' | 'lxc',
  config: Record<string, string | number>,
): string[] {
  const out = new Set<string>();
  for (const [key, raw] of Object.entries(config)) {
    if (!(kind === 'qemu' ? QEMU_DISK : LXC_VOLUME).test(key)) continue;
    const value = String(raw);
    if (/media=cdrom/.test(value) || value.startsWith('none')) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*):/.exec(value);
    if (match) out.add(match[1]!);
    // A bind mount (`mp0: /srv/data,mp=/data`) lives on the node itself.
    else if (value.startsWith('/')) out.add('(host path)');
  }
  return [...out];
}

/** Why a guest cannot be moved live; null when it can. */
export function blockerOf(
  kind: 'qemu' | 'lxc',
  config: Record<string, string | number>,
  shared: (storage: string) => boolean,
): string | null {
  const passthrough = Object.keys(config).filter((key) => PASSTHROUGH.test(key));
  if (kind === 'qemu' && passthrough.length) return `passes through ${passthrough.join(', ')}`;
  const local = storagesOf(kind, config).filter((storage) => !shared(storage));
  if (local.length) return `disk on ${local.join(', ')}, which only its node sees`;
  return null;
}

/** Which storages are shared, as discovery read them, by name across the cluster. */
export async function sharedStorages(
  prisma: VelnoxPrismaClient,
  clusterId: string,
): Promise<(storage: string) => boolean> {
  const rows = await prisma.nodeStorage.findMany({
    where: { node: { clusterId } },
    select: { name: true, shared: true },
  });
  const shared = new Set(rows.filter((row) => row.shared).map((row) => row.name));
  return (storage) => shared.has(storage);
}

/** The running guests on these nodes, each assessed. */
export async function assessGuests(
  pve: ProxmoxClient,
  resources: ClusterResource[],
  nodes: string[],
  shared: (storage: string) => boolean,
): Promise<PlannedGuest[]> {
  const wanted = new Set(nodes);
  const running = resources.filter(
    (r) =>
      (r.type === 'qemu' || r.type === 'lxc') &&
      r.node &&
      wanted.has(r.node) &&
      r.status === 'running' &&
      !r.template &&
      typeof r.vmid === 'number',
  );
  const out: PlannedGuest[] = [];
  for (const r of running) {
    const kind = r.type as 'qemu' | 'lxc';
    const config = await pve.guestConfig(r.node!, kind, r.vmid!);
    out.push({
      vmid: r.vmid!,
      kind,
      name: r.name ?? null,
      node: r.node!,
      memoryBytes: typeof r.maxmem === 'number' ? r.maxmem : 0,
      blocker: blockerOf(kind, config, shared),
    });
  }
  return out;
}

/** Free memory per online node, from the cluster's resources. */
export function freeMemory(resources: ClusterResource[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of resources) {
    if (r.type !== 'node' || r.status !== 'online' || !r.node) continue;
    out.set(r.node, Math.max(0, (r.maxmem ?? 0) - (r.mem ?? 0)));
  }
  return out;
}

/**
 * The node a guest goes to: an online node outside the group being taken down,
 * that `allowed` accepts (placement rules, Phase 7B), with the most free
 * memory that can still hold it. `free` is updated, so the next guest sees
 * this one's weight.
 */
export function chooseTarget(
  guest: PlannedGuest,
  free: Map<string, number>,
  away: Set<string>,
  allowed: (node: string) => boolean = () => true,
): string | null {
  let best: string | null = null;
  for (const [node, bytes] of free) {
    if (away.has(node) || !allowed(node) || bytes < guest.memoryBytes) continue;
    if (best === null || bytes > free.get(best)!) best = node;
  }
  if (best) free.set(best, free.get(best)! - guest.memoryBytes);
  return best;
}
