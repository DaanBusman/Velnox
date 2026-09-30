import type { Job } from 'bullmq';
import { withSystemScope, type VelnoxPrismaClient } from '@velnox/db';
import { rootRedactor } from '@velnox/shared';
import type { CredentialReader } from '../inventory/credentials';
import { HostKeyMismatchError, SshAuthError, readHostKey, withSftp } from './ssh';

/**
 * The two halves of setting SSH up on a cluster, run for the API (ADR-009:
 * the API makes no outbound connections).
 *
 * **Probe** reads every node's host key without authenticating, so an operator
 * can compare them with what `ssh-keyscan` or the node's console shows before
 * trusting them. **Verify** runs after the operator confirmed them and the key
 * is stored: it authenticates to every pinned node and opens SFTP, and fails
 * if any node refuses — the API then removes what it stored, the same rule as
 * adding a cluster.
 */

export interface SshProbeData {
  clusterId: string;
  port: number;
}

export interface SshProbeResult {
  nodes: {
    node: string;
    host: string;
    fingerprint: string | null;
    keyType: string | null;
    /** Why no key was read: the node is offline, or did not answer on the port. */
    error: string | null;
  }[];
}

export interface SshVerifyData {
  clusterId: string;
}

export interface SshVerifyResult {
  nodes: { node: string; ok: boolean; error: string | null; code: string | null }[];
}

interface SetupContext {
  prisma: VelnoxPrismaClient;
  credentials: CredentialReader;
}

async function nodesOf(prisma: VelnoxPrismaClient, clusterId: string) {
  const cluster = await prisma.cluster.findUnique({
    where: { id: clusterId },
    select: {
      endpointHost: true,
      sshPort: true,
      sshUsername: true,
      sshCredentialId: true,
      nodes: {
        select: { name: true, address: true, state: true, sshHostKeyFingerprint: true },
        orderBy: { name: 'asc' },
      },
    },
  });
  if (!cluster) throw new Error(`No cluster ${clusterId}`);
  return cluster;
}

export function processSshProbe(
  job: Job<SshProbeData>,
  context: SetupContext,
): Promise<SshProbeResult> {
  return withSystemScope('an SSH probe belongs to no request', async () => {
    const cluster = await nodesOf(context.prisma, job.data.clusterId);
    const nodes = await Promise.all(
      cluster.nodes.map(async (node) => {
        const host = node.address ?? cluster.endpointHost;
        if (node.state === 'OFFLINE') {
          return { node: node.name, host, fingerprint: null, keyType: null, error: 'offline' };
        }
        try {
          const key = await readHostKey({ host, port: job.data.port });
          return {
            node: node.name,
            host,
            fingerprint: key.fingerprint,
            keyType: key.type,
            error: null,
          };
        } catch (error) {
          return {
            node: node.name,
            host,
            fingerprint: null,
            keyType: null,
            error: rootRedactor.text(error instanceof Error ? error.message : String(error)),
          };
        }
      }),
    );
    return { nodes };
  });
}

export function processSshVerify(
  job: Job<SshVerifyData>,
  context: SetupContext,
): Promise<SshVerifyResult> {
  return withSystemScope('an SSH check belongs to no request', async () => {
    const cluster = await nodesOf(context.prisma, job.data.clusterId);
    if (!cluster.sshCredentialId || !cluster.sshUsername) throw new Error('SSH is not configured');
    const key = await context.credentials.sshKey(cluster.sshCredentialId);

    const pinned = cluster.nodes.filter((node) => node.sshHostKeyFingerprint);
    const nodes = await Promise.all(
      pinned.map(async (node) => {
        try {
          await withSftp(
            {
              host: node.address ?? cluster.endpointHost,
              port: cluster.sshPort,
              username: cluster.sshUsername!,
              fingerprint: node.sshHostKeyFingerprint!,
              ...key,
            },
            undefined,
            // The least an SFTP session can do: ask where it is. Proves the key,
            // the pin and the subsystem, and reads nothing.
            (sftp) =>
              new Promise<void>((resolve, reject) =>
                sftp.realpath('.', (error) => (error ? reject(error) : resolve())),
              ),
          );
          return { node: node.name, ok: true, error: null, code: null };
        } catch (error) {
          const code =
            error instanceof HostKeyMismatchError
              ? 'node.host_key_mismatch'
              : error instanceof SshAuthError
                ? 'ssh.auth_failed'
                : 'ssh.unreachable';
          return {
            node: node.name,
            ok: false,
            code,
            error: rootRedactor.text(error instanceof Error ? error.message : String(error)),
          };
        }
      }),
    );
    return { nodes };
  });
}
