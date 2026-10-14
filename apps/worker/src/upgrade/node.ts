import type { Node } from '@velnox/db';
import type { ProxmoxClient } from '@velnox/proxmox';
import { sshFor, type NodeHandle } from '../updates/node-ops';
import type { UpgradeAction, UpgradeRuntime } from './runtime';

/**
 * What the playbooks' own actions share to reach a cluster and its nodes:
 * a Proxmox client for the length of one action, the cluster's nodes, and a
 * node handle for SSH commands whose output is prefixed with the node.
 */

export async function withPve<T>(
  rt: UpgradeRuntime,
  run: (pve: ProxmoxClient) => Promise<T>,
): Promise<T> {
  const { client } = await rt.services.connect(rt.params.clusterId);
  try {
    return await run(client);
  } finally {
    client.close();
  }
}

/** Every daemon's running version, by Ceph's own name for it. */
export async function runningVersions(
  pve: ProxmoxClient,
): Promise<Map<string, { version: string | null; host: string | null }>> {
  const metadata = (await pve.cephMetadata()) as unknown as Record<
    string,
    Record<
      string,
      {
        name?: string;
        id?: number;
        hostname?: string;
        ceph_version_short?: string;
        ceph_version?: string;
      }
    >
  >;
  const out = new Map<string, { version: string | null; host: string | null }>();
  for (const kind of ['mon', 'mgr', 'osd', 'mds', 'rgw']) {
    for (const [key, entry] of Object.entries(metadata[kind] ?? {})) {
      const raw = entry?.name ?? key;
      const name = raw.startsWith(`${kind}.`) ? raw : `${kind}.${raw}`;
      out.set(name, {
        version: entry?.ceph_version_short ?? entry?.ceph_version ?? null,
        host: entry?.hostname ?? null,
      });
    }
  }
  return out;
}

export function nodesOf(rt: UpgradeRuntime): Promise<Node[]> {
  return rt.prisma.node.findMany({
    where: { clusterId: rt.params.clusterId },
    orderBy: { name: 'asc' },
  });
}

export function handleFor(
  rt: UpgradeRuntime,
  pve: ProxmoxClient,
  node: string,
  context: Parameters<UpgradeAction>[0]['context'],
): NodeHandle {
  return {
    node,
    pve,
    signal: context.signal,
    log: (stream, text) =>
      context.log(
        stream,
        text
          .split('\n')
          .map((line) => `[${node}] ${line}`)
          .join('\n'),
      ),
    sleep: context.sleep,
    ssh: sshFor(rt.services, rt.params.clusterId, node),
  };
}
