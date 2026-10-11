# Placement

**Which guests of a cluster are kept apart or together, which nodes a guest belongs on, and how
Velnox keeps it so.** A rule is set once and stays true: Velnox reports when it is not met, can move
guests to meet it, keeps it while a rolling update empties a node, and on Proxmox VE 9 writes it into
Proxmox's own HA rules so it holds while Velnox is not running.

For who may do what, see [Roles and permissions](permissions.md). For why it works the way it does,
see ADR-049 in [Technology decisions](tech-decisions.md).

---

## Rules

**Operations → Placement**, then choose a cluster. **New rule**, with one of three kinds:

- **Keep apart** — these guests never run on the same node. For the two halves of a cluster, a
  database and its replica, two domain controllers. More guests than the cluster has nodes cannot
  be kept apart, and is refused.
- **Keep together** — these guests always run on the same node. For guests that talk to each other
  all the time.
- **Prefer nodes** — these guests run on the nodes chosen. **Only these nodes** makes it strict:
  a guest is never put anywhere else, even when none of them can take it. Off, a guest goes
  elsewhere when it has to and comes back when it can.

A rule names guests, by their VMID, and only running guests count: a stopped guest is nowhere, so it
breaks no rule. The same two guests cannot be kept apart by one rule and together by another; the
second is refused, naming the first. A rule that is switched off stays, and counts for nothing.

Each rule says whether it **holds**, from the inventory — so a guest moved outside Velnox shows up at
the next discovery — and, if not, which guests are where.

---

## On Proxmox VE 9: Proxmox's own HA rules

When every node of the cluster runs PVE 9, each rule is also one of Proxmox's HA rules, named
`velnox-` and the first part of the rule's id: **keep apart** and **keep together** as *resource
affinity* (negative and positive), **prefer nodes** as *node affinity*, strict or not. Velnox writes
it within half a minute of saving, reads it back, and says so on the rule:

| What the rule says | What it means |
|---|---|
| *In Proxmox's HA rules* | Proxmox holds the rule exactly as Velnox wrote it. |
| *Being written to Proxmox* | Saved in Velnox; the worker has not written it yet. |
| *Not in Proxmox* | Proxmox refused it, or it could not be read. The reason is shown under the rule. |
| *Kept by Velnox* | PVE 8, or a cluster still upgrading: Proxmox has no rules for this, and Velnox keeps them by moving guests. |

Velnox's rule is the one that counts: a `velnox-` rule changed or removed in Proxmox is written again.
A rule removed in Velnox is removed from Proxmox, then from Velnox. Proxmox's other HA rules are left
alone.

Proxmox's HA manager applies its rules to guests it manages — guests added under **Datacenter → HA**.
Velnox does not add guests to HA by itself, because that changes what happens when a node fails. A
guest outside HA is kept by Velnox's own moves, on PVE 9 as on PVE 8.

---

## Correcting

**Correct now** starts a job that moves running guests, live, until every rule holds, without
breaking another rule: the strict rules first, the smaller guest of two kept apart moves, guests kept
together go to where most of them are, and a guest goes only to a node with the memory for it. What
cannot be met — no node with room, a guest that cannot move live — is said in the job, by name.

The job, step by step:

1. **check** — the cluster is whole: quorate, every node online, Ceph `HEALTH_OK`. Placement moves
   nothing on a cluster that is not.
2. **plan** — from what Proxmox says now, not the inventory: the moves, and what cannot be met.
3. **move** — each move in turn, checked against the rules again just before it.
4. **verify** — the rules read again. A rule still not met fails the job; if some moves were made, it
   ends **partially succeeded**, and the moves made stand.

---

## Balancing

**Balance now** moves at most one guest: the smallest guest on the node using the most of its memory
that, moved to a quieter node, narrows the difference between the busiest and the quietest — never
against a rule, never to a node a soft preference ranks lower. It moves nothing while the difference
is within the threshold. Balancing is by memory, which is what decides whether a guest fits; CPU use
changes from one minute to the next.

---

## Keeping it so

Under **Keeping it so**, both off until you turn them on:

- **Correct by itself** — when the inventory shows a rule not met, Velnox starts a correction.
- **Balance memory by itself** — when the busiest node uses more of its memory than the quietest by
  more than the **threshold** (percentage points, 5–80), Velnox starts a balancing run.

Never while the cluster is not whole — a node offline or quorum lost — never while another job
changes the cluster, and at most once per **quiet period** (minutes). A run started this way says so
in its history: *by the settings*.

---

## Rolling updates

A [rolling update](updating-nodes.md#updating-a-whole-cluster-rolling-update) keeps the rules while
it empties each node: a guest goes only to a node the rules allow, a preferred node first. When no
node is allowed — a guest strictly bound to the node being emptied, say — the rolling update refuses
before it starts, naming the guest and the rule. A guest is not moved back to its own node if that
would now break a rule; the job says where it stays.

---

## Where it goes wrong

| What you see | What it means |
|---|---|
| *The cluster has no guest or node …* | The rule names a VMID or node the inventory does not have. Discover the cluster again if it is new. |
| *… guests cannot be kept apart on … nodes* | More guests than nodes. Split the rule. |
| *The same guests are kept the other way by rule …* | Two rules contradict each other. Change or switch off one. |
| *The cluster is not whole …* | A node is offline, quorum is lost, or Ceph is unhealthy. Nothing is moved until it is whole. |
| *Some placement rules are still not met …* | No node with the room, or a guest that cannot move live (a disk on a node's own storage, a device passed through). |
| *Not in Proxmox* on a rule | Proxmox refused the rule; the reason is under it. On a cluster mid-upgrade, the rule is kept by Velnox until every node runs PVE 9. |
| *No node may take … while its own is emptied* | A rolling update would have to break a rule. Change the rule for the update, or stop the guest. |
