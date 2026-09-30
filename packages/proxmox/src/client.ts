import type { Agent } from 'node:https';
import type { Readable } from 'node:stream';
import {
  DEFAULT_RETRY,
  ProxmoxHttpError,
  createAgent,
  rawRequest,
  withRetries,
  type PeerCertificate,
  type RetryPolicy,
  type TlsPolicy,
} from './transport';

/** One attempt: for requests that change something and must not be sent twice. */
const NO_RETRY: RetryPolicy = { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 };
import { multipartEnvelope, multipartStream } from './upload';

/**
 * The Proxmox VE API client.
 *
 * Two ways to authenticate, and they are not equivalent.
 *
 * **An API token** is what Velnox asks for and what the documentation tells
 * operators to create. It is scoped, revocable from the Proxmox side without
 * touching a password, survives a password change, and never expires on a timer.
 * It is a single header on every request.
 *
 * **A ticket** (username and password) exists because some things a token cannot
 * do — and because an operator evaluating Velnox will have a password before
 * they have thought about tokens. It is exchanged for a ticket valid for two
 * hours, which then has to be renewed, and it means Velnox holds a password that
 * opens the whole node. It is supported, and the interface says which one you
 * are using.
 *
 * Phase 4 was read-only against the cluster. Phase 5A adds the first writes —
 * putting a file on a storage and deleting one — and they are here, in the
 * client, as named calls with their own types, rather than as a generic
 * `post` a caller could point anywhere.
 */

export type ProxmoxAuth =
  | {
      kind: 'token';
      /** `root@pam!velnox` — user, realm and token id, exactly as Proxmox shows it. */
      tokenId: string;
      secret: string;
    }
  | {
      kind: 'ticket';
      username: string;
      realm: string;
      password: string;
    };

export interface ProxmoxClientOptions {
  host: string;
  port?: number;
  tls: TlsPolicy;
  auth: ProxmoxAuth;
  timeoutMs?: number;
  retry?: RetryPolicy;
  /** Called on each retry, so a job can record why it took three attempts. */
  onRetry?: (attempt: number, error: unknown) => void;
}

/** What Proxmox puts in `data`, plus the certificate the answer arrived over. */
export interface ProxmoxResult<T> {
  data: T;
  certificate: PeerCertificate | null;
}

export class ProxmoxAuthError extends Error {
  constructor(
    readonly host: string,
    readonly detail: string,
  ) {
    super(`Proxmox refused the credentials for ${host}: ${detail}`);
    this.name = 'ProxmoxAuthError';
  }
}

const DEFAULT_PORT = 8006;
const API = '/api2/json';

/** A ticket is valid for two hours; renewed well before that. */
const TICKET_LIFETIME_MS = 110 * 60 * 1000;

/** How long an upload's socket may sit idle before it is given up on. */
const UPLOAD_IDLE_TIMEOUT_MS = 300_000;

interface Ticket {
  value: string;
  csrfToken: string;
  obtainedAt: number;
}

export class ProxmoxClient {
  private readonly port: number;
  /**
   * One connection pool, belonging to this client and therefore to one host and
   * one pin. Never the global agent — see the note in `transport.ts`.
   */
  private readonly agent: Agent;
  private ticket: Ticket | null = null;
  /** The certificate seen on the most recent connection. */
  private lastCertificate: PeerCertificate | null = null;

  constructor(private readonly options: ProxmoxClientOptions) {
    this.port = options.port ?? DEFAULT_PORT;
    this.agent = createAgent();
  }

  /** Close the pool. A discovery run holds connections open until it does. */
  close(): void {
    this.agent.destroy();
  }

  get certificate(): PeerCertificate | null {
    return this.lastCertificate;
  }

  /** How this client authenticates, for display. Never the secret. */
  get authDescription(): string {
    return this.options.auth.kind === 'token'
      ? `token ${this.options.auth.tokenId}`
      : `ticket for ${this.options.auth.username}@${this.options.auth.realm}`;
  }

  // -------------------------------------------------------------------------
  // Endpoints
  // -------------------------------------------------------------------------

  version(): Promise<VersionInfo> {
    return this.get<VersionInfo>('/version');
  }

  clusterStatus(): Promise<ClusterStatusEntry[]> {
    return this.get<ClusterStatusEntry[]>('/cluster/status');
  }

