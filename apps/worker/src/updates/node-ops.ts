import { waitForTask, installedKernelVersions, type ProxmoxClient } from '@velnox/proxmox';
import { ERROR_CODES, newerKernelInstalled, type RebootPolicy } from '@velnox/shared';
import { StepError } from '../jobs/steps';
import type { LibraryServices } from '../library/services';
import type { SshTarget } from '../library/ssh';
import {
  COMMANDS,
  WRONG_NODE_EXIT,
  parseAptSimulate,
  parseRebootRequired,
  type CommandSpec,
} from '../remote/commands';
import { CommandTimeoutError, lineBuffer, runCommand } from '../remote/exec';
import { quorumAllows } from './quorum';

/**
 * What updating one node is, step by step — shared by node.update (Phase 6)
 * and the rolling update (Phase 7), so a cluster's nodes are updated by
 * exactly the code that is proven on one.
 */

export type Log = (stream: 'STDOUT' | 'STDERR', text: string) => Promise<void>;

export interface NodeHandle {
  node: string;
  pve: ProxmoxClient;
  signal: AbortSignal;
  log: Log;
  sleep(ms: number): Promise<void>;
  ssh(): Promise<SshTarget>;
}

export function sshFor(services: LibraryServices, clusterId: string, node: string) {
  let target: SshTarget | null = null;
  return async (): Promise<SshTarget> => {
    if (target) return target;
    try {
      target = await services.sshTarget(clusterId, node);
    } catch (error) {
      throw new StepError(
        ERROR_CODES.updateSshRequired,
        `SSH is not set up for ${node}: ${error instanceof Error ? error.message : 'unknown'}`,
        { node },
      );
    }
    return target;
  };
}

/** Run a registered command on the node; its output into the log when `echo`. */
export async function runRegistered(handle: NodeHandle, spec: CommandSpec, echo: boolean) {
  const buffer = lineBuffer(handle.log);
  let result;
  try {
    result = await runCommand(await handle.ssh(), spec, handle.node, {
      signal: handle.signal,
      onOutput: echo ? buffer.push : undefined,
    });
  } catch (error) {
    await buffer.flush();
    if (error instanceof CommandTimeoutError) {
      throw new StepError(ERROR_CODES.updateCommandFailed, error.message, {
        command: spec.id,
        exitCode: -1,
      });
    }
    throw error;
  }
  await buffer.flush();
  if (result.exitCode === WRONG_NODE_EXIT) {
    throw new StepError(
      ERROR_CODES.updateCommandFailed,
      `The machine reached for ${handle.node} is not called ${handle.node}; nothing was run`,
      { command: spec.id, exitCode: WRONG_NODE_EXIT },
    );
  }
  if (result.exitCode !== 0) {
    if (!echo && result.stderr) await handle.log('STDERR', result.stderr.slice(-4000));
    throw new StepError(
      ERROR_CODES.updateCommandFailed,
      `${spec.id} on ${handle.node} ended with exit code ${result.exitCode}`,
      { command: spec.id, exitCode: result.exitCode ?? -1 },
    );
  }
  return result;
}

/** `apt-get update`, through Proxmox's API. */
export async function refreshLists(handle: NodeHandle): Promise<void> {
  const upid = await handle.pve.refreshUpdates(handle.node);
  const outcome = await waitForTask(handle.pve, upid, {
    signal: handle.signal,
    timeoutMs: 10 * 60_000,
  });
  if (!outcome.succeeded) {
    throw new StepError(
      ERROR_CODES.updateCommandFailed,
      `apt-get update on ${handle.node} failed: ${outcome.exitStatus}`,
      { command: 'apt.update', exitCode: -1 },
    );
  }
  await handle.log('STDOUT', 'Package lists refreshed');
}

