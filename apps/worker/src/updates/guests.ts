import { waitForTask, type ClusterResource, type ProxmoxClient } from '@velnox/proxmox';
import type { VelnoxPrismaClient } from '@velnox/db';
import type { PlacementRuleLike, PlannedGuest, Positions } from '@velnox/shared';
import { StepError } from '../jobs/steps';

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
  rank: (node: string) => number = () => 0,
): string | null {
  let best: string | null = null;
  for (const [node, bytes] of free) {
    if (away.has(node) || !allowed(node) || bytes < guest.memoryBytes) continue;
    if (
      best === null ||
      rank(node) < rank(best) ||
      (rank(node) === rank(best) && bytes > free.get(best)!)
    )
      best = node;
  }
  if (best) free.set(best, free.get(best)! - guest.memoryBytes);
  return best;
}

/** Where every running guest of the cluster is (placement, Phase 7B). */
export function positionsOf(resources: ClusterResource[]): Positions {
  return new Map(
    resources
      .filter(
        (r) =>
          (r.type === 'qemu' || r.type === 'lxc') &&
          r.status === 'running' &&
          r.node &&
          typeof r.vmid === 'number',
      )
      .map((r) => [r.vmid!, r.node!]),
  );
}

/** A cluster's placement rules in force: enabled and not removed. */
export async function placementRulesOf(
  prisma: VelnoxPrismaClient,
  clusterId: string,
): Promise<PlacementRuleLike[]> {
  const rows = await prisma.placementRule.findMany({
    where: { clusterId, enabled: true, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    vmids: r.vmids,
    nodes: r.nodes,
    strict: r.strict,
    enabled: r.enabled,
  }));
}

export interface GuestMove {
  vmid: number;
  kind: 'qemu' | 'lxc';
  from: string;
  to: string;
}

/**
 * Move a running guest and confirm it arrived: a VM live, a container by
 * restart. Fails with `code` when Proxmox's task fails or the guest is
 * anywhere but the target afterwards.
 */
export async function moveGuest(
  pve: ProxmoxClient,
  signal: AbortSignal,
  move: GuestMove,
  code: string,
): Promise<void> {
  const label = `${move.kind === 'lxc' ? 'CT' : 'VM'} ${move.vmid}`;
  const params = { vmid: move.vmid, from: move.from, to: move.to };
  const upid = await pve.migrateGuest(move.from, move.kind, move.vmid, move.to);
  const outcome = await waitForTask(pve, upid, { signal, timeoutMs: 30 * 60_000 });
  if (!outcome.succeeded) {
    throw new StepError(
      code,
      `Moving ${label} from ${move.from} to ${move.to} failed: ${outcome.exitStatus}`,
      params,
    );
  }
  const after = await pve.clusterResources();
  const where = after.find(
    (r) => r.vmid === move.vmid && (r.type === 'qemu' || r.type === 'lxc'),
  )?.node;
  if (where !== move.to) {
    throw new StepError(
      code,
      `${label} is on ${where ?? 'no node'} after moving it to ${move.to}`,
      params,
    );
  }
}
