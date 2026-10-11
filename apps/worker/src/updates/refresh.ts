import type { VelnoxPrismaClient } from '@velnox/db';
import { installedKernelVersions, type ProxmoxClient } from '@velnox/proxmox';
import { classifyPackage, newerKernelInstalled } from '@velnox/shared';

/**
 * Read one node's pending updates and kernels again, and write them down the
 * way discovery does (inventory/persist.ts) — after an update, so the screen
 * says what is left without waiting for the next discovery.
 */
export async function refreshNodeUpdates(
  prisma: VelnoxPrismaClient,
  client: ProxmoxClient,
  nodeId: string,
  node: string,
): Promise<{
  total: number;
  rebootRequired: boolean;
  runningKernel: string | null;
  reason: string | null;
}> {
  const [updates, versions, status] = await Promise.all([
    client.nodeUpdates(node),
    client.nodePackageVersions(node).catch(() => null),
    client.nodeStatus(node).catch(() => null),
  ]);
  const pending = updates
    .filter((u) => u.Package && u.Version)
    .map((u) => ({
      package: u.Package,
      currentVersion: u.OldVersion ?? null,
      candidateVersion: u.Version!,
      origin: u.Origin ?? null,
      changelogUrl: u.ChangeLogUrl ?? null,
    }));
  const classified = pending.map((p) => ({ ...p, ...classifyPackage(p) }));
  const runningKernel = status?.['current-kernel']?.release ?? null;
  const newer = versions
    ? newerKernelInstalled(runningKernel, installedKernelVersions(versions))
    : null;
  const reason = newer ? `Kernel ${newer} is installed; ${runningKernel} is running` : null;

  await prisma.nodePackageUpdate.deleteMany({ where: { nodeId } });
  if (classified.length > 0) {
    const row = await prisma.node.findUnique({
      where: { id: nodeId },
      select: { tenantId: true, clusterId: true },
    });
    await prisma.nodePackageUpdate.createMany({
      data: classified.map(({ changelogUrl: _changelog, ...p }) => ({
        ...p,
        nodeId,
        tenantId: row!.tenantId,
        clusterId: row!.clusterId,
      })),
      skipDuplicates: true,
    });
  }
  await prisma.node.update({
    where: { id: nodeId },
    data: {
      updatesAvailable: classified.length,
      updatesSecurity: classified.filter((c) => c.isSecurity).length,
      updatesKernel: classified.filter((c) => c.isKernel).length,
      updatesProxmox: classified.filter((c) => c.isProxmox).length,
      updatesCheckedAt: new Date(),
      ...(runningKernel ? { runningKernel, kernelVersion: runningKernel } : {}),
      ...(versions ? { rebootRequired: newer !== null, rebootRequiredReason: reason } : {}),
    },
  });
  return { total: classified.length, rebootRequired: newer !== null, runningKernel, reason };
}
