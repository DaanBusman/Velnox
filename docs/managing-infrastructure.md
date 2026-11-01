# Adding clusters and reading the inventory

**Everything about putting Proxmox under management and knowing what is out there.** Each section is
one task, written to be read while doing it.

For tenants and sites, see [Organising your fleet](organising-your-fleet.md). For accounts and roles,
see [Managing users and access](managing-access.md).

---

## Cluster and node: the two words

- A **node** is one physical server running Proxmox VE.
- A **cluster** is one Proxmox VE installation as Velnox connects to it, through one API address:
  several nodes joined into a Proxmox cluster, or a single standalone node — a cluster of one.

Every node belongs to exactly one cluster. You add a **cluster** to Velnox — never a node on its own
— and its nodes come with it, because the cluster reports them. Two standalone servers added
separately are two clusters, each with one node; join them in Proxmox and they become one cluster
there, and Velnox offers to [merge the two registrations](#merging-two-registrations-of-one-cluster).

---

## What Velnox reads, and what it does not touch

In this phase Velnox is **read-only against your infrastructure**. It connects, asks Proxmox what is
there, and writes it down. It does not start, stop, migrate, update or reconfigure anything — those
arrive in later phases, each with its own approval and its own guards.

What it reads, per cluster:

- the cluster itself: name, version, quorum, and whether the nodes agree about their version;
- each node: state, Proxmox and kernel version, CPU, memory, root disk, uptime, subscription, how
  many package updates are pending, and its apt sources;
- each node's storage and network interfaces;
- every virtual machine and container, with its ID, name, state, size and tags;
- Ceph, if there is any: health, monitor quorum, OSD counts, placement-group state, every daemon's
  version, and which flags are set.

---

## Before you start: make an API token

You can sign in with a username and password, and you should not. A token is scoped, can be revoked
from the Proxmox side without touching anybody's password, survives a password change, and does not
expire on a two-hour timer. A password gives Velnox everything that account can do.

On any node of the cluster:

1. **Datacenter → Permissions → API Tokens → Add.**
2. User `root@pam` (or a dedicated user — see below). Token ID `velnox`.
3. **Leave "Privilege Separation" ticked off** for a first look, or tick it and grant the token
   only what Velnox uses. `PVEAuditor` on `/` is enough for the inventory. Copying ISOs onto storage
   and building VMs need more — see
   [Building VMs from templates](building-vms.md#what-it-needs-first) for the list.
4. Copy the secret. Proxmox shows it **once**.

The token id is the whole string Proxmox shows you, realm included: `root@pam!velnox`.

### A dedicated user is better than root

Create `velnox@pve`, give it `PVEAuditor` on `/` — and the roles in
[Building VMs from templates](building-vms.md#what-it-needs-first) if it is to write — and make the
token against that. Then a Velnox
token cannot be confused with a human's, revoking it affects nothing else, and the Proxmox task log
attributes reads to something with a name.

---

## Add a cluster

**You need:** `clusters.manage` covering the tenant you are adding it to.

Point Velnox at **any one node**. Proxmox answers for the whole cluster from any of its members, so
there is no "primary" to pick and nothing to change if that node is later rebuilt.

1. Go to **Clusters → Add cluster**.
2. Enter the host and port (8006 unless you have moved it). **Look it up.**
3. Velnox connects, reads the certificate, and shows you its fingerprint. **It sends nothing** — no
   token, no password, no cookie. At this point nobody has said this is the right machine.
4. **Check the fingerprint on the node itself.** Sign in over SSH or the console and run:

   ```bash
   pvenode cert info
   ```

   Compare the SHA-256 fingerprint. Tick the box only when it matches.
5. Name it, choose the tenant and optionally a site, paste the token id and secret, and **Add
   cluster**.

Velnox stores the credential encrypted, then proves it works against the certificate you just
confirmed. If the token is wrong, nothing is added — you get the error and an empty form, not a
half-added cluster that fails quietly every half hour afterwards.

### Why step 4 is not optional

That fingerprint is the entire security of the connection. From then on Velnox talks to **that one
certificate** and refuses anything else — and it refuses during the handshake, before a single byte
of your API token is written to the socket.

Skip it, and you have agreed to send a credential that can read every VM's configuration to whatever
answered on port 8006. A management network is not a safe network; it is a network where the
consequences are larger.

### A standalone node

Exactly the same flow. A single node has no cluster, and Velnox models it as a cluster of one — it
appears marked **Standalone**, and it is reported as having no quorum rather than as having lost it.

Everything downstream treats it identically, which is why there is no separate "add a node" screen
and why there will not be one when rolling updates arrive.

---

## Where the credential goes

The token is encrypted before it is stored and can only be decrypted by the worker — the service
with no listening port, which is the only part of Velnox that talks to your infrastructure. The
console cannot read it back: the API refuses to decrypt any infrastructure credential, and there is
no setting that changes that.

What you *can* see is which token is in use, so you know what to revoke: the cluster's
**Connection** tab shows the token id and the pinned fingerprint, never the secret.

**Where removal lives.** At the bottom of the cluster's page, below whichever tab is open, under
**Remove this cluster**. Its nodes and guests go with it. There is no way to remove a single node,
and there is not going to be one: a node is in the inventory because the cluster reports it, so the
next read would simply bring it back.

Removing a cluster removes its stored credential with it. A secret with no owner is a secret nobody
is going to rotate.

---

## SSH: what it is for, and setting it up

The Proxmox API covers the inventory, discovery, building VMs and moving guests. What it cannot do,
Velnox does over SSH to each node:

| What | Over SSH | The account needs |
|---|---|---|
| Copying an ISO or disk image off a node into the library | SFTP, reading one file | Read access to the storage directory |
| Applying updates, rolling updates | Three fixed commands — see [Updating nodes](updating-nodes.md#before-you-can-apply-updates-ssh) | root, or sudo for the dist-upgrade |
| Ceph and Proxmox VE major upgrades | Fixed commands per step — see [Major upgrades](major-upgrades.md) | root |

Velnox never opens a shell, and never runs a command typed by a person or received over the API:
every command is in a fixed list inside Velnox (ADR-046) and appears in the job's output. **root is
the simplest account**, and the only one every feature works with without further set-up.

### Setting it up

On the cluster's page, **Connection** tab, **SSH** card, **Set up SSH**:

1. **Read and confirm each node's host key.** Velnox connects to every online node and records the
   key it presents, **without logging in**. Compare each fingerprint with the node itself before
   ticking it — on the node:

   ```bash
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
   ```

2. **The account** Velnox signs in as — `root` unless you change it.
3. **The key.** Either:
   - **Make a new key pair here** — the default. Your browser makes an Ed25519 key pair, and Velnox
     shows its **public key**, one line starting `ssh-ed25519`, with **Copy**, and the command that
     adds it on a node:

     ```bash
     echo 'ssh-ed25519 AAAA… velnox' >> /root/.ssh/authorized_keys
     ```

     On a Proxmox cluster `/root/.ssh/authorized_keys` is normally a link to
     `/etc/pve/priv/authorized_keys`, one file every node shares, so for root running it once on any
     node is usually enough. Check with `ls -l /root/.ssh/authorized_keys`; if it is not a link, run
     it on every node. For another account it is that account's `~/.ssh/authorized_keys`.
   - **Use a key pair you already have.** Paste its private key, and the passphrase if it has one.
     Its public half must already be in the account's `authorized_keys`.
4. **Save and trust the confirmed nodes.** Velnox stores the private key encrypted and proves it on
   every confirmed node. If any node refuses — usually because the public key is not on it yet —
   nothing is saved and the previous set-up, if there was one, stays as it was. A key made here stays
   in the form until you close it, so add the public key where it is missing and save again.

### Where the public key is afterwards

On the same **SSH** card, as **Public key** with **Copy**, for as long as SSH is set up — for a key
made here and for one you pasted. It is the line to add to a node that joins the cluster later, or to
put back after a node is reinstalled. The **private** key is never shown again, by any screen or any
API call.

**Replace key** goes through the same steps with a new key; **Remove SSH** deletes the key and the
pinned host keys. Remove the old public line from `authorized_keys` yourself: Velnox does not edit
that file.

**A node whose host key changes is refused**, the same way a changed TLS certificate is. After
reinstalling a node, set SSH up again and confirm its new key deliberately. A node added to the
cluster later has no confirmed key and is not connected to until you do the same.

---

## Merging two registrations of one cluster

Two standalone servers added to Velnox one by one — **PVE-1** and **PVE-2** — and joined into one
Proxmox cluster afterwards (`pvecm create PVE-PROD` on one, `pvecm add` on the other) are still two
registrations in Velnox, each now reporting the same nodes. Velnox notices: at the next discovery
both report the same cluster name from Proxmox and nodes in common, and the **Clusters** page says
so, with **Merge into one**.

The merge, in a window over the page:

1. **Name in Velnox** — offered as the name Proxmox gives the cluster, `PVE-PROD`.
2. **Keep the connection of** — the registration whose API address and token stay. The other's are
   removed.
3. **Keep the SSH set-up of** — asked only when both have one.

**What comes along** from the registration that goes: its SSH set-up and host-key pins, placement
rules and settings, update policy, upgrade plans, VM builds, library sources, its job and discovery
history, and its site. Where the kept registration already has its own — an update policy, a site —
the kept one's stays, and the merge says what was not taken over. The nodes and guests are not
copied: it is the same cluster, and it is read again straight after. The other registration is then
removed, with its API token. Merging is recorded in the audit log on both.

**What it refuses.** Two registrations that are not one Proxmox cluster — merging them would make
one disappear from Velnox — and a merge while a job runs against either. **Velnox does not join
nodes in Proxmox itself:** forming the cluster is done in Proxmox, as before. You need
`clusters.manage` on both.

---

## Reading the inventory

**Clusters** is the fleet at a glance. Four columns carry it:

| Column | What to look for |
|---|---|
| Health | Grey is *unknown*, not fine. A cluster Velnox knows nothing about is never green. |
| Version | Two versions listed means the cluster is part-way through an upgrade. |
| Guests | A count. Zero on a cluster that should have some means discovery is not reading it. |
| Last read | **The one people forget.** Inventory that is a week old looks identical to inventory that is current. |

Open a cluster for its nodes, its guests, its Ceph and — on the **Discovery runs** tab — what the
last few attempts could and could not read.

**Nodes**, **Virtual Machines** and **Containers** are the same data across every cluster you can
see, for when the question is "where is the disk" rather than "how is this cluster".

**Storage** and **Networks** are shown one cluster at a time, within one tenant — the MSP
organisation included. With *all tenants* selected in the top bar they ask you to choose one first;
then choose the cluster above the table. Every column can be filtered: type in the box under a name
or an address, or pick a type, node or state from the list. *Clear filters* shows everything again.

### Figures that are missing, and figures that are zero

A dash means Velnox does not have that number. A zero means the number is zero. They are different
facts and the interface never conflates them — a storage that is configured but not mounted shows
dashes, not an empty disk.

---

## Discovery: when it runs, and what it does when things are broken

Two kinds of reading, and they are different:

- **The full inventory** — versions, repositories, updates, Ceph, interfaces, files on storage — is
  read on a schedule, every 30 minutes by default. Change it per cluster on the cluster's page, or
  set it to **Only when asked** to turn the schedule off for one customer without affecting anyone
  else.
- **Live status** — whether each node and guest is up, CPU, memory, uptime, storage use, and guests
  created or removed — is read while someone is looking. Every open screen showing a cluster's
  inventory asks for it at the viewer's own refresh interval (your name → **Settings → Refresh
  screens automatically**, two seconds by default); the most eager viewer of a cluster sets its
  pace, and about ten seconds after the last viewer leaves it stops. It is one call to Proxmox
  (`/cluster/resources`) per cluster. With refreshing switched off, a screen asks for none. The
  cluster page shows which applies under *Live status*.

  The screen itself re-reads only when what it shows has changed — a guest started or stopped, a
  node offline, a figure moved by a whole percent of CPU or by more than a few megabytes — and
  otherwise once a minute. A cluster where nothing moves costs the screens watching it nothing.

Proxmox itself recalculates those figures about every ten seconds, so between two of its updates
several reads in a row show the same numbers. There is no button that starts a full inventory on
demand; a run outside the schedule means shortening the interval for that cluster.

Three behaviours are worth knowing, because they are what makes the inventory trustworthy:

- **A node it cannot reach does not lose you the others.** The run finishes, the other nodes are
  updated, and the run is marked **Partial** with the node named. An offline node stays in the
  inventory — it is precisely when a node is down that you want to see it.
- **A failed run does not blank anything.** If Velnox cannot reach the cluster at all, the previous
  inventory stays exactly as it was and the cluster is marked as failing. What stops moving is *last
  read*, which is how you tell stale from current.
- **Rows keep their identity.** A node that is still there keeps the same entry across runs, so
  anything scoped to it stays scoped to it.

---

## Alerts

**Alerts** lists conditions Velnox can see right now: a cluster it cannot reach, a node offline, a
cluster without quorum, nodes disagreeing about their version, Ceph unhealthy, Ceph daemons on
different releases, and any Ceph flag that is set.

They are worked out from the inventory each time the page is opened. An alert therefore disappears
the moment its cause does and can never be stale — and there is no acknowledgement, no silencing and
no notification. That is deliberate and it is listed in [Known gaps](known-gaps.md): a stored alert
needs a lifecycle, and a half-built one produces a screen full of alarms nobody reads.

### `noout`, specifically

If a Ceph flag alert says `noout`, read it. With `noout` set, Ceph will not mark a failed OSD out, so
a dead disk causes no rebalance and **nothing turns red**. It is almost always left behind after
maintenance somebody was called away from. Clear it unless maintenance is running right now.

---

## When something does not work

| What you see | What it usually is |
|---|---|
| *Velnox cannot reach…* | Firewall between the Velnox host and port 8006, or DNS. The worker is the only service that connects outward. |
| *That does not look like a Proxmox API* | Right host, wrong port — or a reverse proxy in front of Proxmox answering instead. |
| *Certificate fingerprint mismatch* | The node's certificate changed. That happens legitimately when it is renewed or the node is rebuilt — and it is also exactly what an interception looks like. Check `pvenode cert info` on the node, then remove the cluster and add it again with the new fingerprint. Velnox will not quietly accept a new certificate for you. |
| *Proxmox refused the credentials* | The token was revoked, or its privilege separation excludes what Velnox reads. `PVEAuditor` on `/` is enough. |
| A run marked **Partial** | Open **Discovery runs**. Every problem is listed with the node it belongs to. |

---

## Where to go next

- [Organising your fleet](organising-your-fleet.md) — tenants, sites and scoping a grant
- [Managing users and access](managing-access.md) — accounts, roles, two-factor, Entra ID SSO
- [Known gaps](known-gaps.md) — what is deliberately missing right now
- [Architecture](architecture.md) — how the system is put together, and why
