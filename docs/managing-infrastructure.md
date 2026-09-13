# Adding clusters and reading the inventory

**Everything about putting Proxmox under management and knowing what is out there.** Each section is
one task, written to be read while doing it.

For tenants and sites, see [Organising your fleet](organising-your-fleet.md). For accounts and roles,
see [Managing users and access](managing-access.md).

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
   `PVEAuditor` on `/` if you want it read-only from the Proxmox side as well. Velnox only reads in
   this phase, so `PVEAuditor` is enough and is the better choice.
4. Copy the secret. Proxmox shows it **once**.

The token id is the whole string Proxmox shows you, realm included: `root@pam!velnox`.

### A dedicated user is better than root

Create `velnox@pve`, give it `PVEAuditor` on `/`, and make the token against that. Then a Velnox
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

Removing a cluster removes its stored credential with it. A secret with no owner is a secret nobody
is going to rotate.

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

**Nodes**, **Virtual Machines**, **Containers**, **Storage** and **Networks** are the same data
across every cluster you can see, for when the question is "where is the disk" rather than "how is
this cluster".

### Figures that are missing, and figures that are zero

A dash means Velnox does not have that number. A zero means the number is zero. They are different
facts and the interface never conflates them — a storage that is configured but not mounted shows
dashes, not an empty disk.

---

## Discovery: when it runs, and what it does when things are broken

Every cluster is read on a schedule, every 30 minutes by default. Change it per cluster on the
cluster's page, or set it to **Only when asked** to turn the schedule off for one customer without
affecting anyone else. **Read now** runs one immediately.

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
