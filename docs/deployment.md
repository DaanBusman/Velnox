# Velnox — Deployment Guide

Velnox runs as a set of Docker containers on a Debian or Ubuntu host. Size the machine, configure it
for a database workload, then run the installer — it does the rest: Docker, secrets, images,
migrations and health checks.

---

## System requirements

**Where to put it:** not on a hypervisor node that Velnox itself manages. The moment it puts that node
into maintenance or reboots it, it shuts itself down mid-job. Use a management cluster or a separate
host.

| | vCPU | RAM | Disk |
|---|---|---|---|
| Evaluation | 2 | 4 GB | 40 GB |
| Up to ~10 clusters / ~50 nodes | 4 | 8 GB | 80 GB |
| Up to ~50 clusters / ~300 nodes | 8 | 16 GB | 200 GB |

Debian 12 or 13, or Ubuntu 22.04 or 24.04 LTS. 64-bit x86 only. A minimal server install, with
nothing else listening on ports 80 and 443.

Disk is dominated by the container images (~2.3 GB) and, if you build on the host, the Docker build
cache, which grows to well over 10 GB. `docker builder prune -f` reclaims it. After that, disk grows
with audit records, job logs and inventory history.

### Ports

Inbound: **443** and **80** from operator workstations, plus **22** for host administration.

Outbound, to the infrastructure Velnox manages: **8006** and **22** to Proxmox nodes, **443** to
vCenter/ESXi, **5985/5986** to Hyper-V hosts, **443** to Microsoft if you use Entra ID SSO, and
**123/udp** for time.

PostgreSQL and Redis are not reachable from the host or the network; they run on an internal Docker
network with no published ports.

---

## Virtual machine settings

Velnox is a database-backed application. Four things matter on every hypervisor: **paravirtualised
devices, a fixed memory allocation, no automatic snapshots of the running VM, and a correct clock.**
Memory ballooning and a PostgreSQL buffer cache actively work against each other, and a snapshot of
a running database is a crash-consistent image, not a backup.

### Proxmox VE

| Setting | Value |
|---|---|
| Machine / BIOS | `q35` with `OVMF (UEFI)` and an EFI disk |
| CPU type | `host` — or a shared model such as `x86-64-v3` if the VM must live-migrate |
| Memory | Fixed; **uncheck "Ballooning Device"** |
| SCSI controller | `VirtIO SCSI single` |
| Disk | Bus `SCSI`, `Discard=on`, `IO thread=on`, cache `Default (no cache)`, SSD emulation on if backed by flash |
| Network | `VirtIO (paravirtualized)` |
| Guest agent | Enabled — and install it in the guest |
| Start at boot | Yes |

```bash
sudo apt-get install -y qemu-guest-agent
```

Installing it is all you do in the guest. Do **not** run `systemctl enable qemu-guest-agent`: the
unit is started by udev the moment the virtio serial port appears, and enabling it prints a wall of
text about the unit having no installation config — which is systemd correctly telling you the
command was pointless, not an error you need to fix.

What actually matters is the **Guest agent** checkbox in the VM options above. Adding it is a
hardware change, so a running VM needs a full stop and start — a reboot from inside the guest is not
enough. Check it landed:

```bash
systemctl is-active qemu-guest-agent && ls /dev/virtio-ports/
```

`active` and a listing containing `org.qemu.guest_agent.0` mean it is working. If the service is
inactive and that path does not exist, the VM has not been power-cycled since the checkbox was
ticked.

Back up with Proxmox Backup Server in snapshot mode with the guest agent enabled, so `fsfreeze` runs
first.

### VMware ESXi / vSphere

| Setting | Value |
|---|---|
| Compatibility | Hardware version 19 or later |
| Guest OS | `Debian GNU/Linux 12 (64-bit)` or `Ubuntu Linux (64-bit)` |
| Firmware | `EFI` (Secure Boot may stay on) |
| SCSI controller | **VMware Paravirtual (PVSCSI)** |
| Network adapter | **VMXNET3** — never E1000/E1000E |
| Disk | Thick provisioned, eager zeroed |
| Memory | **Reserve all guest memory** |
| CPU/memory hot-add | **Disabled** — memory hot-add disables vNUMA |

```bash
sudo apt-get install -y open-vm-tools
```

Use quiesced snapshots if you take any, and delete them promptly — a lingering snapshot degrades
write performance every day it exists.

### Microsoft Hyper-V

