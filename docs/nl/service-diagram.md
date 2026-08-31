# Velnox — Servicediagram

> **Vertaling.** Bron: [docs/service-diagram.md](../service-diagram.md) @ `d74c8b1`.
> **Engels is leidend.** Bij verschil tussen deze tekst en de Engelse versie geldt de Engelse tekst.

**Status:** Phase 0 ontwerpvoorstel.

---

## Containertopologie

```mermaid
graph TB
  subgraph edge["edge-netwerk (gepubliceerd)"]
    CADDY["caddy<br/>:80 → :443<br/>TLS, security headers"]
  end

  subgraph app["app-netwerk (intern)"]
    WEB["web<br/>Next.js :3000<br/>SSR + BFF-proxy"]
    API["api<br/>NestJS :4000<br/>REST + SSE"]
    WORKER["worker<br/>NestJS + BullMQ<br/>geen luisterpoort"]
    MIGRATE["migrate<br/>eenmalig<br/>prisma migrate deploy"]
  end

  subgraph data["data-netwerk (intern, geen gepubliceerde poorten)"]
    PG[("postgres:16<br/>:5432<br/>volume velnox_pgdata")]
    REDIS[("redis:7<br/>:6379<br/>volume velnox_redisdata")]
  end

  subgraph ext["beheerde infrastructuur"]
    PVE["Proxmox VE-nodes<br/>HTTPS :8006 / SSH :22"]
    VMW["vCenter / ESXi<br/>HTTPS :443"]
    HV["Hyper-V-hosts<br/>WinRM :5985/:5986"]
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
  REDIS -.->|"pub/sub jobgebeurtenissen"| API
  WORKER --> PVE
  WORKER --> VMW
  WORKER --> HV
  API -->|"OIDC code + PKCE"| ENTRA
```

**Uitgaandeverkeersregel:** alleen `worker` opent verbindingen naar beheerde infrastructuur. `api`
bereikt precies één extern endpoint — de OIDC-provider — en uitsluitend tijdens een inlogstroom.

---

## Opstart- en afhankelijkheidsvolgorde

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

  C->>PG: starten
  C->>R: starten
  PG-->>C: healthcheck pg_isready OK
  R-->>C: healthcheck redis-cli ping OK
  C->>M: starten (depends_on postgres healthy)
  M->>PG: prisma migrate deploy
  M-->>C: exit 0
  C->>A: starten (depends_on migrate completed_successfully)
  A-->>C: /healthz OK, /readyz OK
  C->>W: starten (depends_on api healthy)
  W->>R: weesjobs verzoenen met de jobs-tabel
  C->>WEB: starten (depends_on api healthy)
  C->>CY: starten (depends_on web + api healthy)
```

`migrate` gebruikt `condition: service_completed_successfully`. Migraties draaien nooit tijdens het
opstarten van `api`: met meer dan één api-replica is dat een race, en een mislukte migratie moet de
uitrol stoppen in plaats van een bedienende container in een crashlus te brengen.

---

## Health checks

| Service | Controle | Interval / timeout / pogingen / startperiode |
|---|---|---|
| postgres | `pg_isready -U velnox -d velnox` | 10s / 5s / 5 / 20s |
| redis | `redis-cli -a $REDIS_PASSWORD ping` | 10s / 5s / 5 / 10s |
| api | `GET /healthz` (proces leeft), gereedheid via `GET /readyz` (DB + Redis + migratieversie) | 15s / 5s / 5 / 40s |
| worker | hartslag-sleutel in Redis, elke 10s ververst; de controle toetst de versheid | 20s / 5s / 5 / 40s |
| web | `GET /api/health` (Next route handler) | 15s / 5s / 5 / 30s |
| caddy | `caddy validate` bij build; tijdens draaien `GET /healthz` via de proxy | 30s / 5s / 3 / 10s |

Alle services gebruiken `restart: unless-stopped`.

---

## Joburitvoering

```mermaid
sequenceDiagram
  actor U as Operator
  participant WEB as web (BFF)
  participant A as api
  participant PG as postgres
  participant R as redis
  participant W as worker
  participant N as Proxmox-node

  U->>WEB: Rolling update starten (cluster X)
  WEB->>A: POST /api/v1/updates/jobs  (cookie + CSRF)
  A->>A: RBAC-guard: updates.execute @ CLUSTER:X
  A->>PG: INSERT job (QUEUED) + auditgebeurtenis
  A->>R: BullMQ add(job)
  A-->>WEB: 202 { jobId }
  WEB-->>U: naar de jobdetailpagina
  U->>A: GET /api/v1/jobs/:id/stream (SSE)
  W->>R: job oppakken
  W->>PG: status QUEUED → PREFLIGHT
  W->>N: guards (quorum, ceph-gezondheid, capaciteit)
  alt guard BLOCK
    W->>PG: status → FAILED (+ reden)
  else beleid vereist goedkeuring
    W->>PG: status → WAITING_APPROVAL + Approval-rij
    U->>A: POST /api/v1/jobs/:id/approve
    A->>R: hervatten publiceren
  end
  loop per node, gelijktijdigheid ≤ limiet
    W->>N: workloads migreren, onderhoud, apt upgrade, herstart
    W->>PG: JobStep + JobEvent
    W->>R: gebeurtenis publiceren
    R-->>A: pub/sub
    A-->>U: SSE-gebeurtenis
    W->>N: nacontroles (services, clusterlidmaatschap, opslag, workloads)
  end
  W->>PG: status → SUCCEEDED | PARTIALLY_SUCCEEDED | FAILED
  W->>PG: auditgebeurtenis + rapport
```

---

## Trust boundaries

```
┌─ niet vertrouwd ─────────────────────────────────────────┐
│ Browser                                                  │
└───────────────┬──────────────────────────────────────────┘
                │ TLS, HttpOnly-cookie, CSRF-token
┌─ grens 1: authenticatie + RBAC ──────────────────────────┐
│ caddy → web → api                                        │
│ valideert: sessie, rechten, bereik, invoerschema         │
│ KAN NIET: secrets ontsleutelen, een beheerde node bereiken│
└───────────────┬──────────────────────────────────────────┘
                │ jobrecord + wachtrijbericht (geen secrets in de payload)
┌─ grens 2: automatisering + secretgebruik ────────────────┐
│ worker                                                   │
│ KAN: credentials ontsleutelen, SSH, Proxmox-API, WinRM   │
│ KAN NIET: vanaf het netwerk bereikt worden (geen poort)  │
└───────────────┬──────────────────────────────────────────┘
                │ vastgelegde TLS-vingerafdruk / vastgelegde SSH-hostsleutel
┌─ grens 3: klantinfrastructuur ───────────────────────────┐
│ Proxmox-nodes, vCenter/ESXi, Hyper-V-hosts               │
└──────────────────────────────────────────────────────────┘
```

Wachtrij-payloads bevatten **verwijzingen naar credentials, nooit credentialmateriaal**. De worker
herleidt een verwijzing via de `SecretStore` op het moment van gebruik en houdt de platte tekst alleen
in het geheugen zolang de verbinding duurt.

---

*Velnox™ is een handelsmerk van The Velnox Foundation.*
