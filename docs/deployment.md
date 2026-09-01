# Velnox — Deployment Guide

How to run Velnox on a Debian or Ubuntu host with Docker, how to size it, and how to configure the
virtual machine it runs in on Proxmox VE, VMware ESXi/vSphere or Microsoft Hyper-V.

---

## Before you start: what this build is

> **Phase 1 has no authentication.** Every endpoint is open and every page is public. Authentication
> and RBAC arrive in Phase 2. Deploy this on a management network you fully control, behind a
> firewall — not on anything internet-facing, and not anywhere untrusted people can reach it.

There is also no installer yet. `install.sh` and the tar.gz/ISO artifacts are Phase 14; today you
deploy by generating a configuration file and running Docker Compose. That is what this guide
describes, and it works.

---

## 1. System requirements

### Host operating system

| Supported | Version |
|---|---|
| Debian | 12 (bookworm), 13 (trixie) |
| Ubuntu Server | 22.04 LTS, 24.04 LTS |

64-bit x86 (`amd64`) only. ARM64 is not tested and the Prisma engine and base images are not
verified on it. A minimal server install is enough — no desktop, no web server, nothing else on
ports 80 and 443.

### Sizing

The idle figures below are **measured** on a running Phase 1 stack. The recommendations are
**engineering estimates from the design**, because the subsystems that consume real resources —
inventory, jobs, audit — arrive in Phases 4 through 8. They are stated as estimates deliberately;
revisit them once there is a real fleet behind them.

Measured, Phase 1, idle, empty database:

| Container | Memory |
|---|---|
| api | 47 MB |
| web | 42 MB |
| worker | 29 MB |
| postgres | 24 MB |
| caddy | 16 MB |
| redis | 6 MB |
| **Total** | **≈ 165 MB** |

That is a floor, not a guide. PostgreSQL grows with its buffer cache and connections, the Node
processes grow with request and job load, and the worker holds an SSH or HTTPS session per node it
is working on.

| Scale | vCPU | RAM | Disk | Notes |
|---|---|---|---|---|
| **Evaluation / Phase 1** | 2 | 4 GB | 40 GB | Enough to build from source on the host |
| **Small MSP** — up to ~10 clusters, ~50 nodes | 4 | 8 GB | 80 GB | Estimate |
| **Medium MSP** — up to ~50 clusters, ~300 nodes | 8 | 16 GB | 200 GB | Estimate; consider a separate PostgreSQL host |

**Disk, measured:** the six images total **2.25 GB**. Building them on the host additionally
produces a build cache that reached **13 GB** during development — reclaim it with
`docker builder prune`. If you deploy prebuilt images you need roughly 5 GB; if you build on the
host, plan for 40 GB so a build never fills the disk.

Disk then grows with audit events (immutable, retained per policy), job logs and inventory
snapshots. Nothing in Phase 1 writes meaningfully to disk.

### Network

Inbound to the Velnox host:

| Port | Protocol | From | Purpose |
|---|---|---|---|
| 443 | TCP | Operator workstations | Web UI and API |
| 80 | TCP | Operator workstations | Redirect to 443, and ACME HTTP challenge if you use public certificates |
| 22 | TCP | Your admin network | Host administration (not Velnox) |

Outbound **from the Velnox host** — only the `worker` container needs most of these, and Compose
puts it on its own egress network for exactly that reason:

| Port | Protocol | To | Needed from |
|---|---|---|---|
| 8006 | TCP | Proxmox VE nodes | Phase 4 |
| 22 | TCP | Proxmox VE nodes (SSH) | Phase 6 |
| 443 | TCP | vCenter / ESXi hosts | Phase 11 |
| 5985 / 5986 | TCP | Hyper-V hosts (WinRM) | Phase 12 |
| 443 | TCP | `login.microsoftonline.com` | Phase 2, only if you enable Entra ID SSO |
| 123 | UDP | Your NTP servers | Always |

PostgreSQL and Redis are **not** reachable from the host or the network. They sit on an internal
Docker network with no published ports, and `verify-stack.sh` checks that this stays true.

### Do not run Velnox on a node it manages

