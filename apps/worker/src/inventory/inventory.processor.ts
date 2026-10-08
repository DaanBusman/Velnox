import type { Job } from 'bullmq';
import { withSystemScope, type VelnoxPrismaClient } from '@velnox/db';
import {
  FingerprintMismatchError,
  ProxmoxClient,
  ProxmoxHttpError,
  ProxmoxUnreachableError,
  discoverCluster,
  inspectCertificate,
} from '@velnox/proxmox';
import { ERROR_CODES, rootRedactor } from '@velnox/shared';
import type { CredentialReader } from './credentials';
import { persistDiscovery } from './persist';
import { collectTasks } from './tasks';

/**
 * The three jobs that talk to a hypervisor.
 *
 * All of them run in `withSystemScope`: a discovery run belongs to no request
 * and no session, so there is no principal for the tenancy filter to be relative
 * to. The scope it replaces is enforced a different way — the cluster row is
 * loaded by id and everything written afterwards carries that cluster's tenant,
 * copied from the row rather than taken from the job payload.
 *
 * No job payload ever carries a secret. `probe` has none to carry; the other two
 * are handed a cluster id and read the credential themselves, in this process,
 * which is the only one with a key.
 */

export interface ProbeJobData {
  host: string;
  port: number;
}

export interface DiscoverJobData {
  clusterId: string;
  requestedBy?: string | null;
}

export interface InventoryContext {
  prisma: VelnoxPrismaClient;
  credentials: CredentialReader;
  log: (fields: Record<string, unknown>, message: string) => void;
}

/**
 * Read a host's certificate.
 *
 * No credential, by design — see `inspect` in the transport. The result is what
 * an operator is asked to compare against `pvenode cert info` on the node.
 */
export async function processProbe(job: Job<ProbeJobData>) {
  const { host, port } = job.data;
  const { certificate, respondedAsProxmox } = await inspectCertificate({ host, port });

  return {
    fingerprint: certificate.fingerprint,
    subject: certificate.subject,
    issuer: certificate.issuer,
    validFrom: certificate.validFrom,
    validTo: certificate.validTo,
    trustedByCa: certificate.trustedByCa,
    respondedAsProxmox,
  };
}

/** Load a cluster and build a client for it. Throws if it cannot. */
export async function clientFor(
  context: InventoryContext,
  clusterId: string,
): Promise<{
  cluster: { id: string; tenantId: string; name: string; authPrincipal: string | null };
  client: ProxmoxClient;
}> {
  const cluster = await context.prisma.cluster.findUnique({ where: { id: clusterId } });
  if (!cluster) throw new Error(`No cluster ${clusterId}`);
  if (!cluster.credentialId) throw new Error(`Cluster ${clusterId} has no stored credential`);

  const auth = await context.credentials.proxmoxAuth({
    credentialId: cluster.credentialId,
    kind: cluster.authKind,
    principal: cluster.authPrincipal,
  });

  const client = new ProxmoxClient({
    host: cluster.endpointHost,
    port: cluster.endpointPort,
    tls:
      cluster.tlsVerifyMode === 'PINNED_FINGERPRINT'
        ? { mode: 'pinned', fingerprint: cluster.tlsFingerprint ?? undefined }
        : { mode: 'system' },
    auth,
    onRetry: (attempt, error) =>
      context.log(
        { clusterId, attempt, err: rootRedactor.value(error) },
        'Retrying a Proxmox request',
      ),
  });

  return {
    cluster: {
      id: cluster.id,
      tenantId: cluster.tenantId,
      name: cluster.name,
      authPrincipal: cluster.authPrincipal,
    },
    client,
  };
}

/**
 * Prove the stored credential works, against the pinned certificate.
 *
 * One call. It is what the add-a-cluster form waits on, so it must be fast, and
 * `/version` is the cheapest thing that requires authentication.
 */
export function processVerify(job: Job<DiscoverJobData>, context: InventoryContext) {
  return withSystemScope('a discovery job belongs to no request', async () => {
    const { cluster, client } = await clientFor(context, job.data.clusterId);
    const version = await client.version().finally(() => client.close());

    await context.prisma.cluster.update({
      where: { id: cluster.id },
      data: {
        connectionState: 'CONNECTED',
        pveVersion: version.version,
        lastSeenAt: new Date(),
        lastErrorCode: null,
        lastErrorDetail: null,
      },
    });

    return { version: version.version, auth: client.authDescription };
  });
}

/**
 * Read a cluster's whole inventory and write it down.
 *
 * A run that could not reach part of the cluster still writes what it did learn
 * and finishes `PARTIAL`. That is the difference between inventory that is
 * incomplete and says so, and inventory that is wrong.
 */
