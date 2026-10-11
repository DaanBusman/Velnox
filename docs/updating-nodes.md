# Updating nodes

**What each node would update, updating one, and the policies that decide when.** Velnox reads every
node's pending packages with each discovery, classifies them, notices when a node needs a reboot,
and applies updates one node at a time as a job you can follow line by line. A **rolling update** does a
whole cluster, node after node, moving each node's running guests away before it reboots and back
afterwards.

For who may do what, see [Roles and permissions](permissions.md). For why it works the way it does,
see ADR-046, ADR-047 and ADR-048 in [Technology decisions](tech-decisions.md).

---

## What Velnox reads

**Operations → Updates & upgrades**, tab **Nodes**. Every discovery reads, per online node, what apt
would install and which kernels are installed:

- **Security** — updates from Debian's security archive. Discovery reads this from what Proxmox's
  API reports, which is a weaker signal; the update job reads it again from `apt-get -s` over SSH,
  which names the archive exactly, and says so in its output.
- **Kernel** — a new kernel, which only takes effect after a reboot.
- **Proxmox** — Proxmox's own packages: `pve-*`, `proxmox-*`, `qemu-server`, Ceph, ZFS and the like.
- **Reboot due** — a newer kernel is installed than the one running, or the node itself says so
  (`/var/run/reboot-required`). The reason is shown on the node's row.

**Packages** lists them, security updates first. Nothing here needs SSH; it is the Proxmox API.

---

## Before you can apply updates: SSH

