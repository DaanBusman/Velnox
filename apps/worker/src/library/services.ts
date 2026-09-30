import type { BlockList } from 'node:net';
import {
  libraryPaths,
  readLibraryCapacity,
  type LibraryLimits,
  type LibraryPaths,
  type VelnoxPrismaClient,
} from '@velnox/db';
import { discoverContents, type ProxmoxClient } from '@velnox/proxmox';
import { ERROR_CODES, type LibraryCapacity } from '@velnox/shared';
import type { CredentialReader } from '../inventory/credentials';
import { clientFor, type InventoryContext } from '../inventory/inventory.processor';
import { persistContents } from '../inventory/persist';
import { StepError } from '../jobs/steps';
import type { SshTarget } from './ssh';

/**
 * What the library playbooks work with.
 *
 * One interface rather than a handful of imports, so a playbook can be run in
 * a test with a fake cluster and a temporary directory, and so everything a
 * library job can reach is listed in one place.
 */
export interface LibraryServices {
  prisma: VelnoxPrismaClient;
  limits: LibraryLimits;
  paths: LibraryPaths;
  /** Addresses a URL fetch may not reach (address-guard.ts). */
  blocked: BlockList;
  userAgent: string;
  capacity(excludeItemId?: string): Promise<LibraryCapacity>;
  connect(
    clusterId: string,
  ): Promise<{ cluster: { id: string; tenantId: string; name: string }; client: ProxmoxClient }>;
  sshTarget(clusterId: string, nodeName: string): Promise<SshTarget>;
  /**
   * Re-read the ISOs and images on one cluster after a job changed them, so the
   * cluster's screen shows the result without waiting for the next discovery.
   */
  refreshContents(clusterId: string): Promise<void>;
}

export function createLibraryServices(input: {
  prisma: VelnoxPrismaClient;
  credentials: CredentialReader;
  limits: LibraryLimits;
  blocked: BlockList;
  userAgent: string;
  log: InventoryContext['log'];
}): LibraryServices {
  const context: InventoryContext = {
    prisma: input.prisma,
    credentials: input.credentials,
    log: input.log,
  };

  const connect: LibraryServices['connect'] = (clusterId) => clientFor(context, clusterId);

  return {
    prisma: input.prisma,
    limits: input.limits,
    paths: libraryPaths(input.limits.dir),
    blocked: input.blocked,
    userAgent: input.userAgent,
    capacity: (excludeItemId) => readLibraryCapacity(input.prisma, input.limits, excludeItemId),
    connect,

    async sshTarget(clusterId, nodeName) {
      const cluster = await input.prisma.cluster.findUnique({
        where: { id: clusterId },
        select: { endpointHost: true, sshCredentialId: true, sshUsername: true, sshPort: true },
      });
      if (!cluster?.sshCredentialId || !cluster.sshUsername) {
        throw new StepError(
          ERROR_CODES.sshNotConfigured,
          `SSH is not set up for cluster ${clusterId}`,
          {
            node: nodeName,
          },
        );
      }
      const node = await input.prisma.node.findUnique({
        where: { clusterId_name: { clusterId, name: nodeName } },
        select: { address: true, sshHostKeyFingerprint: true },
      });
      if (!node?.sshHostKeyFingerprint) {
        // A node that joined after SSH was set up has no confirmed key, and is
        // not connected to until someone confirms one.
        throw new StepError(
          ERROR_CODES.sshNotConfigured,
          `No confirmed SSH host key for node ${nodeName}`,
          {
            node: nodeName,
          },
        );
      }
      const key = await input.credentials.sshKey(cluster.sshCredentialId);
      return {
        host: node.address ?? cluster.endpointHost,
        port: cluster.sshPort,
        username: cluster.sshUsername,
        fingerprint: node.sshHostKeyFingerprint,
        ...key,
      };
    },

    async refreshContents(clusterId) {
      const { cluster, client } = await connect(clusterId);
      try {
        const nodes = await client.nodes();
        const facts = await Promise.all(
          nodes.map(async (entry) => ({
            entry,
            status: null,
            subscription: null,
            repositories: null,
            updates: null,
            storages:
              entry.status === 'online'
                ? await client.nodeStorage(entry.node).catch(() => null)
                : null,
            interfaces: null,
            clusterEntry: null,
            problems: [],
          })),
        );
        const problems: string[] = [];
        const contents = await discoverContents(client, facts, problems);
        await persistContents(input.prisma, cluster, contents, new Date());
      } finally {
        client.close();
      }
    },
  };
}