export function processDiscover(job: Job<DiscoverJobData>, context: InventoryContext) {
  return withSystemScope('a discovery job belongs to no request', async () => {
    const startedAt = Date.now();
    const { cluster, client } = await clientFor(context, job.data.clusterId);

    const run = await context.prisma.discoveryRun.create({
      data: {
        tenantId: cluster.tenantId,
        clusterId: cluster.id,
        state: 'RUNNING',
        requestedBy: job.data.requestedBy ?? null,
      },
    });

    try {
      const discovered = await discoverCluster(client);

      /*
       * A run that learned nothing is a failure, not an empty cluster.
       *
       * `discoverCluster` records problems rather than throwing, so that one
       * unreachable node does not lose the other fourteen. Taken to its
       * conclusion that is wrong: a cluster that answered nothing at all comes
       * back as a perfectly well-formed inventory of zero nodes, and writing it
       * would replace a customer's fleet with "no infrastructure" because of a
       * DNS blip. Seen in `verify-proxmox.sh`, which pulls the plug on the
       * fixture and expects the previous inventory to survive.
       */
      if (discovered.nodes.length === 0 && discovered.problems.length > 0) {
        throw new DiscoveryFailed(
          `Learned nothing about ${cluster.name}: ${discovered.problems[0] ?? 'no detail'}`,
          discoveryErrorCode(discovered.firstError),
        );
      }

      const counts = await persistDiscovery(context.prisma, cluster, discovered);

      // The task history for the support logs. Its problems join the run's;
      // they never fail it.
      const settings = await context.prisma.systemSettings.findUnique({
        where: { id: 1 },
        select: { supportLogRetentionDays: true },
      });
      const tasks = await collectTasks(
        context.prisma,
        client,
        cluster,
        discovered.nodes.filter((node) => node.state === 'online').map((node) => node.name),
        settings?.supportLogRetentionDays ?? 30,
      ).catch((error: unknown) => ({
        stored: 0,
        problems: [`tasks: ${error instanceof Error ? error.message : String(error)}`],
      }));

      const problems = [
        ...discovered.problems,
        ...tasks.problems,
        ...discovered.nodes.flatMap((node) =>
          node.problems.map((problem) => `${node.name}: ${problem}`),
        ),
      ];

      await context.prisma.discoveryRun.update({
        where: { id: run.id },
        data: {
          state: problems.length > 0 ? 'PARTIAL' : 'SUCCEEDED',
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt,
          nodesSeen: counts.nodesSeen,
          workloadsSeen: counts.workloadsSeen,
          problems,
        },
      });

      context.log(
        {
          clusterId: cluster.id,
          nodes: counts.nodesSeen,
          workloads: counts.workloadsSeen,
          cephDaemons: counts.cephDaemonsSeen,
          problems: problems.length,
          durationMs: Date.now() - startedAt,
        },
        'Discovery finished',
      );

      return {
        ...counts,
        problems: problems.length,
        state: problems.length > 0 ? 'PARTIAL' : 'SUCCEEDED',
      };
    } catch (error) {
      const detail = rootRedactor.text(error instanceof Error ? error.message : String(error));
      const code = error instanceof DiscoveryFailed ? error.code : discoveryErrorCode(error);

      await context.prisma.discoveryRun.update({
        where: { id: run.id },
        data: {
          state: 'FAILED',
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt,
          errorCode: code,
          errorDetail: detail,
        },
      });

      /*
       * The cluster keeps the inventory it had.
       *
       * Blanking it on a failed run would turn a network blip into "this
       * customer has no infrastructure", which is both alarming and wrong. What
       * changes is the state and the error, and `lastSeenAt` stops moving —
       * which is how an operator tells fresh inventory from stale.
       */
      await context.prisma.cluster.update({
        where: { id: cluster.id },
        data: { connectionState: 'FAILED', lastErrorCode: code, lastErrorDetail: detail },
      });

      throw error;
    } finally {
      // Closed after the task history is read too, and on every path out.
      client.close();
    }
  });
}

/** A run that learned nothing, with the catalogue code that says why. */
class DiscoveryFailed extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'DiscoveryFailed';
  }
}

/**
 * The catalogue code for why a cluster could not be read.
 *
 * Stored on the cluster and the run, and translated by the interface. It used
 * to be the error's class name — "Error" — which no screen can explain.
 */
export function discoveryErrorCode(error: unknown): string {
  if (error instanceof ProxmoxUnreachableError) return ERROR_CODES.clusterUnreachable;
  if (error instanceof FingerprintMismatchError) return ERROR_CODES.nodeFingerprintMismatch;
  if (error instanceof ProxmoxHttpError && (error.status === 401 || error.status === 403)) {
    return ERROR_CODES.clusterAuthFailed;
  }
  return ERROR_CODES.generic;
}