This is the one deployment mistake with real consequences. If Velnox runs as a VM on a Proxmox node
that Velnox itself manages, then the moment it puts that node into maintenance or reboots it for an
upgrade, it shuts itself down mid-job.

Run it on a management cluster, a separate standalone host, or a hypervisor outside the fleet. If
you genuinely have only one cluster, at minimum pin the Velnox VM to a node and exclude that node
from automated rolling updates — and know that you are then upgrading that node by hand.

---

## 2. The virtual machine

Velnox is a database-backed application. The settings that matter are the same on every hypervisor:
**paravirtualised devices, static memory, no automatic snapshots of the running VM, and correct
time.** Memory ballooning and a PostgreSQL buffer cache fight each other, and a snapshot of a
running database is a crash-consistent image, not a backup.

### 2.1 Proxmox VE

| Setting | Value | Why |
|---|---|---|
| Machine type | `q35` | Modern chipset, proper PCIe |
| BIOS | `OVMF (UEFI)` + EFI disk | Matches how current Debian/Ubuntu install |
| CPU type | `host` | Passes through all CPU flags — noticeably faster for TLS and Argon2id hashing |
| CPU (if the VM must live-migrate) | `x86-64-v3` or another common model | `host` blocks migration between dissimilar CPUs |
| Cores | 2 (evaluation) to 8 | 1 socket, all cores on it |
| Memory | Fixed, **ballooning off** | Uncheck "Ballooning Device"; a shrinking balloon under a database causes swap storms |
| SCSI Controller | `VirtIO SCSI single` | |
| Disk bus | `SCSI`, `Discard=on`, `IO thread=on` | Discard lets deleted space return to thin storage |
| Disk cache | `Default (no cache)` | Safe with a database; `writeback` risks the last writes on host failure |
| SSD emulation | On, if backed by SSD/NVMe | Correct rotational hint to the guest |
| Network | `VirtIO (paravirtualized)` | |
| QEMU Guest Agent | Enabled | Needed for clean shutdown and filesystem freeze |
| Start at boot | Yes, with a start delay behind your storage | |

Install the agent inside the guest, or Proxmox will wait on shutdown and never get a clean one:

```bash
sudo apt-get install -y qemu-guest-agent && sudo systemctl enable --now qemu-guest-agent
```

Back the VM up with Proxmox Backup Server using **snapshot mode with the guest agent enabled**, so
`fsfreeze` runs before the snapshot. That gives a consistent filesystem, but see §7 — it is still
not a substitute for a database dump.

### 2.2 VMware ESXi / vSphere

| Setting | Value | Why |
|---|---|---|
| VM compatibility | Hardware version 19 or later (ESXi 7.0 U2+) | |
| Guest OS | `Debian GNU/Linux 12 (64-bit)` or `Ubuntu Linux (64-bit)` | Sets sensible device defaults |
| Firmware | `EFI` | Secure Boot may stay on; Debian and Ubuntu are signed |
| SCSI controller | **VMware Paravirtual (PVSCSI)** | Materially lower CPU per I/O than LSI Logic |
| Network adapter | **VMXNET3** | Never E1000/E1000E — higher CPU, lower throughput |
| Disk provisioning | Thick provisioned, **eager zeroed** | Avoids first-write penalty on database files |
| Memory reservation | Reserve **all** guest memory | Stops ESXi ballooning or swapping the database |
| CPU/Memory hot-add | **Disabled** | Memory hot-add disables vNUMA, which hurts a multi-vCPU VM |
| CPU shares/limits | No limit | A CPU limit on a job orchestrator causes unpredictable timeouts |
| Latency sensitivity | Normal | |

Install `open-vm-tools` in the guest (Debian and Ubuntu package it; do not use the ISO-based VMware
Tools):

```bash
sudo apt-get install -y open-vm-tools
```

If you snapshot the VM, use **quiesced** snapshots so `open-vm-tools` freezes the filesystem — and
delete them promptly. A long-lived snapshot on a database VM grows a delta file that degrades write
performance every day it exists.

### 2.3 Microsoft Hyper-V