  /**
   * Everything the cluster knows about, in one call.
   *
   * Proxmox aggregates nodes, guests and storage here, which is one request
   * instead of one per node per resource type. On a fifteen-node cluster that is
   * the difference between a discovery run that takes a second and one that
   * takes a minute — and between a cluster that notices Velnox and one that does
   * not.
   */
  clusterResources(): Promise<ClusterResource[]> {
    return this.get<ClusterResource[]>('/cluster/resources');
  }

  nodes(): Promise<NodeListEntry[]> {
    return this.get<NodeListEntry[]>('/nodes');
  }

  nodeStatus(node: string): Promise<NodeStatus> {
    return this.get<NodeStatus>(`/nodes/${encodeURIComponent(node)}/status`);
  }

  nodeSubscription(node: string): Promise<SubscriptionInfo> {
    return this.get<SubscriptionInfo>(`/nodes/${encodeURIComponent(node)}/subscription`);
  }

  nodeRepositories(node: string): Promise<RepositoryInfo> {
    return this.get<RepositoryInfo>(`/nodes/${encodeURIComponent(node)}/apt/repositories`);
  }

  /** Pending package updates. Classification into security/kernel is phase 6. */
  nodeUpdates(node: string): Promise<PendingUpdate[]> {
    return this.get<PendingUpdate[]>(`/nodes/${encodeURIComponent(node)}/apt/update`);
  }

  nodeStorage(node: string): Promise<NodeStorage[]> {
    return this.get<NodeStorage[]>(`/nodes/${encodeURIComponent(node)}/storage`);
  }

  nodeNetwork(node: string): Promise<NodeInterface[]> {
    return this.get<NodeInterface[]>(`/nodes/${encodeURIComponent(node)}/network`);
  }

  // --- Ceph ----------------------------------------------------------------

  cephStatus(): Promise<CephStatus> {
    return this.get<CephStatus>('/cluster/ceph/status');
  }

  cephMetadata(): Promise<CephMetadata> {
    return this.get<CephMetadata>('/cluster/ceph/metadata');
  }

  cephFlags(): Promise<CephFlag[]> {
    return this.get<CephFlag[]>('/cluster/ceph/flags');
  }

  // --- Storage content (Phase 5A) -------------------------------------------

  /** One storage as a node sees it: whether it is active, and how full. */
  storageStatus(node: string, storage: string): Promise<StorageStatus> {
    return this.get<StorageStatus>(
      `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/status`,
    );
  }

  storageContent(
    node: string,
    storage: string,
    content?: 'iso' | 'import',
  ): Promise<StorageContentEntry[]> {
    const query = content ? `?content=${content}` : '';
    return this.get<StorageContentEntry[]>(
      `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content${query}`,
    );
  }

  /** A volume's attributes, including its path on the node — which SSH needs. */
  volumeAttributes(node: string, storage: string, volid: string): Promise<VolumeAttributes> {
    return this.get<VolumeAttributes>(
      `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content/${encodeURIComponent(volid)}`,
    );
  }

  /**
   * Delete a volume. Proxmox answers with a task id, or with null when it
   * finished within its own short wait; both mean "asked", and the caller
   * confirms by listing the storage again rather than trusting either.
   */
  deleteVolume(node: string, storage: string, volid: string): Promise<string | null> {
    return this.del<string | null>(
      `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content/${encodeURIComponent(volid)}`,
    );
  }

