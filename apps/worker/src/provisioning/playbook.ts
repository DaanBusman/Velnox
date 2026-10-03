import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { Prisma, Provisioning } from '@velnox/db';
import { waitForTask, type ProxmoxClient } from '@velnox/proxmox';
import {
  ERROR_CODES,
  generatePassword,
  importFilename,
  templateSettingsSchema,
  type LinuxTemplate,
  type ProvisionNetwork,
  type TemplateSettings,
  type WindowsTemplate,
} from '@velnox/shared';
import type { CredentialReader, GuestCredentials } from '../inventory/credentials';
import type { LibraryServices } from '../library/services';
import { StepError, type Playbook, type StepContext } from '../jobs/steps';
import { buildAutounattend, isServerEdition, WINDOWS_DONE_MARKER } from './autounattend';
import { buildCloudInit, LINUX_DONE_MARKER } from './cloud-init';
import { buildIso } from './iso9660';

/**
 * vm.provision — one VM, from a template, to a finished install.
 *
 * The steps, and what each leaves behind if the job stops after it:
 *
 *   check     nothing — it reads
 *   media     the installer or cloud image on the node's storage, which stays:
 *             it is a copy of a library file, and the next VM uses it
 *   create    a VM, which cleanup destroys with its disks
 *   answers   the answer ISO on the storage, which cleanup deletes — it holds
 *             the unattend passwords in their reversible form
 *   start     a running VM
 *   install   waits for the guest to say it is done
 *   finish    reads the addresses, ejects every CD, deletes the answer ISO
 *   notify    mails the person who asked, when they asked for it
 *
 * **A failed install leaves no half-created VM**: cleanup stops and destroys it,
 * purging its disks, before the job records its final state. If that fails,
 * the job says so with the VMID, because a VM Velnox made and could not remove
 * is something a person has to look at.
 */

export interface ProvisioningServices {
  prisma: LibraryServices['prisma'];
  credentials: CredentialReader;
  library: LibraryServices;
  /** Mail the person who asked. Absent when mail is not wired; the step then records that. */
  notify?(provisioningId: string): Promise<'sent' | 'skipped'>;
  pollIntervalMs: number;
  installTimeoutMs: Record<'WINDOWS' | 'LINUX', number>;
  /** How long a finished VM's passwords stay revealable. */
  credentialRetentionMs: number;
}

const ANSWER_LABEL = { WINDOWS: 'VELNOX', LINUX: 'cidata' } as const;
/** Windows' UEFI loader asks for a key within a few seconds; keep pressing for a while. */
const BOOT_KEYPRESS_WINDOW_MS = 20_000;
const BOOT_KEYPRESS_EVERY_MS = 1_500;

function parseParams(raw: unknown): { provisioningId: string } {
  const value = raw as { provisioningId?: unknown } | null;
  if (
    !value ||
    typeof value.provisioningId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(value.provisioningId)
  ) {
    throw new StepError(ERROR_CODES.validation, 'vm.provision needs a provisioningId');
  }
  return { provisioningId: value.provisioningId };
}

/** Proxmox's OS type for a Windows edition, which decides its default devices and timers. */
export function windowsOsType(imageName: string): 'win11' | 'win10' {
  const name = imageName.toLowerCase();
  if (/windows\s*11|server\s*(2022|2025)/.test(name)) return 'win11';
  return 'win10';
}

const netDevice = (model: string, bridge: string, vlan: number | null) =>
  `${model},bridge=${bridge}${vlan ? `,tag=${vlan}` : ''}`;