Proxmox's API can refresh the package lists and reboot a node, but cannot install packages. Applying
updates therefore needs **SSH on the cluster**, set up under the cluster's **Connection** tab as for
[copying a file into the library](managing-the-library.md#copying-a-file-from-a-cluster-into-the-library),
with each node's host key confirmed. A node without a confirmed key shows *Needs SSH*.

**What Velnox runs.** Only commands from a fixed list in Velnox itself — never one typed by a person
or received over the API. For updates, three:

| Command | Changes the node | Needs root |
|---|---|---|
| `apt-get -s -o Debug::NoLocking=1 dist-upgrade` | No | No |
| `apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade` | Yes | Yes |
| a check for `/var/run/reboot-required` | No | No |

Each is run with `LC_ALL=C`, and only after checking that the machine answering is called what the
node is called — a command meant for `pve2` refuses to run anywhere else.

**The account.** Root works. A dedicated account is better: give it the key Velnox holds, and let it
run exactly the dist-upgrade through sudo without a password, in `/etc/sudoers.d/velnox`:

```
velnox ALL=(root) NOPASSWD: /usr/bin/env LC_ALL\=C DEBIAN_FRONTEND\=noninteractive apt-get -y -o Dpkg\:\:Options\:\:\=--force-confdef -o Dpkg\:\:Options\:\:\=--force-confold dist-upgrade
```

sudoers wants `:`, `=` and `,` in a command's arguments escaped with a backslash, as above; check
the file with `visudo -cf /etc/sudoers.d/velnox`. Velnox prefixes that one command with `sudo -n`
when the account is not root, and fails rather than
waiting if sudo would ask for a password. An account limited to SFTP (`ForceCommand internal-sftp`)
keeps copying files into the library working and makes updates fail with *exit code 126*.

---

## Updating one node

**Update** on the node's row, with what to do about a reboot:

- **Reboot if required** — the default: only when a newer kernel was installed or the node asks.
- **Never reboot** — the reboot stays due, and the row says so.
- **Always reboot**.

The job, step by step:

1. **check** — the cluster has quorum, the node is online, SSH reaches it. It also says how many
   guests are running on the node.
2. **approve** — only under a policy that asks for approval: the job waits for someone with
   `updates.execute` and `jobs.approve`.
3. **window** — only under a policy with a window: the window must still be open, or nothing changes.
4. **refresh** — `apt-get update`, through Proxmox's API.
5. **simulate** — what the dist-upgrade would do, package by package, with where each comes from.
6. **upgrade** — the dist-upgrade, its output in the job as it runs. **It cannot be cancelled
   part-way**: a cancel waits for it to finish, because dpkg stopped half-way is a node someone has
   to repair by hand. And nothing it installs can be undone.
7. **reboot** — when the choice above says so, and only if the cluster keeps quorum with the node
   away. Proxmox shuts the node's guests down on a reboot; to move them first, use a
   [rolling update](#updating-a-whole-cluster-rolling-update). Velnox
   waits for the node to come back, up to twenty minutes, and reports the kernel it came back on.
8. **verify** — reads what is left. Anything still pending — held back, or new since — is said.

Only one job changes a cluster at a time: an update waits behind any other job on the same cluster.

---

## Updating a whole cluster: rolling update

Choose a cluster on the **Nodes** tab. The card **Update … node by node** shows the plan: which
nodes go down together, in order, and the running guests each one would move. It warns when the
other nodes would not have the memory for a node's guests, and says why when a run cannot start.

- **Nodes at a time** — one by default. The most a cluster allows is ⌊(n−1)/2⌋ for *n* nodes: one
  on three or four nodes, two on five or six. More is refused, because with more nodes away the
  cluster loses quorum and every guest on it stops.
- **Reboot** — as for one node.
- **A guest that cannot move live** — a guest with a disk on a node's own storage (`local`,
  `local-lvm`, a ZFS pool only that node has) or a device passed through (`hostpci`, `usb`) cannot
  move to another node while it runs. **Do not start** refuses the run and names them; **Shut it
  down for its node's reboot, start it after** does exactly that.
- **Minutes to settle** — how long a node, the cluster and Ceph may take to be whole again after a
  reboot before the run stops. Ten by default.
- **Move guests back afterwards** — on by default. Off, they stay where they were moved to and the
  job lists where that is.

The job, step by step:

1. **preflight** — refuses a cluster that is already degraded: a node offline, no quorum, Ceph not
   `HEALTH_OK`. It reads every running guest's configuration from Proxmox to tell which can move,
   and checks that each group's guests fit in the memory the other nodes have free. Nothing has
   changed yet if it refuses.
2. **approve** and **window** — as for one node, under the cluster's policy. The window is checked
   again before every group: a window that closes mid-run stops the run after the group in progress.
3. Then, for each group in turn:
   - **evacuate** — each running guest moved live to the online node outside the group with the
     most memory free; containers move by restart, which is how Proxmox moves a running container.
     A guest that cannot move is shut down, if you chose that.
   - **update** — refresh, simulate and dist-upgrade on each node of the group, as for one node.
   - **reboot** — per the reboot choice, and only if quorum allows it with the group away.
   - **validate** — waits until the group's nodes are back online, every node of the cluster is,
     the cluster is quorate and Ceph is `HEALTH_OK`.
   - **return** — every guest moved back to the node it came from, every guest shut down started
     again.
4. **summary** — how many nodes were updated, how many guests moved or shut down and how many are
   back where they were; any that are not, by name, and where they are.

**When it goes wrong.** A failure in the first group fails the job. A failure after a group has
finished — a node that does not validate in time, a guest that will not move — stops the run as
**partially succeeded**: the groups before it are finished, the groups after it are not started.
Either way the job says which guests were moved and not returned, and where they are now. Fix what
it names, then start a new rolling update: nodes with nothing pending are quick.

The job takes the cluster: node updates and other changes on the same cluster wait behind it.

---

## Maintenance windows

Tab **Maintenance windows**. A window belongs to a tenant and is used by that tenant's policies. It
is a rule for when it opens, how long it stays open, and a time zone; it opens at the same local time
on the days the clocks change, and the first of the two on the night they go back.

The form builds the rule — every day, every week on chosen days, or every month on a day number or a
weekday such as *the last Saturday* (`-1SA`) — and shows when it next opens. **Write the rule myself**
takes an RFC 5545 rule directly: `FREQ` (`DAILY`, `WEEKLY`, `MONTHLY`) with `BYDAY`, `BYMONTHDAY`,
`BYHOUR` and `BYMINUTE`. Anything else — `INTERVAL`, `COUNT`, `UNTIL` — is refused rather than
guessed at. **Not on these dates** skips whole local dates, such as a freeze before a holiday.

---

## Policies

Tab **Policies**. One policy per cluster; a cluster without one is updated by hand only, at any time.

- **Maintenance window** — updates under the policy run only while it is open. **Update** outside
  it is refused, with when it next opens, rather than queued to wait.
- **Requires approval** — every update under the policy waits for approval, by hand or by the policy.
- **Reboot** — the default for updates under the policy.
- **Updates by itself** — when the window opens, Velnox updates the cluster's nodes that have pending
  updates, **one node at a time**: the next starts only when the last has finished and, if it
  rebooted, come back. A node is tried once per opening, so one whose update failed is not retried
  every minute. Needs a window: a policy that updates by itself at any hour is refused.

Policies and windows need `updates.manage`; updating a node or a whole cluster needs
`updates.execute`. A policy that updates by itself does one node at a time, not a rolling update:
it does not move guests.

---

## History

Tab **History**: every node update and rolling update, by a person or by a policy, newest first. Open one for its
output, step by step.

---

## Where it goes wrong

| What you see | What it means |
|---|---|
| *Needs SSH on the cluster* | Set SSH up under the cluster's **Connection** tab and confirm this node's host key. |
| *… allows updates only in window …, which is not open* | The cluster's policy has a window. Wait for it, change the window, or disable the policy. |
| *The maintenance window closed before the update reached the point of changing anything* | The job waited for approval past the window's end. Nothing changed; update again in the next window. |
| *… ended with exit code 126* | The account may not run commands — usually an SFTP-only account. See [the account](#before-you-can-apply-updates-ssh). |
| *… ended with exit code 1* from `sudo` | sudo asked for a password, or does not allow that exact command. Check `/etc/sudoers.d/velnox`. |
| *apt.dist_upgrade … ended with exit code 100* | apt or dpkg failed. The job's output has apt's own words; fix it on the node (`dpkg --configure -a`), then update again. |
| *The machine reached for … is not called …* | SSH reached a machine with another name. Check the node's address and the SSH set-up. |
| *The cluster would not keep quorum* | Another node is down. The updates are installed; the reboot was not done. Bring the other node back, then update again with a reboot. |
| *… did not come back within 20 minutes* | Look at the node's console. |
| The reboot stays due after a reboot | The node booted an older kernel; check its boot order (`proxmox-boot-tool kernel list`). |
| *The cluster is degraded …* | A node is offline, the cluster has no quorum or Ceph is not healthy. A rolling update does not start until it is whole. |
| *These running guests cannot be moved live …* | Their disk is on a node's own storage, or a device is passed through. Move or stop them, or choose to shut them down for the reboot. |
| *While … is down its guests need … GB* | The other nodes do not have the memory free. Stop guests you can spare, or add memory. |
| *… did not come back whole after its update* | The node came back but the cluster or Ceph was not whole in time. The job names what was wrong and the guests not returned. |