| Setting | Value |
|---|---|
| Generation | **2** |
| Secure Boot | On, template **"Microsoft UEFI Certificate Authority"** |
| Dynamic Memory | **Disabled** — fixed allocation |
| Network adapter | The standard synthetic adapter, not "Legacy" |
| VHDX | Fixed size, on SSD/NVMe |
| Automatic Stop Action | **Shut down**, not "Save state" |
| Automatic Checkpoints | **Disabled** |

The default Windows Secure Boot template will not boot Linux, and Dynamic Memory is the setting that
causes the most trouble: PostgreSQL deliberately fills memory with its buffer cache, Hyper-V reads
that as pressure, and under host pressure the database's working set ends up in swap.

```powershell
Set-VMFirmware -VMName "velnox" -SecureBootTemplate "MicrosoftUEFICertificateAuthority"
Set-VM -VMName "velnox" -AutomaticCheckpointsEnabled $false -AutomaticStopAction ShutDown
```

Take time from the host's PTP device rather than letting NTP fight Hyper-V time synchronisation:

```bash
sudo apt-get install -y chrony && echo 'refclock PHC /dev/ptp_hyperv poll 3 dpoll -2 offset 0' | sudo tee /etc/chrony/conf.d/hyperv.conf && sudo systemctl restart chrony
```

---

## Install

On a fresh Debian 12/13 or Ubuntu 22.04/24.04 server, as a user with `sudo`:

```bash
sudo apt-get update && sudo apt-get install -y git && sudo git clone https://github.com/DaanBusman/Velnox.git /opt/velnox && sudo bash /opt/velnox/install.sh
```

The installer asks two questions — the address operators will use, and whether you want a
self-signed certificate or a publicly trusted one — then shows its progress and prints the URL when
it is done. Expect five to ten minutes, most of it building images.

Fully unattended:

```bash
sudo bash /opt/velnox/install.sh --non-interactive --site-address=velnox.example.internal
```

| Option | Meaning |
|---|---|
| `--non-interactive`, `-y` | Never prompt; use defaults and flags |
| `--site-address=HOST` | Hostname or IP operators will use. Defaults to this host's IP |
| `--tls=internal\|EMAIL` | `internal` for a self-signed certificate (default), or an email address to obtain one from Let's Encrypt |
| `--http-port=PORT` | Host port for HTTP (default 80) |
| `--https-port=PORT` | Host port for HTTPS (default 443) |
| `--skip-docker` | Docker is already installed and configured |
| `--skip-verify` | Skip the post-install verification |

Re-running the installer is safe. It never overwrites an existing `.env` and never touches your
data, so it doubles as the upgrade path after `git pull`.

> ### Back up `MASTER_ENCRYPTION_KEY`
>
> The installer prints it when it finishes. Every credential Velnox stores is encrypted under a key
> derived from it, and there is no recovery path if it is lost — by design. Put it in your password
> manager before you do anything else.

---

## Operating it

All commands run from `/opt/velnox`.

Status and logs:

```bash
sudo docker compose -f deploy/compose/docker-compose.yml --env-file .env ps
```

```bash
sudo docker compose -f deploy/compose/docker-compose.yml --env-file .env logs -f api
```

Re-verify a running installation at any time:

```bash
bash scripts/verify-stack.sh https://velnox.example.internal
```

Stop (data is preserved in named volumes):

```bash
sudo docker compose -f deploy/compose/docker-compose.yml --env-file .env down
```

---

## Upgrading

Three steps, in this order. Step 1 is the one that is tempting to skip, and it is the one that makes
the other two reversible.

### Step 1 — Back up the database. First.

```bash
cd /opt/velnox && sudo sh -c 'docker compose -f deploy/compose/docker-compose.yml --env-file .env exec -T postgres pg_dump -U velnox -d velnox --format=custom > "/var/backups/velnox-$(date +%F).dump"'
```

The `sudo sh -c` wrapper is not decoration, and neither half of it is optional. Redirecting directly — `sudo command > /var/backups/file` — fails, because your shell opens the file before sudo runs, as you. Splitting it into two sudos joined by a pipe fails differently: both halves start at once, neither has a cached credential, and both ask for a password on the same terminal. One sudo around the whole thing asks once and does the redirection as root.

This takes seconds, and it is the only way back. **Migrations only run forwards.** If the new version
adds one and you then want the previous version again, the older code cannot run against the newer
schema — a `git checkout` alone will not undo it. Without this dump you are committed to going
forwards.

### Step 2 — See what you are about to get

```bash
cd /opt/velnox && sudo git fetch && sudo git log --oneline HEAD..origin/main
```

Skippable, but it costs a second and tells you whether you are picking up one small fix or a month of
changes.

### Step 3 — Upgrade

