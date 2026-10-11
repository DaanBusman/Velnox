import type { ProxmoxClient } from '@velnox/proxmox';
import { maxUnavailableNodes } from '@velnox/shared';

/**
 * Whether the cluster keeps quorum with `leaving` more nodes down: it must be
 * quorate now, and the nodes already down plus those leaving may not exceed
 * ⌊(n − 1) / 2⌋ (docs/architecture.md, section 9). A standalone node has no
 * cluster row and no quorum to keep.
 */
export async function quorumAllows(
  client: ProxmoxClient,
  leaving: number,
): Promise<{ ok: boolean; total: number; online: number; quorate: boolean }> {
  const status = await client.clusterStatus();
  const nodes = status.filter((row) => row.type === 'node');
  const cluster = status.find((row) => row.type === 'cluster');
  const total = nodes.length;
  const online = nodes.filter((row) => row.online === 1).length;
  if (!cluster || total <= 1) return { ok: true, total, online, quorate: true };
  const quorate = cluster.quorate === 1;
  const down = total - online + leaving;
  return { ok: quorate && down <= maxUnavailableNodes(total), total, online, quorate };
}
