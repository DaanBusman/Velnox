import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infrastructure/prisma.service';

/**
 * Alerts, derived from the inventory rather than stored.
 *
 * There is no alerts table, no acknowledgement and no notification. That is a
 * deliberate limit, not an oversight: a stored alert needs a lifecycle — raised,
 * acknowledged, resolved, re-raised — and getting that wrong produces the worst
 * possible outcome, which is a screen full of stale alarms nobody reads.
 *
 * What exists now is the honest half: the conditions phase 4 can actually see
 * are computed from the inventory every time this is asked, so an alert
 * disappears the moment the condition does and can never be stale. Acknowledging
 * one, silencing it, or being told about it by email is listed in
 * docs/known-gaps.md rather than half-built here.
 *
 * The conditions are the ones the roadmap names plus the ones that mean the
 * inventory itself cannot be trusted — a cluster Velnox has stopped being able
 * to read is the alert that matters most, because every other screen keeps
 * showing the last thing it knew.
 */

export type AlertSeverity = 'CRITICAL' | 'WARNING';

export interface Alert {
  /** A stable code. The frontend renders it in the reader's language (ADR-019). */
  code: string;
  severity: AlertSeverity;
  clusterId: string;
  clusterName: string;
  tenantId: string;
  tenantName: string;
  /** What the alert is about: a node name, a flag, a version list. */
  subject: string | null;
  /** Values the message interpolates. Never free prose. */
  params: Record<string, string | number>;
  since: string | null;
}

@Injectable()
export class AlertsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<Alert[]> {
    const clusters = await this.prisma.client.cluster.findMany({
      include: {
        tenant: { select: { name: true } },
        nodes: {
          where: { state: { not: 'ONLINE' } },
          select: { name: true, state: true, lastSeenAt: true },
        },
      },
      orderBy: [{ name: 'asc' }],
    });

    const alerts: Alert[] = [];

    for (const cluster of clusters) {
      const base = {
        clusterId: cluster.id,
        clusterName: cluster.name,
        tenantId: cluster.tenantId,
        tenantName: cluster.tenant.name,
      };

      if (cluster.connectionState === 'FAILED') {
        alerts.push({
          ...base,
          code: 'cluster.unreachable',
          severity: 'CRITICAL',
          subject: cluster.endpointHost,
          params: { host: cluster.endpointHost, reason: cluster.lastErrorCode ?? 'unknown' },
          since: cluster.lastSeenAt?.toISOString() ?? null,
        });
      }

      // Quorum only means something for a real cluster. A standalone node has
      // none to lose, and reporting it would make a healthy machine red.
      if (cluster.kind === 'CLUSTER' && cluster.quorate === false) {
        alerts.push({
          ...base,
          code: 'cluster.quorum_lost',
          severity: 'CRITICAL',
          subject: null,
          params: { nodes: cluster.nodeCount },
          since: cluster.lastDiscoveryAt?.toISOString() ?? null,
        });
      }

      for (const node of cluster.nodes) {
        alerts.push({
          ...base,
          code: node.state === 'OFFLINE' ? 'node.offline' : 'node.state_unknown',
          severity: node.state === 'OFFLINE' ? 'CRITICAL' : 'WARNING',
          subject: node.name,
          params: { node: node.name },
          since: node.lastSeenAt?.toISOString() ?? null,
        });
      }

      if (cluster.pveVersions.length > 1) {
        alerts.push({
          ...base,
          code: 'cluster.mixed_versions',
          severity: 'WARNING',
          subject: null,
          params: { versions: cluster.pveVersions.join(', ') },
          since: cluster.lastDiscoveryAt?.toISOString() ?? null,
        });
      }

      if (cluster.cephPresent) {
        if (cluster.cephHealth === 'HEALTH_ERR') {
          alerts.push({
            ...base,
            code: 'ceph.health_error',
            severity: 'CRITICAL',
            subject: null,
            params: { status: cluster.cephHealth },
            since: cluster.lastDiscoveryAt?.toISOString() ?? null,
          });
        } else if (cluster.cephHealth && cluster.cephHealth !== 'HEALTH_OK') {
          alerts.push({
            ...base,
            code: 'ceph.health_warning',
            severity: 'WARNING',
            subject: null,
            params: { status: cluster.cephHealth },
            since: cluster.lastDiscoveryAt?.toISOString() ?? null,
          });
        }

        /*
         * The one the roadmap names by hand.
         *
         * A cluster left with `noout` after an aborted maintenance window looks
         * completely healthy — Ceph stops rebalancing, so nothing goes red — and
         * stays that way until a disk dies and nobody notices. It is exactly the
         * class of problem an inventory is for.
         */
        for (const flag of cluster.cephFlags) {
          alerts.push({
            ...base,
            code: 'ceph.flag_set',
            severity: 'WARNING',
            subject: flag,
            params: { flag },
            since: cluster.lastDiscoveryAt?.toISOString() ?? null,
          });
        }

        if (cluster.cephVersionsHomogeneous === false) {
          alerts.push({
            ...base,
            code: 'ceph.mixed_versions',
            severity: 'WARNING',
            subject: null,
            params: { versions: cluster.cephVersions.join(', ') },
            since: cluster.lastDiscoveryAt?.toISOString() ?? null,
          });
        }
      }
    }

    // Critical first, then by cluster, so the list reads top-down in the order
    // somebody would work through it.
    const rank: Record<AlertSeverity, number> = { CRITICAL: 0, WARNING: 1 };
    return alerts.sort(
      (a, b) => rank[a.severity] - rank[b.severity] || a.clusterName.localeCompare(b.clusterName),
    );
  }
}
