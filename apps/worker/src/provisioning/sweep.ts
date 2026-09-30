import { withSystemScope, type VelnoxPrismaClient } from '@velnox/db';
import { ACTIVE_JOB_STATUSES, ERROR_CODES } from '@velnox/shared';
import type { CredentialReader } from '../inventory/credentials';

/**
 * Keeping provisioning records honest when no job is left to do it.
 *
 * 1. **A record whose job is no longer running** — its worker died, and the
 *    cleanup died with it — is failed as `job.worker_lost`, with the VMID if one
 *    was created: that VM may still exist, and a person has to decide. Not
 *    destroyed from here, because this cannot know how far the job got.
 * 2. **Credentials past their retention** are deleted. The record stays; the
 *    passwords do not, and revealing them afterwards says so.
 */
export interface ProvisioningSweepResult {
  lost: number;
  expired: number;
}

export async function sweepProvisionings(
  prisma: VelnoxPrismaClient,
  credentials: CredentialReader,
  now = new Date(),
): Promise<ProvisioningSweepResult> {
  return withSystemScope('sweeping provisioning records belongs to no request', async () => {
    const result: ProvisioningSweepResult = { lost: 0, expired: 0 };

    const open = await prisma.provisioning.findMany({
      where: { state: { in: ['QUEUED', 'RUNNING'] }, jobId: { not: null } },
      select: { id: true, jobId: true, vmid: true, credentialsCredentialId: true },
    });
    for (const row of open) {
      const job = await prisma.job.findUnique({
        where: { id: row.jobId! },
        select: { status: true },
      });
      if (job && ACTIVE_JOB_STATUSES.has(job.status)) continue;
      const updated = await prisma.provisioning.updateMany({
        where: { id: row.id, state: { in: ['QUEUED', 'RUNNING'] } },
        data: {
          state: 'FAILED',
          finishedAt: now,
          errorCode: ERROR_CODES.jobWorkerLost,
          errorParams: row.vmid ? { vmid: row.vmid } : undefined,
          errorDetail:
            row.vmid !== null
              ? `The job stopped without finishing; VM ${row.vmid} may still exist`
              : 'The job stopped without finishing',
          credentialsCredentialId: null,
        },
      });
      if (updated.count > 0 && row.credentialsCredentialId) {
        await credentials.remove(row.credentialsCredentialId).catch(() => undefined);
      }
      result.lost += updated.count;
    }

    const expired = await prisma.provisioning.findMany({
      where: { credentialsCredentialId: { not: null }, credentialsExpireAt: { lt: now } },
      select: { id: true, credentialsCredentialId: true },
    });
    for (const row of expired) {
      await credentials.remove(row.credentialsCredentialId!).catch(() => undefined);
      await prisma.provisioning.update({
        where: { id: row.id },
        data: { credentialsCredentialId: null },
      });
      result.expired += 1;
    }
    return result;
  });
}