/** The VM's configuration, before any answer media. Exported for tests. */
export function vmCreateParams(input: {
  vmid: number;
  settings: TemplateSettings;
  provisioning: Pick<
    Provisioning,
    'id' | 'hostname' | 'diskStorage' | 'mediaStorage' | 'bridge' | 'vlan' | 'templateName'
  >;
  /** For Linux: the import volume's filename on the media storage. */
  importName?: string;
}): Record<string, string | number> {
  const { settings, provisioning: p, vmid } = input;
  const hw = settings.hardware;
  const common = {
    vmid,
    name: p.hostname,
    cores: hw.cores,
    sockets: 1,
    memory: hw.memoryMb,
    cpu: hw.cpuType,
    agent: settings.guestAgent ? 'enabled=1' : 'enabled=0',
    tags: 'velnox',
    description: `Built by Velnox from template "${p.templateName}" (provisioning ${p.id}).`,
  };

  if (settings.family === 'WINDOWS') {
    const gpt = settings.diskLayout === 'GPT';
    const disk = settings.virtio ? 'scsi0' : 'sata0';
    return {
      ...common,
      ostype: windowsOsType(settings.imageName),
      machine: 'q35',
      bios: gpt ? 'ovmf' : 'seabios',
      ...(gpt
        ? {
            efidisk0: `${p.diskStorage}:1,efitype=4m,pre-enrolled-keys=1`,
            tpmstate0: `${p.diskStorage}:1,version=v2.0`,
          }
        : {}),
      ...(settings.virtio ? { scsihw: 'virtio-scsi-single' } : {}),
      [disk]: `${p.diskStorage}:${hw.diskGb}${settings.virtio ? ',iothread=1' : ''},discard=on`,
      net0: netDevice(settings.virtio ? 'virtio' : 'e1000', p.bridge, p.vlan),
      ide2: `${p.mediaStorage}:iso/${settings.isoFilename},media=cdrom`,
      ...(settings.virtioIsoFilename
        ? { ide0: `${p.mediaStorage}:iso/${settings.virtioIsoFilename},media=cdrom` }
        : {}),
      // The installer first. After Setup's first reboot the loader's prompt
      // times out with nobody pressing a key, and the disk boots.
      boot: `order=ide2;${disk}`,
    };
  }

  if (!input.importName) throw new Error('A Linux VM needs its import volume');
  return {
    ...common,
    ostype: 'l26',
    scsihw: 'virtio-scsi-single',
    scsi0: `${p.diskStorage}:0,import-from=${p.mediaStorage}:import/${input.importName},iothread=1,discard=on`,
    net0: netDevice('virtio', p.bridge, p.vlan),
    // Cloud images expect a serial console, and print their boot to it.
    serial0: 'socket',
    vga: 'serial0',
    boot: 'order=scsi0',
  };
}

/** The first NIC's MAC, from `net0: virtio=BC:24:11:AA:BB:CC,bridge=vmbr0`. */
export function macFromNet0(net0: string | number | undefined): string | null {
  const match = /^[a-z0-9]+=([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})/.exec(String(net0 ?? ''));
  return match ? match[1]!.toUpperCase() : null;
}

/** Addresses worth showing: not loopback, not link-local. */
export function usableAddresses(
  interfaces: {
    name: string;
    'ip-addresses'?: { 'ip-address': string; 'ip-address-type': string }[];
  }[],
): string[] {
  const out: string[] = [];
  for (const iface of interfaces) {
    if (/^lo$|^Loopback/i.test(iface.name)) continue;
    for (const address of iface['ip-addresses'] ?? []) {
      const ip = address['ip-address'];
      if (/^127\.|^169\.254\.|^::1$|^fe80:/i.test(ip)) continue;
      out.push(ip);
    }
  }
  return [...new Set(out)];
}

