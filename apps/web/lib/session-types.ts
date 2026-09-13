/**
 * Shapes shared by the server-side session reader and the client components
 * that display it.
 *
 * Separate from `session.ts` because that module is `server-only`: a Client
 * Component importing from it is a build error, and relying on `import type`
 * being erased before the bundler notices is the kind of thing that works until
 * a compiler setting changes.
 */

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  tenantId: string;
  isMspRoot: boolean;
  permissions: string[];
  mfa: {
    enrolled: boolean;
    required: boolean;
    policy: 'OPTIONAL' | 'REQUIRED_FOR_PRIVILEGED' | 'REQUIRED';
  };
}

export interface Session {
  user: SessionUser;
  /** False while the user still owes a second factor. */
  mfaSatisfied: boolean;
}

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  kind: 'MSP_ROOT' | 'CUSTOMER';
  status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  mfaPolicy: 'OPTIONAL' | 'REQUIRED_FOR_PRIVILEGED' | 'REQUIRED';
  userCount: number;
  siteCount: number;
  createdAt: string;
}

export interface SiteSummary {
  id: string;
  tenantId: string;
  tenantName: string;
  name: string;
  slug: string;
  description: string | null;
  locality: string | null;
  country: string | null;
  timezone: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  /** Grants scoped to this site. A site carrying grants cannot be removed. */
  grantCount: number;
  createdAt: string;
}

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  status: string;
  tenantId: string;
  tenantName: string;
  /** True for an account in the MSP organisation, false for a customer's. */
  tenantIsMspRoot: boolean;
  mfaEnrolled: boolean;
  privileged: boolean;
  /** The account setup created. Its roles cannot be revoked by anyone. */
  isFoundingAdministrator: boolean;
  roles: {
    assignmentId: string;
    roleId: string;
    name: string;
    scopeType: string;
    scopeId: string | null;
    /** The tenant or site the scope names. Null for a grant at global scope. */
    scopeLabel: string | null;
  }[];
  lastLoginAt: string | null;
  createdAt: string;
}

export interface IdentityProviderView {
  configured: boolean;
  enabled: boolean;
  name: string;
  discoveryUrl: string | null;
  issuer: string | null;
  clientId: string | null;
  /** Whether a secret is stored. Never the secret itself. */
  clientSecretSet: boolean;
  allowedEmailDomains: string[];
  autoProvision: boolean;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  /** Whether signing in through this provider works in this build. */
  signInAvailable: boolean;
  /** What to register as the redirect URI in the directory. Derived server-side. */
  redirectUri: string;
  /** A name for the app registration that identifies this installation. */
  suggestedAppName: string;
}

export interface RoleSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  mspOnly: boolean;
  permissions: string[];
  /** Stored against the role but not recognised by this build. */
  unknownPermissions: string[];
  assignmentCount: number;
}

export interface AuditEventView {
  id: string;
  at: string;
  action: string;
  result: 'SUCCESS' | 'FAILURE' | 'DENIED';
  actorType: string;
  actorLabel: string | null;
  resourceType: string | null;
  resourceLabel: string | null;
  ip: string | null;
  requestId: string | null;
  metadata: unknown;
}

// ---------------------------------------------------------------------------
// Proxmox inventory
//
// Byte counts arrive as strings. JSON has no integer type beyond 2^53, and a
// figure that silently loses precision in five years is the kind of bug nobody
// finds — so they are parsed where they are formatted, not before.
// ---------------------------------------------------------------------------

export type HealthState = 'OK' | 'WARNING' | 'CRITICAL' | 'UNKNOWN';
export type NodeState = 'ONLINE' | 'OFFLINE' | 'UNKNOWN';
export type ConnectionState = 'PENDING' | 'CONNECTED' | 'FAILED';

export interface CertificateReport {
  fingerprint: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  trustedByCa: boolean;
  /** Whether the host answered like a Proxmox API rather than a web server. */
  respondedAsProxmox: boolean;
}