```bash
cd /opt/velnox && sudo git pull && sudo bash install.sh --non-interactive
```

That is the whole procedure. The installer rebuilds the images, applies any new migrations, restarts
the services and verifies the result — the same steps as a first install, which is why there is no
separate upgrade script to keep in step.

If `git pull` refuses because of local edits, you changed something inside `/opt/velnox`. Either keep
the change with `git stash`, or discard it with `git checkout -- <file>`. Configuration belongs in
`.env`, which git ignores, so a conflict here usually means an edit that wants to become a proper
change in the repository.

**What the upgrade keeps.** Your `.env` is never regenerated, so secrets survive. The site address,
TLS mode and ports are read from your existing configuration rather than re-derived, so an unattended
upgrade cannot silently move a hostname back to an IP address or replace a publicly trusted
certificate with a self-signed one. Named volumes are untouched, so the database and queue survive.

**What it refreshes.** The build commit, which the source link under Settings → About reports. That is
build metadata rather than configuration, so it always follows the code that is actually running.

### What to expect

Five to ten minutes, most of it rebuilding images. Services restart at the end, so there is a short
interruption — roughly a minute — while containers are recreated. The installer only returns once
every health check passes, so if the command completes, the upgrade worked.

Reclaim the build cache afterwards, or it grows without limit:

```bash
docker builder prune -f
```

### If an upgrade goes wrong

The installer stops at the failing step and prints the last lines of its log, with the full log at
`/var/log/velnox-install-*.log`. Nothing is left half-applied at the compose level: migrations run in
a one-shot container that must succeed before the API starts.

To go back to the previous version:

```bash
cd /opt/velnox && sudo git log --oneline -5
```

```bash
cd /opt/velnox && sudo git checkout <previous-commit> && sudo bash install.sh --non-interactive
```

That is enough **only if the upgrade added no migration**. If it did, restore your step 1 dump first,
then check out the older commit:

```bash
cd /opt/velnox && sudo sh -c 'docker compose -f deploy/compose/docker-compose.yml --env-file .env exec -T postgres pg_restore -U velnox -d velnox --clean --if-exists < /var/backups/velnox-2026-09-01.dump'
```

### Keeping several machines in step

The commit shown under Settings → About is the exact source of the running build, so comparing that
across installations tells you which are behind. To upgrade a fleet, run the same three steps on each
host; the installer is idempotent, so running it on a machine that is already current is harmless and
takes about a minute.

---

### Backup

Two things, and one of them is not in the database:

```bash
sudo sh -c 'docker compose -f deploy/compose/docker-compose.yml --env-file .env exec -T postgres pg_dump -U velnox -d velnox --format=custom > "/var/backups/velnox-$(date +%F).dump"'
```

…and `/opt/velnox/.env`, which holds `MASTER_ENCRYPTION_KEY`. A database backup without it is
ciphertext you can never read.

Restore by putting `.env` back, starting the stack so migrations create the schema, then:

```bash
sudo sh -c 'docker compose -f deploy/compose/docker-compose.yml --env-file .env exec -T postgres pg_restore -U velnox -d velnox --clean --if-exists < /var/backups/velnox-2026-09-01.dump'
```

Test the restore before you rely on it.

---

## If something goes wrong

The installer writes a full log to `/var/log/velnox-install-*.log` and prints the last lines of it on
failure.

| Symptom | Cause |
|---|---|
| Port 80 or 443 already in use | Another web server is installed. Remove it, or pass `--http-port` / `--https-port` |
| `apt-get update` finds no `Release` file for Docker | Docker has not published packages for your release codename yet. Replace the codename in `/etc/apt/sources.list.d/docker.list` with the previous stable one |
| Browser warns about the certificate | Expected with a self-signed certificate. Accept it, distribute Caddy's root CA from `sudo docker compose ... exec caddy cat /data/caddy/pki/authorities/local/root.crt`, or re-run with `--tls=you@example.com` and a public hostname |
| `readyz` reports the worker as degraded | It reports degraded above 45 seconds without a heartbeat. Check `sudo docker compose ... logs worker` |
| Disk filling up | Almost always the Docker build cache. `docker builder prune -f` |

---

## Security

The API and the UI are served on one origin behind Caddy, with HSTS, CSP and the usual hardening
headers. PostgreSQL and Redis are unreachable from outside. Only the worker container has a network
route to the infrastructure Velnox manages.

**This build has no authentication yet** — every page and endpoint is open. Deploy it on a management
network behind a firewall, not anywhere untrusted people can reach it.

---

*Velnox™ is a trademark of The Velnox Foundation. Velnox is free software under the AGPLv3.*