| Setting | Value | Why |
|---|---|---|
| Generation | **Generation 2** | UEFI, synthetic devices, no emulated legacy hardware |
| Secure Boot | Enabled, template **"Microsoft UEFI Certificate Authority"** | The default Windows template will not boot Linux. This is the single most common Hyper-V mistake. |
| Dynamic Memory | **Disabled** — set a fixed amount | The most important setting here; see below |
| Virtual processors | 2 to 8 | |
| Network adapter | The standard synthetic adapter | Never "Legacy Network Adapter" |
| VHDX | Fixed size, on SSD/NVMe | Dynamic VHDX expansion stalls database writes |
| Automatic Start Action | Always start automatically | |
| Automatic Stop Action | **Shut down** | Not "Save state" — resuming a saved database VM restores stale in-memory state |
| Automatic Checkpoints | **Disabled** | On by default in Hyper-V on Windows 10/11; a checkpoint of a running database is not a backup |
| Integration Services | Enable Guest Services and Heartbeat | |

**Why Dynamic Memory must be off:** Hyper-V reclaims memory from the guest through a balloon driver
based on pressure it observes. PostgreSQL deliberately fills memory with its buffer cache, so the
guest looks "full" and Hyper-V gives it more; then the host comes under pressure, reclaims, and the
database's working set is pushed into swap. The result is a system that is fast until it suddenly is
not. Give it a fixed allocation.

Set the Secure Boot template in PowerShell if the GUI dropdown is not obvious:

```powershell
Set-VMFirmware -VMName "velnox" -SecureBootTemplate "MicrosoftUEFICertificateAuthority"
```

Disable automatic checkpoints:

```powershell
Set-VM -VMName "velnox" -AutomaticCheckpointsEnabled $false -AutomaticStopAction ShutDown
```

Time on Hyper-V Linux guests is best taken from the host's PTP device rather than fighting NTP
against the Hyper-V time synchronisation service:

```bash
sudo apt-get install -y chrony
echo 'refclock PHC /dev/ptp_hyperv poll 3 dpoll -2 offset 0' | sudo tee /etc/chrony/conf.d/hyperv.conf
sudo systemctl restart chrony
```

### 2.4 Applies to all three

- **Time must be correct.** Velnox issues and validates TLS certificates, signs short-lived tokens
  and evaluates maintenance windows. A host with a drifting clock produces authentication failures
  that look like bugs. Verify with `timedatectl` — `System clock synchronized: yes`.
- **Filesystem:** `ext4` or `xfs` for `/var/lib/docker`. If you use `xfs`, it must be formatted with
  `ftype=1`, which is the default on Debian and Ubuntu but not on every older system; Docker's
  overlay2 driver refuses to start without it.
- **Swap:** keep a small swap file but set `vm.swappiness=10`. Swapping a database is worse than not
  having the memory in the first place.
- **A hypervisor snapshot is not a backup.** It captures the database mid-write. Use it to roll back
  a failed upgrade minutes later, not to restore data. §7 covers the real backup.

---

## 3. Prepare the host

Everything below runs as a normal user with `sudo`.

```bash
sudo apt-get update && sudo apt-get upgrade -y
```

```bash
sudo apt-get install -y ca-certificates curl git gnupg chrony
```

Set the hostname and timezone so logs and maintenance windows read correctly:

```bash
sudo hostnamectl set-hostname velnox
sudo timedatectl set-timezone Europe/Amsterdam
```

Confirm the clock is synchronised before going further:

```bash
timedatectl
```

### Firewall

Velnox publishes only 80 and 443. Nothing else needs to be reachable.

```bash
sudo apt-get install -y ufw && sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw --force enable
```

> **Note on ufw and Docker:** Docker writes its own iptables rules and can publish a container port
> past a ufw rule. Velnox only publishes 80 and 443, which you are allowing anyway, and PostgreSQL
> and Redis are on an internal network with no published ports at all — so this does not bite here.
> If you later add a service with a published port, restrict it in the Compose file
> (`127.0.0.1:PORT:PORT`) rather than relying on ufw.

### Unattended security updates

```bash
sudo apt-get install -y unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades
```

---

## 4. Install Docker

Use Docker's own repository. The `docker.io` package in Debian and Ubuntu lags well behind and does
not ship Compose v2.

Add the repository — this is the same on Debian and Ubuntu apart from the distribution name, which
the command derives from `/etc/os-release`:

```bash
sudo install -m 0755 -d /etc/apt/keyrings && curl -fsSL "https://download.docker.com/linux/$(. /etc/os-release && echo "$ID")/gpg" | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg && sudo chmod a+r /etc/apt/keyrings/docker.gpg
```

```bash
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$(. /etc/os-release && echo "$ID") $(. /etc/os-release && echo "${VERSION_CODENAME:-$UBUNTU_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

```bash
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

> If `apt-get update` reports that the repository has no `Release` file, Docker has not published
> packages for your release codename yet — this happens for a while after each new Debian or Ubuntu
> release. Replace the codename in `/etc/apt/sources.list.d/docker.list` with the previous stable
> one (`bookworm` for Debian 13, `noble` for a newer Ubuntu) and update again. The packages are
> compatible; only the repository index is missing.

Enable it at boot and confirm the versions:

```bash
sudo systemctl enable --now docker && docker --version && docker compose version
```

Compose must report **v2.x or later**. If `docker compose version` fails but `docker-compose`
works, you have the obsolete v1 and the Compose file here will not parse.

### Running Docker without sudo (optional)

```bash
sudo usermod -aG docker "$USER" && newgrp docker
```

> Membership of the `docker` group is equivalent to root on the host: any member can start a
> container that mounts `/`. Only add accounts you would give root to.

---

## 5. Deploy Velnox

### 5.1 Get the source

```bash
sudo mkdir -p /opt/velnox && sudo chown "$USER" /opt/velnox && git clone <your-velnox-repository-url> /opt/velnox
```

From Phase 14 there will be a signed tar.gz that carries the images with it, so this step becomes an
unpack and works with no registry access at all.

### 5.2 Generate the configuration

```bash
cd /opt/velnox && ./scripts/gen-env.sh
```

This writes `.env` with mode 0600 and strong random values for `POSTGRES_PASSWORD`,
`REDIS_PASSWORD`, `JWT_SECRET` and `MASTER_ENCRYPTION_KEY`. Running it again never overwrites an
existing `.env` — losing the master key is unrecoverable, so the script refuses rather than risk it.

> ### Back up `MASTER_ENCRYPTION_KEY` now
>
> Every credential Velnox stores is encrypted under a key derived from it. If you lose it, every
> stored Proxmox and hypervisor credential becomes permanently unreadable. There is no recovery
> path, by design. Copy it into your password manager **before** you continue.

### 5.3 Set the address

Edit `.env` and set the address operators will use:

```ini
VELNOX_SITE_ADDRESS=velnox.example.internal
APP_URL=https://velnox.example.internal
VELNOX_TLS=internal
```

`VELNOX_TLS=internal` makes Caddy issue its own certificate. Browsers warn once; that is expected
and correct for an appliance on a management network. To use publicly trusted certificates instead,
set `VELNOX_TLS` to an email address — that requires `VELNOX_SITE_ADDRESS` to be a publicly
resolvable name reachable from the internet on ports 80 and 443.

While you are in the file, decide on the Phase 1 diagnostic endpoint:

```ini
VELNOX_DEV_ENDPOINTS=false
```

Set it to `true` only if you want the queue self-test on the dashboard. It is unauthenticated, like
everything else in this build.

### 5.4 Start it

```bash
cd /opt/velnox && docker compose -f deploy/compose/docker-compose.yml --env-file .env up --build --detach --wait
```

The first run builds both images and takes several minutes. `--wait` makes the command return only
once every health check passes, so if it returns successfully, the stack is genuinely up.

### 5.5 Verify

```bash
./scripts/verify-stack.sh https://velnox.example.internal
```

This asserts the acceptance criteria against the running system: every dependency reachable, the
schema migration applied, security headers present, both languages served, the licence offer
published, a real job completing through the queue, and the data tier not exposed to the host. It
should end with `27 checks passed.`

Then open `https://velnox.example.internal` in a browser.

### 5.6 Start on boot

Compose services use `restart: unless-stopped`, so Docker restarts them after a host reboot —
provided the Docker service itself starts, which §4 enabled. Confirm after your first reboot:

```bash
sudo reboot
```

```bash
cd /opt/velnox && docker compose -f deploy/compose/docker-compose.yml --env-file .env ps
```

