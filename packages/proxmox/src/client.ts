import type { Agent } from 'node:https';
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
 * Everything here is read-only against the cluster in phase 4. `post` exists
 * because task polling needs it from phase 6, and it is here now so the task
 * poller can be built and tested against the real shape of a UPID.
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

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    form?: Record<string, string | number | boolean>,
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
      this.options.retry ?? DEFAULT_RETRY,
      this.options.onRetry,
    );
  }

  private async authHeaders(method: 'GET' | 'POST'): Promise<Record<string, string>> {
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
      ...(method === 'POST' ? { CSRFPreventionToken: ticket.csrfToken } : {}),
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

export interface TaskLogLine {
  n: number;
  t: string;
}