export interface ClusterSummary {
  id: string;
  tenantId: string;
  tenantName: string;
  siteId: string | null;
  siteName: string | null;
  name: string;
  kind: 'CLUSTER' | 'STANDALONE';
  endpointHost: string;
  endpointPort: number;
  tlsFingerprint: string | null;
  authKind: 'API_TOKEN' | 'TICKET';
  authPrincipal: string | null;
  connectionState: ConnectionState;
  health: HealthState;
  pveVersion: string | null;
  pveVersions: string[];
  quorate: boolean | null;
  nodeCount: number;
  workloadCount: number;
  cephPresent: boolean;
  cephHealth: string | null;
  cephFlags: string[];
  cephVersionsHomogeneous: boolean | null;
  lastSeenAt: string | null;
  lastDiscoveryAt: string | null;
  lastErrorCode: string | null;
  lastErrorDetail: string | null;
  discoveryIntervalMinutes: number;
  createdAt: string;
}

export interface NodeSummary {
  id: string;
  clusterId: string;
  clusterName: string;
  tenantId: string;
  name: string;
  nodeId: number | null;
  address: string | null;
  state: NodeState;
  health: HealthState;
  pveVersion: string | null;
  kernelVersion: string | null;
  subscriptionStatus: string | null;
  subscriptionLevel: string | null;
  cpuCount: number | null;
  cpuModel: string | null;
  cpuUsage: number | null;
  memoryTotalBytes: string | null;
  memoryUsedBytes: string | null;
  rootfsTotalBytes: string | null;
  rootfsUsedBytes: string | null;
  uptimeSeconds: number | null;
  updatesAvailable: number | null;
  problems: string[];
  lastSeenAt: string | null;
}

export interface RepositoryRow {
  file: string;
  enabled: boolean;
  uris: string[];
  suites: string[];
  components: string[];
  comment: string | null;
}

export interface StorageRow {
  id?: string;
  name: string;
  type: string;
  enabled: boolean;
  active: boolean;
  shared: boolean;
  content: string[];
  totalBytes: string | null;
  usedBytes: string | null;
  availableBytes: string | null;
  nodeId?: string;
  nodeName?: string;
  clusterId?: string;
  clusterName?: string;
}

export interface InterfaceRow {
  id?: string;
  name: string;
  type: string;
  active: boolean;
  autostart: boolean;
  method: string | null;
  cidr: string | null;
  gateway: string | null;
  bridgePorts: string[];
  bondMode: string | null;
  slaves: string[];
  comment: string | null;
  nodeId?: string;
  nodeName?: string;
  clusterId?: string;
  clusterName?: string;
}

export interface WorkloadSummary {
  id: string;
  vmid: number;
  kind: 'QEMU' | 'LXC';
  name: string | null;
  state: 'RUNNING' | 'STOPPED' | 'PAUSED' | 'UNKNOWN';
  /** Proxmox's own word, kept beside the state so an unknown one is visible. */
  rawStatus: string | null;
  template: boolean;
  tags: string[];
  pool: string | null;
  clusterId: string;
  clusterName: string;
  nodeId: string | null;
  nodeName: string | null;
  cpuCount: number | null;
  cpuUsage: number | null;
  memoryBytes: string | null;
  memoryMaxBytes: string | null;
  diskBytes: string | null;
  diskMaxBytes: string | null;
  uptimeSeconds: number | null;
  lastSeenAt: string | null;
}

export interface CephDaemonSummary {
  id: string;
  kind: string;
  daemonId: string;
  host: string | null;
  version: string | null;
  nodeId: string | null;
  lastSeenAt: string | null;
}

export interface NodeDetail extends NodeSummary {
  repositories: RepositoryRow[];
  storages: StorageRow[];
  interfaces: InterfaceRow[];
  workloads: WorkloadSummary[];
  cephDaemons: CephDaemonSummary[];
}

export interface DiscoveryRunRow {
  id: string;
  state: 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  nodesSeen: number | null;
  workloadsSeen: number | null;
  problems: string[];
  errorCode: string | null;
  errorDetail: string | null;
}

export interface AlertRow {
  code: string;
  severity: 'CRITICAL' | 'WARNING';
  clusterId: string;
  clusterName: string;
  tenantId: string;
  tenantName: string;
  subject: string | null;
  params: Record<string, string | number>;
  since: string | null;
}