  /**
   * Put a file on a storage.
   *
   * Streams: an ISO is gigabytes, and nothing here holds more than a chunk of
   * it. Not retried — the stream is consumed by the first attempt, and a
   * half-received upload is discarded by `pveproxy`, so the caller decides
   * whether to try again from the start.
   *
   * With `sha256`, Proxmox checks what it received against it and refuses the
   * file on a mismatch. That is the byte-identity guarantee for a push, made on
   * the node rather than assumed by Velnox.
   *
   * Returns the id of the task that moves the received file into place. The
   * file is not on the storage until that task has finished.
   */
  async uploadToStorage(
    node: string,
    storage: string,
    input: {
      content: 'iso' | 'import';
      filename: string;
      size: number;
      open: () => Readable;
      sha256?: string;
      signal?: AbortSignal;
      onProgress?: (bytesSent: number) => void;
    },
  ): Promise<string> {
    const fields: Record<string, string> = { content: input.content };
    if (input.sha256) {
      fields['checksum-algorithm'] = 'sha256';
      fields.checksum = input.sha256;
    }

    const envelope = multipartEnvelope({
      fields,
      fileField: 'filename',
      filename: input.filename,
      fileSize: input.size,
    });

    const headers = await this.authHeaders('POST');
    const path = `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/upload`;

    const response = await rawRequest(
      {
        host: this.options.host,
        port: this.port,
        tls: this.options.tls,
        // Idle time on the socket, not the whole transfer. Long enough for
        // pveproxy to finish writing its temporary file after the last byte.
        timeoutMs: UPLOAD_IDLE_TIMEOUT_MS,
        agent: this.agent,
      },
      {
        method: 'POST',
        path: `${API}${path}`,
        headers: {
          ...headers,
          'content-type': `multipart/form-data; boundary=${envelope.boundary}`,
          'content-length': String(envelope.length),
        },
        body: {
          stream: multipartStream(envelope, input.open(), input.onProgress),
          length: envelope.length,
        },
        signal: input.signal,
      },
    );

    this.lastCertificate = response.certificate;

    if (response.status === 401 || response.status === 403) {
      throw new ProxmoxAuthError(this.options.host, describeError(response.body, response.status));
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ProxmoxHttpError(response.status, response.statusText, response.body, path);
    }

    const upid = parseData<string>(response.body, path);
    if (typeof upid !== 'string' || !upid.startsWith('UPID:')) {
      throw new Error(`Proxmox accepted the upload to ${path} but returned no task id`);
    }
    return upid;
  }

  // --- Virtual machines (Phase 5B) ------------------------------------------

  /** The next free VMID in the cluster. A suggestion: creating with it can still race. */
  async nextVmid(): Promise<number> {
    const value = await this.get<string | number>('/cluster/nextid');
    const vmid = Number(value);
    if (!Number.isInteger(vmid) || vmid < 100)
      throw new Error(`Proxmox suggested VMID ${String(value)}`);
    return vmid;
  }

  /**
   * Create a VM. Returns the task id; the VM exists once the task has finished.
   * Not retried: a create that reached Proxmox and lost its answer must not be
   * sent twice, and the VMID makes a second one fail rather than duplicate.
   */
  createVm(node: string, params: Record<string, string | number | boolean>): Promise<string> {
    return this.postOnce<string>(`/nodes/${encodeURIComponent(node)}/qemu`, params);
  }

  vmConfig(node: string, vmid: number): Promise<Record<string, string | number>> {
    return this.get<Record<string, string | number>>(
      `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/config`,
    );
  }

  /** Change a VM's configuration. Returns a task id, or null when it applied at once. */
  setVmConfig(
    node: string,
    vmid: number,
    params: Record<string, string | number | boolean>,
  ): Promise<string | null> {
    return this.postOnce<string | null>(
      `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/config`,
      params,
    );
  }

  /** Grow a disk to an absolute size, such as `64G`. Proxmox never shrinks one. */
  resizeDisk(node: string, vmid: number, disk: string, size: string): Promise<string | null> {
    return this.put<string | null>(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/resize`, {
      disk,
      size,
    });
  }

  vmStatus(node: string, vmid: number): Promise<VmStatus> {
    return this.get<VmStatus>(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/current`);
  }

  startVm(node: string, vmid: number): Promise<string> {
    return this.postOnce<string>(
      `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/start`,
      {},
    );
  }

  /** Power off, as pulling the plug does. For a VM being thrown away, not shut down. */
  stopVm(node: string, vmid: number): Promise<string> {
    return this.postOnce<string>(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/stop`, {});
  }

  /**
   * Destroy a VM and every disk that belongs to it, including ones no longer
   * referenced in its configuration, and remove it from backup jobs and HA.
   */
  destroyVm(node: string, vmid: number): Promise<string> {
    return this.del<string>(
      `/nodes/${encodeURIComponent(node)}/qemu/${vmid}?purge=1&destroy-unreferenced-disks=1`,
    );
  }

  /**
   * Press a key on the VM's keyboard, as QEMU's monitor does. Used for exactly
   * one thing: Windows' UEFI boot loader waits for a key before it boots the
   * installer, and nobody is at the console.
   */
  sendKey(node: string, vmid: number, key: string): Promise<null> {
    return this.put<null>(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/sendkey`, { key });
  }