export function provisionPlaybook(raw: unknown, services: ProvisioningServices): Playbook {
  const { provisioningId } = parseParams(raw);
  const { prisma } = services;

  // What cleanup needs, filled in as the job gets there.
  let client: ProxmoxClient | null = null;
  let row: Provisioning | null = null;
  let settings: TemplateSettings | null = null;
  let vmid: number | null = null;
  let answerVolid: string | null = null;
  let incompleteUpload: string | null = null;
  let guestCredentialId: string | null = null;
  let finished = false;
  let lastError: unknown = null;

  const remember = <T>(run: () => Promise<T>) =>
    run().catch((error: unknown) => {
      lastError = error;
      throw error;
    });

  const connect = async (): Promise<ProxmoxClient> => {
    if (!row?.clusterId) throw new StepError(ERROR_CODES.notFound, 'The cluster is gone');
    client ??= (await services.library.connect(row.clusterId)).client;
    return client;
  };

  const load = async (): Promise<{ row: Provisioning; settings: TemplateSettings }> => {
    if (row && settings) return { row, settings };
    const found = await prisma.provisioning.findUnique({ where: { id: provisioningId } });
    if (!found) throw new StepError(ERROR_CODES.notFound, `Provisioning ${provisioningId} is gone`);
    const parsed = templateSettingsSchema.safeParse(found.templateSnapshot);
    if (!parsed.success) {
      throw new StepError(
        ERROR_CODES.validation,
        'The template copy on this record does not validate',
      );
    }
    row = found;
    settings = parsed.data as TemplateSettings;
    return { row, settings };
  };

  const update = (data: Prisma.ProvisioningUpdateInput) =>
    prisma.provisioning.update({ where: { id: provisioningId }, data });

  const waitTask = async (
    pve: ProxmoxClient,
    upid: string | null,
    what: string,
    context: StepContext,
  ) => {
    if (!upid) return;
    const outcome = await waitForTask(pve, upid, {
      signal: context.signal,
      timeoutMs: 30 * 60_000,
    });
    if (!outcome.succeeded) {
      const log = await pve.taskLog(outcome.node, upid).catch(() => []);
      await context.log(
        'STDERR',
        log
          .map((line) => line.t)
          .join('\n')
          .slice(-4000),
      );
      throw new StepError(ERROR_CODES.generic, `${what} failed: ${outcome.exitStatus}`);
    }
  };

  /** A library file on the node's storage, uploaded if it is not there yet. */
  const ensureOnStorage = async (
    context: StepContext,
    filename: string,
    content: 'iso' | 'import',
    onProgress: (pct: number) => Promise<void>,
  ): Promise<string> => {
    const { row: r } = await load();
    const pve = await connect();
    const item = await prisma.libraryItem.findFirst({
      where: { filename: { equals: filename, mode: 'insensitive' }, state: 'READY' },
    });
    if (!item || item.sizeBytes === null || !item.sha256) {
      throw new StepError(
        ERROR_CODES.autoconfigMediaMissing,
        `${filename} is not ready in the library`,
        {
          filename,
        },
      );
    }
    const name =
      content === 'import'
        ? importFilename(item.filename, item.diskFormat === 'raw' ? 'raw' : 'qcow2')
        : item.filename;
    const volid = `${r.mediaStorage}:${content}/${name}`;

    const present = await pve.storageContent(r.node, r.mediaStorage, content);
    const existing = present.find((entry) => entry.volid === volid);
    if (existing) {
      if (typeof existing.size === 'number' && existing.size !== Number(item.sizeBytes)) {
        throw new StepError(
          ERROR_CODES.librarySizeMismatch,
          `${volid} is on the node with a different size from the library's ${item.filename}; delete it there or rename one`,
          { filename: item.filename },
        );
      }
      await context.log('STDOUT', `${volid} is already on ${r.node}`);
      return name;
    }

    await context.log(
      'STDOUT',
      `${volid} is not on ${r.node}; sending ${item.filename} from the library`,
    );
    incompleteUpload = volid;
    const size = Number(item.sizeBytes);
    let lastReport = 0;
    const upid = await pve.uploadToStorage(r.node, r.mediaStorage, {
      content,
      filename: name,
      size,
      open: () => createReadStream(services.library.paths.item(item.id)),
      sha256: item.sha256,
      signal: context.signal,
      onProgress: (bytes) => {
        const now = Date.now();
        if (now - lastReport > 1000) {
          lastReport = now;
          void onProgress(Math.round((bytes / size) * 100)).catch(() => undefined);
        }
      },
    });
    await waitTask(pve, upid, `Copying ${item.filename} to ${r.node}`, context);
    incompleteUpload = null;
    await services.library.refreshContents(r.clusterId!).catch(() => undefined);
    return name;
  };

  /**
   * Every password this VM gets, decided once and stored before anything uses it.
   * `note` is told, without a value, where a password set per tenant came from.
   */
  const decideCredentials = async (
    note: (text: string) => Promise<void>,
  ): Promise<{
    credentials: GuestCredentials;
    passwords: Record<string, string>;
  }> => {
    const { row: r, settings: s } = await load();
    const template = r.templateId
      ? await prisma.autoconfigTemplate.findUnique({
          where: { id: r.templateId },
          select: { secretRefs: true },
        })
      : null;
    const refs = (template?.secretRefs ?? {}) as Record<string, string>;
    const fixed = async (key: string): Promise<string> => {
      const ref = refs[key];
      if (!ref) {
        throw new StepError(
          ERROR_CODES.autoconfigIncomplete,
          `The template has no stored secret for ${key}`,
          {
            missing: key,
          },
        );
      }
      return services.credentials.templateSecret(ref);
    };
    /**
     * The password stored for the tenant the VM is built for, or a new one when
     * that tenant has none — the owner's choice: building never stops for it.
     */
    const forTenant = async (key: string): Promise<string> => {
      const ref = refs[`tenant:${r.tenantId}:${key}`];
      if (ref) {
        await note(`The ${key} password is the one set for this tenant on the template`);
        return services.credentials.templateSecret(ref);
      }
      await note(`No ${key} password is set for this tenant on the template; one was generated`);
      return generatePassword();
    };
    const decide = async (mode: string, key: string): Promise<string | null> =>
      mode === 'GENERATE'
        ? generatePassword()
        : mode === 'FIXED'
          ? fixed(key)
          : mode === 'PER_TENANT'
            ? forTenant(key)
            : null;

    const passwords: Record<string, string> = {};
    const accounts: GuestCredentials['accounts'] = [];
    let productKey: string | null = null;

    if (s.family === 'WINDOWS') {
      const admin = (await decide(s.administratorPassword, 'administrator'))!;
      passwords.administrator = admin;
      accounts.push({
        name: 'Administrator',
        // A desktop's built-in Administrator is switched off after the first logon.
        password: isServerEdition(s.imageName) ? admin : null,
        administrator: true,
      });
      for (const account of s.accounts) {
        const password = (await decide(account.password, `account:${account.name}`))!;
        passwords[account.name] = password;
        accounts.push({ name: account.name, password, administrator: account.administrator });
      }
      if (s.hasProductKey) productKey = await fixed('productKey');
    } else {
      for (const user of s.users) {
        const password = await decide(user.password, `account:${user.name}`);
        if (password) passwords[user.name] = password;
        accounts.push({ name: user.name, password, administrator: user.sudo });
      }
      const root = await decide(s.root.password, 'root');
      if (root) {
        passwords.root = root;
        accounts.push({ name: 'root', password: root, administrator: true });
      }
    }
    const credentials: GuestCredentials = { accounts, productKey };
    guestCredentialId = await services.credentials.storeGuestCredentials({
      tenantId: r.tenantId,
      clusterId: r.clusterId!,
      hostname: r.hostname,
      credentials,
    });
    await update({ credentialsCredentialId: guestCredentialId });
    return { credentials, passwords };
  };

  return {
    version: 1,
    steps: [
      {
        kind: 'task',
        key: 'check',
        phase: 'preflight',
        run: (context) =>
          remember(async () => {
            const { row: r, settings: s } = await load();
            await update({ state: 'RUNNING', startedAt: new Date() });
            const pve = await connect();

            const resources = await pve.clusterResources();
            const node = resources.find((res) => res.type === 'node' && res.node === r.node);
            if (!node || node.status !== 'online') {
              throw new StepError(ERROR_CODES.nodeOffline, `${r.node} is not online`, {
                node: r.node,
              });
            }
            const clash = resources.find(
              (res) => res.type === 'qemu' && res.name?.toLowerCase() === r.hostname.toLowerCase(),
            );
            if (clash) {
              throw new StepError(
                ERROR_CODES.provisioningHostnameTaken,
                `${r.hostname} exists as VM ${clash.vmid}`,
                {
                  hostname: r.hostname,
                  vmid: clash.vmid ?? null,
                },
              );
            }

            const need: [string, string][] = [
              [r.diskStorage, 'images'],
              [r.mediaStorage, 'iso'],
              ...(s.family === 'LINUX' ? ([[r.mediaStorage, 'import']] as [string, string][]) : []),
            ];
            for (const [storage, content] of need) {
              const status = await pve.storageStatus(r.node, storage);
              const types = (status.content ?? '').split(',').map((t) => t.trim());
              if (status.enabled === 0 || status.active === 0 || !types.includes(content)) {
                throw new StepError(
                  ERROR_CODES.provisioningStorageUnsuitable,
                  `${storage} on ${r.node} does not take ${content} content`,
                  { storage, node: r.node, content },
                );
              }
            }
            const network = await pve.nodeNetwork(r.node);
            if (
              !network.some((iface) => iface.iface === r.bridge && /bridge/i.test(iface.type ?? ''))
            ) {
              throw new StepError(
                ERROR_CODES.provisioningBridgeUnknown,
                `${r.node} has no bridge ${r.bridge}`,
                {
                  bridge: r.bridge,
                  node: r.node,
                },
              );
            }
            await context.log(
              'STDOUT',
              `Building ${r.hostname} on ${r.node} from "${r.templateName}" (${s.family.toLowerCase()})`,
            );
            return { node: r.node, hostname: r.hostname };
          }),
      },
      {
        kind: 'task',
        key: 'media',
        phase: 'transfer',
        run: (context) =>
          remember(async () => {
            const { settings: s } = await load();
            if (s.family === 'WINDOWS') {
              await ensureOnStorage(context, s.isoFilename, 'iso', (pct) =>
                context.progress(pct * 0.8),
              );
              if (s.virtioIsoFilename) {
                await ensureOnStorage(context, s.virtioIsoFilename, 'iso', (pct) =>
                  context.progress(80 + pct * 0.2),
                );
              }
            } else {
              await ensureOnStorage(context, s.imageFilename, 'import', (pct) =>
                context.progress(pct),
              );
            }
            await context.progress(100);
          }),
      },
      {
        kind: 'task',
        key: 'create',
        phase: 'apply',
        run: (context) =>
          remember(async () => {
            const { row: r, settings: s } = await load();
            const pve = await connect();
            let importName: string | undefined;
            if (s.family === 'LINUX') {
              const item = await prisma.libraryItem.findFirst({
                where: {
                  filename: { equals: s.imageFilename, mode: 'insensitive' },
                  state: 'READY',
                },
                select: { filename: true, diskFormat: true },
              });
              importName = importFilename(
                item!.filename,
                item!.diskFormat === 'raw' ? 'raw' : 'qcow2',
              );
            }
            const id = await pve.nextVmid();
            const params = vmCreateParams({ vmid: id, settings: s, provisioning: r, importName });
            await context.log('STDOUT', `Creating VM ${id} (${r.hostname})`);
            const upid = await pve.createVm(r.node, params);
            // From here the VM may exist, so cleanup must look for it.
            vmid = id;
            await update({ vmid: id });
            await waitTask(pve, upid, `Creating VM ${id}`, context);

            if (s.family === 'LINUX') {
              // A cloud image is a couple of gigabytes; grow it to what the template asks for.
              try {
                const resize = await pve.resizeDisk(r.node, id, 'scsi0', `${s.hardware.diskGb}G`);
                await waitTask(pve, resize, `Growing the disk of VM ${id}`, context);
              } catch (error) {
                await context.log(
                  'STDERR',
                  `The disk was not grown to ${s.hardware.diskGb} GB (${error instanceof Error ? error.message : 'unknown'}); the image is already that size or larger`,
                );
              }
            }
            return { vmid: id };
          }),
      },
      {
        kind: 'task',
        key: 'answers',
        phase: 'apply',
        run: (context) =>
          remember(async () => {
            const { row: r, settings: s } = await load();
            const pve = await connect();
            const config = await pve.vmConfig(r.node, vmid!);
            const mac = macFromNet0(config.net0);
            if (!mac)
              throw new StepError(ERROR_CODES.generic, `VM ${vmid} has no network card to address`);

            const { credentials, passwords } = await decideCredentials((text) =>
              context.log('STDOUT', text),
            );
            const network = r.network as unknown as ProvisionNetwork;
            const files =
              s.family === 'WINDOWS'
                ? [
                    {
                      name: 'Autounattend.xml',
                      content: Buffer.from(
                        buildAutounattend({
                          settings: s as WindowsTemplate,
                          hostname: r.hostname,
                          macAddress: mac,
                          network,
                          passwords,
                          productKey: credentials.productKey ?? null,
                        }),
                        'utf8',
                      ),
                    },
                  ]
                : (() => {
                    const seed = buildCloudInit({
                      settings: s as LinuxTemplate,
                      hostname: r.hostname,
                      instanceId: `velnox-${r.id}`,
                      macAddress: mac,
                      network,
                      passwords,
                    });
                    return [
                      { name: 'user-data', content: Buffer.from(seed.userData, 'utf8') },
                      { name: 'meta-data', content: Buffer.from(seed.metaData, 'utf8') },
                      { name: 'network-config', content: Buffer.from(seed.networkConfig, 'utf8') },
                    ];
                  })();
            const iso = buildIso({ label: ANSWER_LABEL[s.family], files });
            const name = `velnox-answers-${r.id}.iso`;
            const sha256 = createHash('sha256').update(iso).digest('hex');

            // Counted as ours from before the first byte: a half-sent one is deleted too.
            answerVolid = `${r.mediaStorage}:iso/${name}`;
            const upid = await pve.uploadToStorage(r.node, r.mediaStorage, {
              content: 'iso',
              filename: name,
              size: iso.length,
              open: () => Readable.from(iso),
              sha256,
              signal: context.signal,
            });
            await waitTask(pve, upid, 'Sending the answer media', context);
            const slot = s.family === 'WINDOWS' ? 'ide3' : 'ide2';
            const set = await pve.setVmConfig(r.node, vmid!, {
              [slot]: `${answerVolid},media=cdrom`,
            });
            await waitTask(pve, set, 'Attaching the answer media', context);
            // The file names, never their contents: they carry the passwords.
            await context.log(
              'STDOUT',
              `Attached ${answerVolid} (${files.map((f) => f.name).join(', ')})`,
            );
            return { answers: answerVolid };
          }),
      },
      {
        kind: 'task',
        key: 'start',
        phase: 'apply',
        run: (context) =>
          remember(async () => {
            const { row: r, settings: s } = await load();
            const pve = await connect();
            const upid = await pve.startVm(r.node, vmid!);
            await waitTask(pve, upid, `Starting VM ${vmid}`, context);
            if (s.family === 'WINDOWS' && s.diskLayout === 'GPT') {
              // "Press any key to boot from CD or DVD", with nobody there.
              const until = Date.now() + BOOT_KEYPRESS_WINDOW_MS;
              while (Date.now() < until) {
                await pve.sendKey(r.node, vmid!, 'ret').catch(() => undefined);
                await context.sleep(BOOT_KEYPRESS_EVERY_MS);
              }
              await context.log('STDOUT', 'Pressed Enter at the boot prompt for the installer');
            }
            return { vmid: vmid! };
          }),
      },
      {
        kind: 'task',
        key: 'install',
        phase: 'verify',
        run: (context) =>
          remember(async () => {
            const { row: r, settings: s } = await load();
            const pve = await connect();
            const marker = s.family === 'WINDOWS' ? WINDOWS_DONE_MARKER : LINUX_DONE_MARKER;
            const timeout = services.installTimeoutMs[s.family];
            const started = Date.now();
            let stoppedSince: number | null = null;
            await context.log('STDOUT', `Waiting for ${marker} inside the guest`);
            for (;;) {
              const found = await pve
                .agentFileRead(r.node, vmid!, marker)
                .then((file) => file.content.trim().length > 0)
                .catch(() => false);
              if (found) break;

              const status = await pve.vmStatus(r.node, vmid!).catch(() => null);
              if (status?.status === 'stopped') {
                // Setup reboots are resets inside a running VM; a stopped VM is
                // one that crashed, or was turned off by someone.
                stoppedSince ??= Date.now();
                if (Date.now() - stoppedSince > 60_000) {
                  throw new StepError(
                    ERROR_CODES.generic,
                    `VM ${vmid} stopped during the installation`,
                  );
                }
              } else {
                stoppedSince = null;
              }

              const waited = Date.now() - started;
              if (waited > timeout) {
                throw new StepError(
                  ERROR_CODES.provisioningInstallTimeout,
                  `No sign of a finished install after ${Math.round(waited / 60_000)} minutes`,
                  { minutes: Math.round(timeout / 60_000) },
                );
              }
              // Time is the only measure there is; it is shown as an estimate.
              await context.progress(Math.min(95, Math.round((waited / timeout) * 100 * 2)));
              await context.sleep(services.pollIntervalMs);
            }
            await context.progress(100);
            return { seconds: Math.round((Date.now() - started) / 1000) };
          }),
      },
      {
        kind: 'task',
        key: 'finish',
        phase: 'verify',
        run: (context) =>
          remember(async () => {
            const { row: r, settings: s } = await load();
            const pve = await connect();
            const addresses = usableAddresses(
              await pve.agentNetworkInterfaces(r.node, vmid!).catch(() => []),
            );

            // Every CD out: the installer, the drivers, and the answers.
            const eject =
              s.family === 'WINDOWS'
                ? {
                    ide2: 'none,media=cdrom',
                    ...(s.virtioIsoFilename ? { ide0: 'none,media=cdrom' } : {}),
                    delete: 'ide3',
                    boot: `order=${s.virtio ? 'scsi0' : 'sata0'}`,
                  }
                : { delete: 'ide2' };
            const set = await pve.setVmConfig(r.node, vmid!, eject);
            await waitTask(pve, set, 'Ejecting the install media', context);
            if (answerVolid) {
              await pve.deleteVolume(r.node, r.mediaStorage, answerVolid);
              const left = await pve.storageContent(r.node, r.mediaStorage, 'iso');
              if (left.some((entry) => entry.volid === answerVolid)) {
                throw new StepError(ERROR_CODES.generic, `${answerVolid} is still on the storage`);
              }
              answerVolid = null;
            }

            finished = true;
            await update({
              state: 'SUCCEEDED',
              addresses,
              finishedAt: new Date(),
              credentialsExpireAt: new Date(Date.now() + services.credentialRetentionMs),
            });
            await context.log(
              'STDOUT',
              `${r.hostname} is ready as VM ${vmid}${addresses.length ? ` at ${addresses.join(', ')}` : ''}`,
            );
            return { vmid: vmid!, addresses: addresses.join(', ') || null };
          }),
      },
      {
        kind: 'task',
        key: 'notify',
        phase: 'verify',
        // The VM is finished whatever happens here. A mail that fails is
        // recorded, and does not undo the machine.
        run: async (context) => {
          const { row: r } = await load();
          if (!r.notify) return { notified: false };
          if (!services.notify) {
            await context.log(
              'STDERR',
              'Mail is not available in this worker; nobody was notified',
            );
            return { notified: false };
          }
          try {
            const outcome = await services.notify(provisioningId);
            await context.log(
              'STDOUT',
              outcome === 'sent' ? `Notified ${r.requestedByEmail}` : 'Already notified',
            );
            return { notified: outcome === 'sent' };
          } catch (error) {
            await context.log(
              'STDERR',
              `The notification was not sent: ${error instanceof Error ? error.message : 'unknown'}`,
            );
            return { notified: false };
          }
        },
      },
    ],

    async cleanup(reason) {
      if (finished) {
        (client as ProxmoxClient | null)?.close();
        return;
      }
      const problems: string[] = [];
      try {
        const r = row as Provisioning | null;
        if (r && (vmid !== null || answerVolid || incompleteUpload)) {
          const pve = await connect();
          if (vmid !== null) {
            await pve
              .stopVm(r.node, vmid)
              .then((upid) => waitForTask(pve, upid, { timeoutMs: 120_000 }))
              .catch(() => undefined);
            try {
              const upid = await pve.destroyVm(r.node, vmid);
              const outcome = await waitForTask(pve, upid, { timeoutMs: 10 * 60_000 });
              if (!outcome.succeeded) problems.push(`destroying VM ${vmid}: ${outcome.exitStatus}`);
            } catch (error) {
              // Already gone is what we wanted.
              const gone = await pve
                .vmStatus(r.node, vmid)
                .then(() => false)
                .catch(() => true);
              if (!gone)
                problems.push(
                  `destroying VM ${vmid}: ${error instanceof Error ? error.message : 'unknown'}`,
                );
            }
          }
          for (const volid of [answerVolid, incompleteUpload]) {
            if (!volid) continue;
            const content = volid.includes(':import/') ? 'import' : 'iso';
            const present = await pve
              .storageContent(r.node, r.mediaStorage, content)
              .catch(() => []);
            if (present.some((entry) => entry.volid === volid)) {
              await pve.deleteVolume(r.node, r.mediaStorage, volid).catch((error: unknown) => {
                problems.push(
                  `deleting ${volid}: ${error instanceof Error ? error.message : 'unknown'}`,
                );
              });
            }
          }
        }
        // A VM that does not exist has no passwords worth keeping.
        if (guestCredentialId)
          await services.credentials.remove(guestCredentialId).catch(() => undefined);

        const error = lastError;
        await prisma.provisioning.updateMany({
          where: { id: provisioningId, state: { in: ['QUEUED', 'RUNNING'] } },
          data: {
            state: reason === 'cancelled' ? 'CANCELLED' : 'FAILED',
            finishedAt: new Date(),
            credentialsCredentialId: null,
            ...(reason === 'failed'
              ? {
                  errorCode: problems.length
                    ? ERROR_CODES.provisioningCleanupFailed
                    : error instanceof StepError
                      ? error.code
                      : ERROR_CODES.generic,
                  errorParams: (problems.length
                    ? { vmid }
                    : error instanceof StepError && error.params
                      ? error.params
                      : undefined) as Prisma.InputJsonValue | undefined,
                  errorDetail: (error instanceof Error ? error.message : String(error ?? '')).slice(
                    0,
                    1000,
                  ),
                }
              : {}),
          },
        });
      } finally {
        (client as ProxmoxClient | null)?.close();
      }
      if (problems.length) {
        throw new StepError(
          ERROR_CODES.provisioningCleanupFailed,
          `Cleanup left something behind: ${problems.join('; ')}`,
          { vmid },
        );
      }
    },
  };
}