/** What a dist-upgrade would install, each with where it comes from. */
export async function simulate(
  handle: NodeHandle,
): Promise<{ packages: number; security: number }> {
  const result = await runRegistered(handle, COMMANDS.aptSimulate, false);
  const installs = parseAptSimulate(result.stdout);
  const security = installs.filter((i) => /security/i.test(i.archive ?? ''));
  for (const install of installs) {
    await handle.log(
      'STDOUT',
      `  ${install.package} ${install.currentVersion ?? '(new)'} → ${install.candidateVersion}${install.archive ? ` [${install.archive}]` : ''}`,
    );
  }
  await handle.log(
    'STDOUT',
    `${installs.length} package${installs.length === 1 ? '' : 's'} to install, ${security.length} from a security archive`,
  );
  return { packages: installs.length, security: security.length };
}

/** The dist-upgrade, its output as it runs. Not interruptible. */
export async function distUpgrade(handle: NodeHandle): Promise<void> {
  await handle.log('STDOUT', 'Running apt-get dist-upgrade; a cancel waits for it to finish');
  await runRegistered(handle, COMMANDS.aptDistUpgrade, true);
  await handle.log('STDOUT', 'dist-upgrade finished');
}

const REBOOT_TIMEOUT_MS = 20 * 60_000;
const REBOOT_POLL_MS = 5_000;

/**
 * Reboot the node when the policy says so, if the cluster keeps quorum with
 * `leaving` nodes away (this one and the others of its group), and wait for it
 * to come back with a fresh uptime.
 */
export async function rebootIfNeeded(
  handle: NodeHandle,
  policy: RebootPolicy,
  leaving: number,
): Promise<{ rebooted: boolean; required: boolean }> {
  const marker = parseRebootRequired(
    (await runRegistered(handle, COMMANDS.rebootRequired, false)).stdout,
  );
  const [status, versions] = await Promise.all([
    handle.pve.nodeStatus(handle.node),
    handle.pve.nodePackageVersions(handle.node),
  ]);
  const running = status['current-kernel']?.release ?? null;
  const newer = newerKernelInstalled(running, installedKernelVersions(versions));
  const required = marker.required || newer !== null;
  const reason = newer
    ? `kernel ${newer} is installed, ${running} is running`
    : marker.required
      ? `the node asks for it (${marker.packages.join(', ') || 'no package named'})`
      : null;

  if (policy === 'NEVER' || (policy === 'IF_REQUIRED' && !required)) {
    await handle.log(
      'STDOUT',
      required ? `A reboot is due (${reason}); the policy does not reboot` : 'No reboot needed',
    );
    return { rebooted: false, required };
  }

  const quorum = await quorumAllows(handle.pve, leaving);
  if (!quorum.ok) {
    throw new StepError(
      ERROR_CODES.updateNotQuorate,
      `Rebooting ${handle.node} would leave the cluster without quorum (${quorum.online} of ${quorum.total} online); updates are installed, the reboot was not done`,
      { online: quorum.online, total: quorum.total },
    );
  }
  const uptimeBefore = status.uptime ?? Number.MAX_SAFE_INTEGER;
  await handle.log('STDOUT', `Rebooting ${handle.node}${reason ? `: ${reason}` : ''}`);
  await handle.pve.nodeCommand(handle.node, 'reboot');

  const started = Date.now();
  let wentDown = false;
  for (;;) {
    await handle.sleep(REBOOT_POLL_MS);
    const now = await handle.pve.nodeStatus(handle.node).catch(() => null);
    if (!now) wentDown = true;
    else if ((now.uptime ?? Number.MAX_SAFE_INTEGER) < uptimeBefore) {
      await handle.log(
        'STDOUT',
        `${handle.node} is back, running ${now['current-kernel']?.release ?? 'an unknown kernel'}`,
      );
      break;
    }
    if (Date.now() - started > REBOOT_TIMEOUT_MS) {
      throw new StepError(
        ERROR_CODES.updateRebootTimeout,
        `${handle.node} did not come back within ${REBOOT_TIMEOUT_MS / 60_000} minutes${wentDown ? '' : ' (it was never seen going down)'}`,
        { node: handle.node, minutes: REBOOT_TIMEOUT_MS / 60_000 },
      );
    }
  }
  return { rebooted: true, required };
}