  /** Whether the guest agent answers. Throws when it does not, which is the common case at first. */
  agentPing(node: string, vmid: number): Promise<unknown> {
    return this.postOnce<unknown>(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/ping`, {});
  }

  /** Read a small file inside the guest through its agent. */
  agentFileRead(node: string, vmid: number, file: string): Promise<AgentFileContent> {
    return this.get<AgentFileContent>(
      `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/file-read?file=${encodeURIComponent(file)}`,
    );
  }

  /** The guest's own view of its network: interfaces and their addresses. */
  async agentNetworkInterfaces(node: string, vmid: number): Promise<AgentInterface[]> {
    const result = await this.get<{ result?: AgentInterface[] }>(
      `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/network-get-interfaces`,
    );
    return result.result ?? [];
  }

  // --- Tasks ---------------------------------------------------------------

  taskStatus(node: string, upid: string): Promise<TaskStatus> {
    return this.get<TaskStatus>(
      `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`,
    );
  }

  taskLog(node: string, upid: string, start = 0): Promise<TaskLogLine[]> {
    return this.get<TaskLogLine[]>(
      `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/log?start=${start}`,
    );
  }

  /** Stop a running task. Used when a job that started it is cancelled. */
  stopTask(node: string, upid: string): Promise<null> {
    return this.del<null>(`/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}`);
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  async get<T>(path: string): Promise<T> {
    const result = await this.call<T>('GET', path);
    return result.data;
  }

  async post<T>(path: string, form: Record<string, string | number | boolean>): Promise<T> {
    const result = await this.call<T>('POST', path, form);
    return result.data;
  }

  async del<T>(path: string): Promise<T> {
    const result = await this.call<T>('DELETE', path);
    return result.data;
  }

  async put<T>(path: string, form: Record<string, string | number | boolean>): Promise<T> {
    const result = await this.call<T>('PUT', path, form, { retry: false });
    return result.data;
  }

  /**
   * A POST sent exactly once. For requests that change something and are not
   * safe to repeat when the first answer was lost — creating, starting,
   * reconfiguring a VM.
   */
  async postOnce<T>(path: string, form: Record<string, string | number | boolean>): Promise<T> {
    const result = await this.call<T>('POST', path, form, { retry: false });
    return result.data;
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    form?: Record<string, string | number | boolean>,
    options: { retry?: boolean } = {},
  ): Promise<ProxmoxResult<T>> {
    return withRetries(
      async () => {
        const headers = await this.authHeaders(method);
        const body = form ? encodeForm(form) : undefined;

        const response = await rawRequest(
          {
            host: this.options.host,
            port: this.port,
            tls: this.options.tls,
            timeoutMs: this.options.timeoutMs,
            agent: this.agent,
          },
          {
            method,
            path: `${API}${path}`,
            headers: {
              ...headers,
              ...(body === undefined
                ? {}
                : {
                    'content-type': 'application/x-www-form-urlencoded',
                    'content-length': String(Buffer.byteLength(body)),
                  }),
            },
            ...(body === undefined ? {} : { body }),
          },
        );

        this.lastCertificate = response.certificate;

        if (response.status === 401 || response.status === 403) {
          /*
           * A ticket that expired mid-run looks exactly like a wrong password.
           * Dropping it here means the next attempt fetches a new one, and the
           * retry policy turns a two-hour boundary into an invisible hiccup
           * rather than a failed discovery run.
           */
          if (this.options.auth.kind === 'ticket' && this.ticket) {
            this.ticket = null;
            throw new ProxmoxHttpError(503, 'Ticket expired', response.body, path);
          }

          throw new ProxmoxAuthError(
            this.options.host,
            describeError(response.body, response.status),
          );
        }

        if (response.status < 200 || response.status >= 300) {
          throw new ProxmoxHttpError(response.status, response.statusText, response.body, path);
        }

        return { data: parseData<T>(response.body, path), certificate: response.certificate };
      },
      options.retry === false ? NO_RETRY : (this.options.retry ?? DEFAULT_RETRY),
      this.options.onRetry,
    );
  }

  private async authHeaders(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  ): Promise<Record<string, string>> {
    if (this.options.auth.kind === 'token') {
      return {
        authorization: `PVEAPIToken=${this.options.auth.tokenId}=${this.options.auth.secret}`,
      };
    }

    const ticket = await this.ensureTicket();

    return {
      cookie: `PVEAuthCookie=${ticket.value}`,
      // Only mutating requests need it, and sending it on a GET is harmless —
      // but the asymmetry is worth showing, because forgetting it on a POST
      // produces a 401 that looks like an authentication failure.
      ...(method === 'GET' ? {} : { CSRFPreventionToken: ticket.csrfToken }),
    };
  }

  private async ensureTicket(): Promise<Ticket> {
    if (this.ticket && Date.now() - this.ticket.obtainedAt < TICKET_LIFETIME_MS) {
      return this.ticket;
    }

    if (this.options.auth.kind !== 'ticket') throw new Error('No ticket credentials configured');

    const body = encodeForm({
      username: `${this.options.auth.username}@${this.options.auth.realm}`,
      password: this.options.auth.password,
    });

    const response = await rawRequest(
      {
        host: this.options.host,
        port: this.port,
        tls: this.options.tls,
        timeoutMs: this.options.timeoutMs,
        agent: this.agent,
      },
      {
        method: 'POST',
        path: `${API}/access/ticket`,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': String(Buffer.byteLength(body)),
        },
        body,
      },
    );

    this.lastCertificate = response.certificate;

    if (response.status !== 200) {
      throw new ProxmoxAuthError(this.options.host, describeError(response.body, response.status));
    }

    const data = parseData<{ ticket?: string; CSRFPreventionToken?: string }>(
      response.body,
      '/access/ticket',
    );

    if (!data.ticket || !data.CSRFPreventionToken) {
      throw new ProxmoxAuthError(this.options.host, 'the ticket response was missing its ticket');
    }

    this.ticket = {
      value: data.ticket,
      csrfToken: data.CSRFPreventionToken,
      obtainedAt: Date.now(),
    };

    return this.ticket;
  }
}

// ---------------------------------------------------------------------------
// Response handling
// ---------------------------------------------------------------------------

const encodeForm = (form: Record<string, string | number | boolean>): string =>
  Object.entries(form)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');

/**
 * Proxmox wraps everything in `{ data: … }`, and answers some endpoints with
 * `data: null` and no error at all — a node that has never had a subscription,
 * for one. Null is a legitimate answer and is passed through.
 */
export function parseData<T>(body: string, path: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      `Proxmox answered ${path} with something that is not JSON. ` +
        `First 120 characters: ${body.slice(0, 120)}`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || !('data' in parsed)) {
    throw new Error(`Proxmox answered ${path} without a data envelope.`);
  }

  return (parsed as { data: T }).data;
}

/**
 * Turn an error body into one line, without echoing a secret back.
 *
 * Proxmox includes the failing parameters in `errors`, and on
 * `/access/ticket` that set includes `password`. Only the *names* are taken.
 */
function describeError(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { message?: string; errors?: Record<string, unknown> };
    if (parsed.errors && typeof parsed.errors === 'object') {
      return `HTTP ${status}, rejected: ${Object.keys(parsed.errors).sort().join(', ')}`;
    }
    if (typeof parsed.message === 'string') return `HTTP ${status}: ${parsed.message}`;
  } catch {
    // Not JSON. Fall through to the status alone rather than echoing the body,
    // which on an authentication failure is the least useful thing to log.
  }
  return `HTTP ${status}`;
}

// ---------------------------------------------------------------------------
// Response shapes
//
// Deliberately partial. These describe the fields Velnox reads, not everything
// Proxmox returns: a complete type would be a second, worse copy of their API
// documentation that goes stale on every point release. Everything is optional
// where a point release could plausibly stop sending it.
// ---------------------------------------------------------------------------

export interface VersionInfo {
  version: string;
  release?: string;
  repoid?: string;
  console?: string;
}

export interface ClusterStatusEntry {
  type: 'cluster' | 'node';
  id: string;
  name: string;
  /** Cluster rows only. */
  nodes?: number;
  quorate?: number;
  version?: number;
  /** Node rows only. */
  online?: number;
  local?: number;
  nodeid?: number;
  ip?: string;
  level?: string;
}

export interface ClusterResource {
  id: string;
  type: 'node' | 'qemu' | 'lxc' | 'storage' | 'sdn' | 'pool';
  node?: string;
  status?: string;
  name?: string;
  vmid?: number;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  template?: number;
  tags?: string;
  pool?: string;
  storage?: string;
  plugintype?: string;
  shared?: number;
  content?: string;
}

export interface NodeListEntry {
  node: string;
  status: 'online' | 'offline' | 'unknown';
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  level?: string;
  ssl_fingerprint?: string;
}

export interface NodeStatus {
  uptime?: number;
  pveversion?: string;
  kversion?: string;
  cpuinfo?: { cpus?: number; sockets?: number; model?: string; mhz?: string };
  memory?: { total?: number; used?: number; free?: number };
  rootfs?: { total?: number; used?: number; avail?: number };
  loadavg?: string[];
  ksm?: { shared?: number };
  'current-kernel'?: { sysname?: string; release?: string; version?: string; machine?: string };
  'boot-info'?: { mode?: string; secureboot?: number };
}

export interface SubscriptionInfo {
  status?: 'new' | 'notfound' | 'active' | 'invalid' | 'expired' | 'suspended';
  level?: string;
  productname?: string;
  serverid?: string;
  nextduedate?: string;
  message?: string;
}

export interface RepositoryFile {
  path: string;
  'file-type'?: string;
  repositories?: {
    Enabled?: number;
    Types?: string[];
    URIs?: string[];
    Suites?: string[];
    Components?: string[];
    Comment?: string;
  }[];
}

export interface RepositoryInfo {
  files?: RepositoryFile[];
  errors?: { path?: string; error?: string }[];
  infos?: { path?: string; index?: string; property?: string; kind?: string; message?: string }[];
  digest?: string;
  'standard-repos'?: { handle?: string; name?: string; status?: number }[];
}

export interface PendingUpdate {
  Package: string;
  Version?: string;
  OldVersion?: string;
  Priority?: string;
  Section?: string;
  Origin?: string;
  Title?: string;
  Description?: string;
  NotifyStatus?: string;
}

export interface NodeStorage {
  storage: string;
  type: string;
  active?: number;
  enabled?: number;
  shared?: number;
  content?: string;
  total?: number;
  used?: number;
  avail?: number;
  used_fraction?: number;
}

export interface NodeInterface {
  iface: string;
  type: string;
  active?: number;
  autostart?: number;
  method?: string;
  address?: string;
  netmask?: string;
  cidr?: string;
  gateway?: string;
  bridge_ports?: string;
  bridge_vlan_aware?: number;
  bond_mode?: string;
  slaves?: string;
  comments?: string;
}

export interface CephStatus {
  health?: {
    status?: string;
    checks?: Record<string, { severity?: string; summary?: { message?: string } }>;
  };
  monmap?: { mons?: { name?: string }[] };
  quorum?: number[];
  quorum_names?: string[];
  osdmap?: {
    osdmap?: { num_osds?: number; num_up_osds?: number; num_in_osds?: number; flags?: string };
    num_osds?: number;
    num_up_osds?: number;
    num_in_osds?: number;
  };
  pgmap?: {
    num_pgs?: number;
    pgs_by_state?: { state_name?: string; count?: number }[];
    bytes_used?: number;
    bytes_total?: number;
  };
  fsid?: string;
}

export interface CephMetadata {
  mon?: Record<
    string,
    { name?: string; ceph_version?: string; ceph_version_short?: string; hostname?: string }
  >;
  mgr?: Record<
    string,
    { name?: string; ceph_version?: string; ceph_version_short?: string; hostname?: string }
  >;
  osd?: Record<
    string,
    { id?: number; ceph_version?: string; ceph_version_short?: string; hostname?: string }
  >;
  mds?: Record<
    string,
    { name?: string; ceph_version?: string; ceph_version_short?: string; hostname?: string }
  >;
  version?: Record<string, unknown>;
  node?: Record<string, { version?: { str?: string }; buildcommit?: string }>;
}

export interface CephFlag {
  name: string;
  value?: number;
  description?: string;
}

export interface VmStatus {
  vmid: number;
  status: 'running' | 'stopped' | string;
  name?: string;
  qmpstatus?: string;
  /** 1 when the VM is configured with a guest agent. */
  agent?: number;
  uptime?: number;
}

export interface AgentFileContent {
  content: string;
  truncated?: boolean | number;
}

export interface AgentInterface {
  name: string;
  'hardware-address'?: string;
  'ip-addresses'?: { 'ip-address': string; 'ip-address-type': 'ipv4' | 'ipv6'; prefix: number }[];
}

export interface TaskStatus {
  upid: string;
  node: string;
  pid?: number;
  type?: string;
  user?: string;
  status: 'running' | 'stopped';
  exitstatus?: string;
  starttime?: number;
  id?: string;
}

export interface StorageStatus {
  type?: string;
  active?: number;
  enabled?: number;
  shared?: number;
  content?: string;
  total?: number;
  used?: number;
  avail?: number;
}

export interface StorageContentEntry {
  volid: string;
  content?: string;
  format?: string;
  size?: number;
  ctime?: number;
  notes?: string;
}

export interface VolumeAttributes {
  path?: string;
  size?: number;
  format?: string;
  used?: number;
}

export interface TaskLogLine {
  n: number;
  t: string;
}
