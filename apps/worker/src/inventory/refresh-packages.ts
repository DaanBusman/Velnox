import { waitForTask, type ProxmoxClient } from '@velnox/proxmox';

/**
 * `apt-get update` on every online node of a cluster, before a discovery run
 * reads what they would update (0.7.23, Refresh on Updates & upgrades → Nodes).
 *
 * The pending updates Velnox shows are what apt saw at its last `apt-get
 * update`, and on a Proxmox node that is the daily `pve-daily-update` timer:
 * a fix published this morning is not on the list until tomorrow. This is the
 * Refresh button of Proxmox's own Updates panel, for every node at once:
 * Proxmox's `POST /nodes/{node}/apt/update`, as a task, waited for.
 *
 * Nothing else. It does not touch repositories — moving a node without a
 * subscription to the no-subscription repositories is what an update job does
 * before it updates, and it is a change an operator asks for, not a side effect
 * of looking. The nodes run in parallel; one that fails is named in the run's
 * problems and the others still count.
 */

/** apt-get update on a slow mirror can take a while; longer than this is not refreshing. */
const TASK_TIMEOUT_MS = 5 * 60_000;

export async function refreshPackageLists(
  client: ProxmoxClient,
  timeoutMs = TASK_TIMEOUT_MS,
): Promise<{ refreshed: string[]; problems: string[] }> {
  const nodes = (await client.nodes()).filter((node) => node.status === 'online');
  const results = await Promise.all(
    nodes.map(async ({ node }) => {
      try {
        const upid = await client.refreshUpdates(node);
        const outcome = await waitForTask(client, upid, { timeoutMs });
        if (outcome.succeeded) return { node, problem: null };
        // The exit status says "exit code 100"; why is in the task's log.
        const log = await client.taskLog(node, upid).catch(() => []);
        const reason = log
          .map((line) => line.t.trim())
          .find((line) => line.startsWith('E:') || line.startsWith('Err:'));
        return {
          node,
          problem: `${node}: apt-get update: ${outcome.exitStatus}${reason ? ` — ${reason}` : ''}`,
        };
      } catch (error) {
        return {
          node,
          problem: `${node}: apt-get update: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }),
  );
  return {
    refreshed: results.filter((r) => r.problem === null).map((r) => r.node),
    problems: results.flatMap((r) => (r.problem ? [r.problem] : [])),
  };
}
