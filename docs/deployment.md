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
| Evaluation | 2 | 3 GB | 25 GB |
| Up to ~10 clusters / ~50 nodes | 2 | 4 GB | 40 GB |
| Up to ~50 clusters / ~300 nodes | 4 | 6 GB | 80 GB |

Debian 12 or 13, or Ubuntu 22.04 or 24.04 LTS. 64-bit x86 only. A minimal server install, with
nothing else listening on ports 80 and 443.

**What these are based on** (measured on 0.7.8). Running, Velnox is small: the six services together
use about 350 MB at rest, and 390 MB at their peak with 50 clusters of three nodes each discovered
*every minute* — thirty times the default — with the worker at most a fifth of one core. What sets the
floor is building the images, which the installer does on the host at every install and upgrade: that
needs about 2 GB of memory for a few minutes, and fails below 1.75 GB. The memory above is that, the
operating system and Docker, and the stack still running beside the build during an upgrade — with
room for PostgreSQL's cache to grow with history. The fixture clusters are small and answer
instantly; real ones with hundreds of guests make each discovery heavier, which is what the margin
in the larger rows is for.

Disk: the operating system, about 3 GB of images, and under 1 GB of package cache kept between builds.
An upgrade needs about 8 GB more while it runs — the new images and their build cache — and the
installer removes both the build cache and the images it replaced once the new stack is healthy.
What grows after that is audit records, job logs and history, your database backups, and the ISO
library, which is usually the largest of all: the disk above leaves room for a few ISOs, not a
library. See [The ISO library's disk](#the-iso-librarys-disk).

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
data, which is why `sudo velnox update` uses it for upgrades.

> ### Back up `MASTER_ENCRYPTION_KEY`
>
> The installer prints it when it finishes. Every credential Velnox stores is encrypted under a key
> derived from it, and there is no recovery path if it is lost — by design. Put it in your password
> manager before you do anything else.

---

## Operating it

The installer adds one command for everything below. It works from any directory.

| Command | What it does |
|---|---|
| `sudo velnox status` | Shows what is running |
| `sudo velnox logs [service]` | Follows the logs of `api`, `worker`, `web`, `caddy`, `postgres` or `redis`, or of all of them |
| `sudo velnox check` | Verifies the running installation |
| `sudo velnox start` / `stop` | Starts or stops Velnox. Stopping keeps all data |
| `sudo velnox restart [service]` | Restarts one service, or all of them |
| `sudo velnox update` | Backs up the database, then upgrades |
| `sudo velnox update --check` | Shows what an upgrade would bring, and changes nothing |
| `sudo velnox rollback [commit]` | Lists recent versions, or goes back to one |
| `sudo velnox backup` | Backs up the database to `/var/backups` |
| `sudo velnox backup list` | Shows the backups |
| `sudo velnox backup prune` | Shows which old backups can go. Add `--delete` to remove them |
| `sudo velnox backup restore <file>` | Puts a backup back |
| `sudo velnox backup library` | Also backs up the ISO library |
| `sudo velnox cert status` | Shows the certificate being served |
| `sudo velnox cert self-signed` | Uses Caddy's own certificate |
| `sudo velnox cert letsencrypt <email>` | Uses Let's Encrypt |
| `sudo velnox cert install <cert> <key> [chain]` | Uses a certificate you already have |
| `sudo velnox disk` | Shows where the disk space went |
| `sudo velnox clean` | Removes caches. Never touches your data |
| `velnox version`, `velnox help` | The installed version, and this list |

Installed before 0.7.37? The command arrives with your next upgrade, which runs like this once:

```bash
cd /opt/velnox && sudo git pull --ff-only && sudo bash scripts/velnox.sh update
```

---

## Certificates

Velnox serves HTTPS through Caddy in one of three modes. Change it at any time, on a running
installation: in the product under **Server management → Certificate**, or on the host with
`velnox cert`. Either way nothing is served until it has been validated, so a certificate that
would not have worked is refused while the working one is still serving.

```bash
sudo velnox cert status
```

| Mode | What it is | Renewal |
|---|---|---|
| `internal` | A certificate from Caddy's own CA. Browsers warn once, and do not install Velnox as an app until the workstation trusts that CA ([how](installing-as-an-app.md#when-there-is-no-install-as-app)). The installer's default. | Automatic |
| Let's Encrypt | A publicly trusted certificate obtained over ACME. | Automatic |
| Your own | A certificate you already hold, from your CA or a commercial issuer. | **Yours** |

**Server management → Certificate** also shows the certificate the proxy is *actually* presenting —
read from a real handshake rather than from configuration, so a change that was written and never
picked up is visible instead of being reported as success.

### Change it in the interface

**Server management → Certificate → Change the certificate**, with `system.manage`:

- **As installed** — what the installer set up from `VELNOX_TLS`, and what `velnox cert` changes.
- **Self-signed** — Caddy's own certificate authority.
- **Let's Encrypt** — with an account address; renewed by Caddy. **Use another ACME authority**
  names a different directory — a private CA such as step-ca, or a staging server — with the root
  that signs its HTTPS when that is not publicly trusted.
- **My own certificate** — paste the certificate with its chain, and the unencrypted private key,
  or read either from a PEM file with the button under its field. A PFX file (`.pfx` or `.p12`)
  holds both: choose it with the certificate button and enter its password, if it has one. Velnox
  converts it on the server, uses the password once and does not store it or the file. The same
  checks as the script: the key must belong to the certificate, and it must
  not have expired; names that do not cover the address, or a missing chain, are warnings. The key
  is stored encrypted in Velnox's secret store and is never shown again.

**Apply** writes the configuration and asks Caddy, through its admin socket, to load it. Caddy
refuses a configuration it cannot serve and keeps the current certificate; otherwise the panel
reads back the certificate now served and says whether it is the one chosen. Let's Encrypt can take
a minute: *not yet served* then means exactly that. The choice survives restarts and upgrades:
it is kept in the database, and the API writes Caddy's files again at every start. Each change is
in the audit log as `system.tls_changed`, never with the key.

**When the interface cannot be reached** — after a certificate browsers refuse, say — any
`velnox cert` command that changes the certificate hands the choice back to the installer's: it
clears the choice in the database, removes the stored key, records that in the audit log, and
restarts the API and Caddy. `velnox cert status` says when a choice from the interface is being
served.

### Switch to Let's Encrypt

```bash
sudo velnox cert letsencrypt you@example.com
```

The address is the ACME account contact. This requires
`VELNOX_SITE_ADDRESS` to be a name that resolves publicly and reaches this host on ports 80 and 443.
Let's Encrypt does not issue certificates for IP addresses, and the command refuses rather than
letting Caddy fail quietly.

Issuance takes up to a minute. Caddy renews on its own from then on.

### Install a certificate you already have

```bash
sudo velnox cert install /path/to/fullchain.pem /path/to/privkey.pem
```

Both files must be PEM. An encrypted private key has to be decrypted first — Caddy cannot prompt for
a passphrase. If your issuer gave you the leaf and the chain separately, name the chain as a third
file, or concatenate them yourself; most browsers reject a leaf served without its issuers.

Before writing anything the command checks that the key belongs to the certificate, that the
certificate has not expired, and that one of its names covers `VELNOX_SITE_ADDRESS`. A name mismatch
is a warning rather than a refusal, because installing ahead of a DNS change is legitimate — but
browsers will refuse the connection until the two agree.

The certificate and key are written to `deploy/caddy/tls/`, the key mode 0600, and the directory is
mounted read-only into the Caddy container. **Renewal is yours in this mode.** Velnox warns on the
certificate screen from 30 days out, and `velnox check` fails once it has expired.

### Go back to a self-signed certificate

```bash
sudo velnox cert self-signed
```

### What changing it in the interface costs

Until Phase 5C this was a host-only task, on purpose: the API held no TLS material and could not
reconfigure the proxy. The owner chose to have it in the interface, and ADR-045 records the price.
The API container now writes a private key for Caddy and can reload Caddy through its admin API.
That API listens on a Unix socket in a volume only Caddy and the API mount — no port, on no
network — and the API still runs no shell commands and cannot restart a container. Whoever can run
code inside the API container can change the certificate; that was already enough to read the
database.

A change from the interface reloads Caddy without a restart. A change with `velnox cert`
restarts the API and Caddy, which costs a few seconds on the console. Nothing else is interrupted:
the worker holds no connection through Caddy.

---

## Upgrading

### Knowing that there is a newer version

Every six hours the worker reads one file, `release.json` on the repository's main branch: the
newest version, and the advisories — fixes an installation should not sit on. When the version is
newer than the one running, the sidebar shows **Velnox 0.7.x available** above Server management to
anyone with `system.manage`, or **Critical update: Velnox 0.7.x** in red when an advisory that
concerns this installation is critical. It opens **Server management → Updates**, which lists those advisories
and the procedure below.

- **What is sent:** the request for that file, and nothing else — no version, no instance id, no
  count of anything. GitHub sees the address it comes from, as with any download.
- **No internet:** the panel says *Could not check* and why, never *Up to date*; the sidebar shows
  nothing. A failed read waits six hours like a good one.
- **Switching it off:** *Switch the check off* in Server management → Updates (audited as
  `system.update_check_changed`). *Check now* still works while it is off.
- **Another address:** `VELNOX_UPDATE_MANIFEST_URL` in `.env` names another https address — a
  mirror inside the management network, or a fork's own file. It is read directly, not through a
  proxy.

### Upgrade

```bash
sudo velnox update
```

That is the whole procedure. It backs up the database, fetches the new version, rebuilds the images,
applies any new migrations, restarts the services and verifies the result. If the backup fails,
nothing else happens.

To see first whether you are picking up one small fix or a month of changes:

```bash
sudo velnox update --check
```

**Why the backup comes first.** Migrations only run forwards. If the new version adds one and you
then want the previous version again, the older code cannot run against the newer schema. The backup
is the only way back, so copy it, with `.env`, somewhere that is not this machine.

If the update refuses because of local edits, you changed something inside `/opt/velnox`. Either
keep the change with `git stash`, or discard it with `git checkout -- <file>`. Configuration belongs
in `.env`, which git ignores, so a conflict here usually means an edit that wants to become a proper
change in the repository.

**What the upgrade keeps.** Your `.env` is never regenerated, so secrets survive. The site address,
TLS mode and ports are read from your existing configuration rather than re-derived, so an unattended
upgrade cannot silently move a hostname back to an IP address or replace a publicly trusted
certificate with a self-signed one. Named volumes are untouched, so the database and queue survive.

**What it refreshes.** The build commit, which the source link under Settings → About reports. That is
build metadata rather than configuration, so it always follows the code that is actually running.
And the software underneath: the Node.js base image of Velnox's own images, and the PostgreSQL, Redis
and Caddy images, each fetched again at the latest release of the major it is pinned to
(`postgres:16`, `redis:7`, `caddy:2`). An upgrade is therefore also how their security fixes arrive —
running it now and then is worth it even when Velnox itself has not changed. A new major of any of
the three is never taken on its own: PostgreSQL's in particular changes the data format and needs a
dump and restore.

### What to expect

Five to ten minutes, most of it rebuilding images. Services restart at the end, so there is a short
interruption — roughly a minute — while containers are recreated. The installer only returns once
every health check passes, so if the command completes, the upgrade worked.

Afterwards the installer removes the build cache, keeping only the package downloads the next
upgrade can reuse, and the images the upgrade replaced. Neither grows from one upgrade to the next.

### If an upgrade goes wrong

The installer stops at the failing step and prints the last lines of its log, with the full log at
`/var/log/velnox-install-*.log`. Nothing is left half-applied at the compose level: migrations run in
a one-shot container that must succeed before the API starts.

To go back, list the recent versions:

```bash
sudo velnox rollback
```

Then name the one you want:

```bash
sudo velnox rollback <previous-commit>
```

If the upgrade added a migration, the command refuses, because the older code cannot run on the newer
database. Name the backup from before the upgrade as well:

```bash
sudo velnox rollback <previous-commit> --restore=/var/backups/velnox-2026-09-01.dump
```

It asks for confirmation and saves the current database first. If the restore fails, the database
stays as it was and nothing is rolled back.

### Keeping several machines in step

The commit shown under Settings → About is the exact source of the running build, so comparing that
across installations tells you which are behind. To upgrade a fleet, run `sudo velnox update` on
each host; running it on a machine that is already current is harmless and takes about a minute.

---

### The ISO library's disk

ISOs and cloud images live in their own Docker volume, `velnox_library`. A named volume has no quota,
so Velnox enforces two limits itself, set in `.env`:

| Setting | Default | Meaning |
|---|---|---|
| `VELNOX_LIBRARY_MAX_GB` | 100 | The most the library may hold, counting transfers still in progress. |
| `VELNOX_LIBRARY_MIN_FREE_GB` | 10 | Free disk that must remain after a transfer. |

Whichever is reached first refuses the transfer, and the refusal names the limit and the numbers.
The floor matters more than the ceiling: the volume is on the same disk as PostgreSQL unless you move
it, and a full disk stops the whole installation, not only the upload. On the 25 GB evaluation size
the floor is what you will hit first, which is the point of it.

Change either value, then run `sudo velnox start` so the API and worker read it. Lowering the ceiling below what the library already holds removes
nothing; it only refuses new files until enough are deleted.

To give the library a disk of its own, mount one at the volume's location before the first start, or
move the volume's contents there with the stack stopped. Velnox measures free space on whatever
filesystem the library is on.

### Backup

Two things, and one of them is not in the database:

```bash
sudo velnox backup
```

…and `/opt/velnox/.env`, which holds `MASTER_ENCRYPTION_KEY`. A database backup without it is
ciphertext you can never read.

A backup is readable by root only, and never replaces an earlier one: a second backup on the same day
gets the time in its name.

Restore by putting `.env` back, starting Velnox with `sudo velnox start` so migrations create the
schema, then:

```bash
sudo velnox backup restore /var/backups/velnox-2026-09-01.dump
```

It asks for confirmation, saves the current database first, and stops the services that use it. The
restore is one transaction, so if it fails the database stays as it was. Afterwards it applies the
migrations of the installed version and starts the services that were running.

Test the restore before you rely on it.

**The ISO library is not in that backup,** and usually does not need to be: every file in it came
from somewhere and can be fetched or uploaded again. What the library holds is recorded in the
database, so a restored database without the volume lists files that are not there; the worker
notices within fifteen minutes and marks them *Failed*, with the reason that the file has gone, and
removing them on the **ISO library** screen clears them. If re-fetching is expensive for you, back the volume up as well:

```bash
sudo velnox backup library
```

### Removing old backups

Each backup is a new file, and nothing removes them for you. This does. Run it first without
`--delete`: it lists what it would remove and touches nothing.

```bash
sudo velnox backup prune
```

When the list is what you expect, remove them:

```bash
sudo velnox backup prune --delete
```

By default it removes backups older than 30 days and always keeps the 7 newest, however old those
are. Both can be changed:

```bash
sudo velnox backup prune --older-than=90 --keep=14 --delete
```

What it will and will not do:

- **It only considers files named exactly `velnox-YYYY-MM-DD.dump` or
  `velnox-YYYY-MM-DD-HHMMSS.dump`** — the names `velnox backup` produces. Anything else in the
  directory, and any symlink, is left alone.
- **A dump's age is the date in its name, not the file's modification time.** A backup copied back
  from off-site storage gets a new modification time; going by that, it would never look old.
- **The newest backup is never removed.** `--keep` must be at least 1, and a file whose name is not a
  real date (`velnox-2026-02-31.dump`) is kept and does not count towards it.
- **It does not touch `.env` backups.** `scripts/gen-env.sh --force` writes a new `.env` with a new
  `MASTER_ENCRYPTION_KEY`, and saves the old file as `.env.<timestamp>.bak`. Every dump made before
  that needs the old key to be read, so a `.bak` file is only safe to delete once no dump you keep
  predates it. That is a judgement the command cannot make for you.

---

## Freeing disk space

Look first, then clean. Nothing in this section touches the database.

### Where the space went

```bash
sudo velnox disk
```

It shows the free space, what Docker uses, the largest container logs, the backups and the ISO
library. Since 0.5.5 each container keeps at most five log files of 10 MB — about 50 MB, or 350 MB
for the whole stack — and the oldest is dropped as a new one starts. Before 0.5.5 there was no limit
at all, and on a host that had run for months they could be gigabytes.

### Cleaning up

```bash
sudo velnox clean
```

After asking, this removes the Docker build cache, which the next upgrade downloads again; images
left behind by earlier upgrades, but never one a container uses; system logs beyond 200 MB; and the
package cache.

**Container logs from before 0.5.5.** Upgrading removes them by itself: the change that caps them
makes the next `docker compose up -d` recreate every container, and a container's logs go with it.
That first upgrade therefore restarts PostgreSQL too — a few seconds without the console, and no
data lost, because the database lives in a volume and not in the container.

If you cannot upgrade yet, empty them instead. The log history is gone, which also means it is gone
for troubleshooting, so read what you need first.

```bash
sudo sh -c 'truncate -s 0 /var/lib/docker/containers/*/*-json.log'
```

**Old database backups** — see [Removing old backups](#removing-old-backups).

**Files in the ISO library** — remove them on the **ISO library** screen, not on the host. The screen
removes the file and its record together; deleting under `/var/lib/docker/volumes/velnox_library` by
hand leaves records pointing at nothing, and a file whose record is gone is removed by the worker
anyway.

### Never

These look like the same kind of cleanup, and are not. They remove Docker volumes, and `pgdata` is
a volume: the whole database goes with it — and the ISO library with it, which is a volume too. The same is true of deleting anything under
`/var/lib/docker/volumes` by hand.

```
docker system prune --volumes
docker volume prune
```

### Outgoing mail

Velnox sends mail when a VM it built is ready. Set the server up under **Notifications → Outgoing
mail** — see [Building VMs from templates](building-vms.md#outgoing-mail). The host must be able to
reach that server on its port; the worker is what connects. The server's password is stored
encrypted in the database, so it is in the database backup and needs `.env` to be read, like every
other credential.

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
| Disk filling up | Usually the Docker build cache or container logs. See [Freeing disk space](#freeing-disk-space) |

---

## Security

The API and the UI are served on one origin behind Caddy, with HSTS, CSP and the usual hardening
headers. PostgreSQL and Redis are unreachable from outside. Only the worker container has a network
route to the infrastructure Velnox manages.

**This build has no authentication yet** — every page and endpoint is open. Deploy it on a management
network behind a firewall, not anywhere untrusted people can reach it.

---

*The Velnox name and logo are used by The Velnox Foundation. No trademark is registered or claimed; the AGPLv3 grants no rights in either. Velnox is free software under the AGPLv3.*
