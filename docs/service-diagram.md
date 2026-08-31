# Velnox — Service Diagram

**Status:** Phase 0 design proposal.

---

## Container topology

```mermaid
graph TB
  subgraph edge["edge network (published)"]
    CADDY["caddy<br/>:80 → :443<br/>TLS, security headers"]
  end

  subgraph app["app network (internal)"]
    WEB["web<br/>Next.js :3000<br/>SSR + BFF proxy"]
    API["api<br/>NestJS :4000<br/>REST + SSE"]
    WORKER["worker<br/>NestJS + BullMQ<br/>no listening port"]
    MIGRATE["migrate<br/>one-shot<br/>prisma migrate deploy"]
  end

  subgraph data["data network (internal, no published ports)"]
    PG[("postgres:16<br/>:5432<br/>vol velnox_pgdata")]
    REDIS[("redis:7<br/>:6379<br/>vol velnox_redisdata")]
  end

  subgraph ext["managed infrastructure"]
    PVE["Proxmox VE nodes<br/>HTTPS :8006 / SSH :22"]
    VMW["vCenter / ESXi<br/>HTTPS :443"]
    HV["Hyper-V hosts<br/>WinRM :5985/:5986"]
    ENTRA["Microsoft Entra ID<br/>OIDC"]
  end

  CADDY -->|"/"| WEB
  CADDY -->|"/api/v1/*"| API
  WEB -->|"server-side proxy"| API
  API --> PG
  API --> REDIS
  WORKER --> PG
  WORKER --> REDIS
  MIGRATE --> PG
  REDIS -.->|"pub/sub job events"| API
  WORKER --> PVE
  WORKER --> VMW
  WORKER --> HV
  API -->|"OIDC code + PKCE"| ENTRA
```

**Egress rule:** only `worker` opens connections to managed infrastructure. `api` reaches exactly
one external endpoint — the OIDC provider — and only during a login flow.

---

## Startup and dependency ordering

```mermaid
sequenceDiagram
  participant C as compose
  participant PG as postgres
  participant R as redis
  participant M as migrate
  participant A as api
  participant W as worker
  participant WEB as web
  participant CY as caddy

  C->>PG: start
  C->>R: start
  PG-->>C: healthcheck pg_isready OK
  R-->>C: healthcheck redis-cli ping OK
  C->>M: start (depends_on postgres healthy)
  M->>PG: prisma migrate deploy
  M-->>C: exit 0
  C->>A: start (depends_on migrate completed_successfully)
  A-->>C: /healthz OK, /readyz OK
  C->>W: start (depends_on api healthy)
  W->>R: reconcile orphaned jobs vs jobs table
  C->>WEB: start (depends_on api healthy)
  C->>CY: start (depends_on web + api healthy)
```

`migrate` uses `condition: service_completed_successfully`. Migrations never run inside `api` boot:
with more than one api replica that is a race, and a failed migration must stop the deployment
rather than crash-loop a serving container.

---

## Health checks

| Service | Check | Interval / timeout / retries / start period |
|---|---|---|
| postgres | `pg_isready -U velnox -d velnox` | 10s / 5s / 5 / 20s |
| redis | `redis-cli -a $REDIS_PASSWORD ping` | 10s / 5s / 5 / 10s |
| api | `GET /healthz` (process alive), readiness via `GET /readyz` (DB + Redis + migration version) | 15s / 5s / 5 / 40s |
| worker | queue heartbeat key in Redis refreshed every 10s; check asserts freshness | 20s / 5s / 5 / 40s |
| web | `GET /api/health` (Next route handler) | 15s / 5s / 5 / 30s |
| caddy | `caddy validate` at build; runtime `GET /healthz` proxied | 30s / 5s / 3 / 10s |

All services use `restart: unless-stopped`.

---

## Job execution flow

```mermaid
sequenceDiagram
  actor U as Operator
  participant WEB as web (BFF)
  participant A as api
  participant PG as postgres
  participant R as redis
  participant W as worker
  participant N as Proxmox node

  U->>WEB: Start rolling update (cluster X)
  WEB->>A: POST /api/v1/updates/jobs  (cookie + CSRF)
  A->>A: RBAC guard: updates.execute @ CLUSTER:X
  A->>PG: INSERT job (QUEUED) + audit event
  A->>R: BullMQ add(job)
  A-->>WEB: 202 { jobId }
  WEB-->>U: navigate to job detail
  U->>A: GET /api/v1/jobs/:id/stream (SSE)
  W->>R: consume job
  W->>PG: state QUEUED → PREFLIGHT
  W->>N: guards (quorum, ceph health, capacity)
  alt guard BLOCK
    W->>PG: state → FAILED (+ reason)
  else policy requires approval
    W->>PG: state → WAITING_APPROVAL + Approval row
    U->>A: POST /api/v1/jobs/:id/approve
    A->>R: publish resume
  end
  loop per node, concurrency ≤ budget
    W->>N: migrate workloads, maintenance, apt upgrade, reboot
    W->>PG: JobStep + JobEvent
    W->>R: publish event
    R-->>A: pub/sub
    A-->>U: SSE event
    W->>N: post-checks (services, membership, storage, workloads)
  end
  W->>PG: state → SUCCEEDED | PARTIALLY_SUCCEEDED | FAILED
  W->>PG: audit event + report
```

---

## Trust boundaries

```
┌─ untrusted ──────────────────────────────────────────────┐
│ Browser                                                  │
└───────────────┬──────────────────────────────────────────┘
                │ TLS, HttpOnly cookie, CSRF token
┌─ boundary 1: authentication + RBAC ──────────────────────┐
│ caddy → web → api                                        │
│ validates: session, permissions, scope, input schema     │
│ CANNOT: decrypt secrets, reach a managed node            │
└───────────────┬──────────────────────────────────────────┘
                │ job record + queue message (no secrets in payload)
┌─ boundary 2: automation + secret use ────────────────────┐
│ worker                                                   │
│ CAN: decrypt credentials, SSH, Proxmox API, WinRM        │
│ CANNOT: be reached from the network (no listening port)  │
└───────────────┬──────────────────────────────────────────┘
                │ pinned TLS fingerprint / pinned SSH host key
┌─ boundary 3: customer infrastructure ────────────────────┐
│ Proxmox nodes, vCenter/ESXi, Hyper-V hosts               │
└──────────────────────────────────────────────────────────┘
```

Queue payloads carry **credential references, never credential material**. The worker resolves a
reference through the `SecretStore` at the moment of use and holds the plaintext only in memory for
the duration of the connection.

---

*Velnox™ is a trademark of The Velnox Foundation.*