---

## 6. Day-to-day operation

Run all of these from `/opt/velnox`. The `-f`/`--env-file` pair is required every time; the
repository's `package.json` wraps them as `pnpm docker:up` and `pnpm docker:logs` if you have Node
installed on the host.

Status:

```bash
docker compose -f deploy/compose/docker-compose.yml --env-file .env ps
```

Follow logs from one service:

```bash
docker compose -f deploy/compose/docker-compose.yml --env-file .env logs -f api
```

Restart one service:

```bash
docker compose -f deploy/compose/docker-compose.yml --env-file .env restart worker
```

Stop everything (data is kept — it lives in named volumes):

```bash
docker compose -f deploy/compose/docker-compose.yml --env-file .env down
```

### Updating to a new version

```bash
cd /opt/velnox && git pull && docker compose -f deploy/compose/docker-compose.yml --env-file .env up --build --detach --wait
```

Migrations run in a one-shot container that must exit successfully before the API starts, so a
failed migration stops the deployment instead of leaving a serving container against a schema it
does not understand. Re-running is safe and preserves `.env` and all data.

Reclaim build cache afterwards — it grows quickly:

```bash
docker builder prune -f
```

---

## 7. Backup and restore

Three things must be backed up, and one of them is not in the database.

**1. The database:**

```bash
cd /opt/velnox && docker compose -f deploy/compose/docker-compose.yml --env-file .env exec -T postgres pg_dump -U velnox -d velnox --format=custom > "velnox-$(date +%F).dump"
```

**2. The `.env` file** — it contains `MASTER_ENCRYPTION_KEY`. A database backup without it is a
backup of ciphertext you can never decrypt.

**3. Your `docker-compose.yml` and any local edits**, which `git` already tracks.

Restore into a fresh installation by putting `.env` back first, starting the stack so migrations
create the schema, then:

```bash
cd /opt/velnox && docker compose -f deploy/compose/docker-compose.yml --env-file .env exec -T postgres pg_restore -U velnox -d velnox --clean --if-exists < velnox-2026-09-01.dump
```

**Test the restore before you rely on it.** A backup you have never restored is a hypothesis.

---

## 8. Troubleshooting

**`docker compose version` says v1 or is not found**
You have the distribution's obsolete package. Remove `docker-compose` and install
`docker-compose-plugin` from Docker's repository (§4).

**Port 80 or 443 already in use**
Something else is listening — usually Apache or nginx from a default install. Either remove it, or
set `CADDY_HTTP_PORT` and `CADDY_HTTPS_PORT` in `.env` to free ports and put your own proxy in
front.

**`migrate` exits 1 and the API never starts**
Read its log: `docker compose ... logs migrate`. The two usual causes are PostgreSQL not being
healthy yet (Compose waits, so this is rare) and a `DATABASE_URL` in `.env` whose password no longer
matches `POSTGRES_PASSWORD` — easy to cause by editing one and not the other.

**The browser warns about the certificate**
Expected with `VELNOX_TLS=internal`. Either accept it, distribute Caddy's root CA from
`docker compose ... exec caddy cat /data/caddy/pki/authorities/local/root.crt` to your operators, or
switch to ACME with a public hostname.

**`readyz` reports the worker as degraded**
The worker refreshes a heartbeat in Redis every 10 seconds and is reported degraded — not down —
above 45 seconds, because the API can still serve while the worker restarts. If it stays degraded,
check `docker compose ... logs worker`.

**The stack is healthy but the disk is filling**
Almost always the build cache. `docker system df` will show it; `docker builder prune -f` reclaims
it.

---

## 9. What changes in Phase 14

The installer replaces most of §3 to §5 with:

```bash
sudo ./install.sh
```

It checks the OS, installs Docker when it is missing, generates the configuration and secrets, runs
migrations, starts the stack, verifies health and prints the address. It is idempotent — re-running
preserves an existing `.env` and data — and it has a `--non-interactive` mode. The tar.gz artifact
will carry the images so the whole thing works with no registry access.

Until then, this guide is the supported path.

---

*Velnox™ is a trademark of The Velnox Foundation. Velnox is free software under the AGPLv3.*
