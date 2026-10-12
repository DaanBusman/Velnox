# Major upgrades

**Plans that upgrade a cluster target by target, the checks before, the remediations, and the report
after.** A plan runs one playbook — a Ceph upgrade, a Proxmox VE upgrade — or, as a *composite*,
several plans one after another: Ceph first, then Proxmox VE. The Ceph playbook is below; the Proxmox
VE 8 → 9 playbook arrives in Phase 9B. The engine's own self-tests, which change nothing outside
Velnox, are there too.

For who may do what, see [Roles and permissions](permissions.md). For why it works the way it does,
see ADR-050 in [Technology decisions](tech-decisions.md).

---

## Plans

**Operations → Updates & upgrades**, tab **Major upgrades** — also at `/major-upgrades`. **New plan**:
a cluster, a playbook and a name. The targets come from the inventory when the plan is made, in the
order they will be upgraded: nodes by name; Ceph daemons in Ceph's own order — monitors, then
managers, OSDs, MDS and RGW.

A plan that has not run yet can be started or removed. Once started it cannot be started again or
removed: its record and its report stay.

---

## How a plan runs

Every playbook goes through the same phases, as one job you can follow step by step:

1. **Discovery** — what the guards read: the cluster's quorum, nodes offline, Proxmox VE versions,
   Ceph's health.
2. **Preflight** — the playbook's checks, each finding `PASS`, `INFO`, `WARNING`, `BLOCKER` or
   `UNKNOWN`. A line Velnox does not recognise is `UNKNOWN`, and stops the upgrade like a blocker:
   it is never assumed harmless. A step can have a *guard* — a condition such as "the cluster has
   quorum and no node is offline" — that stops the run, naming what did not hold.
3. **Remediation** — a finding with a remediation gets one, routed by what the remediation is:
   - **Applied by Velnox** when its risk is low and Velnox can undo it.
   - **Needs approval** otherwise. The job stops and waits for someone with `upgrades.execute` and
     `jobs.approve`, showing the exact change — every file line by line, every package, every
     command. What is approved is what is applied: the same record.
4. **Check again** — the checks run again. The plan keeps every run, so what a remediation fixed is
   a comparison, not a guess. Anything that stops the upgrade still open ends the run here, as
   **blocked**, before any target is touched.
5. **Upgrade** and **validation** — target by target: one is upgraded and validated before the next
   begins. A target that fails stops the run there; the ones before it are done, the ones after it are
   not reached.
6. **Report** — every target's state before and after, what each run of the checks found, what was
   fixed and what is still open, every remediation and how it ended. Shown with the plan and
   downloadable as Markdown, for a ticket or a customer.

---

## Ceph: a major upgrade

The playbook **Ceph major upgrade** upgrades a hyper-converged Ceph cluster one release, as Proxmox's
own guides do it. **New plan** with this playbook asks for the release to upgrade to and the
repository channel (no-subscription or enterprise).

**The version matrix.** Velnox upgrades only along steps it knows, each as Proxmox documents it:

| From | To | Needs at least |
|---|---|---|
| Quincy (17) | Reef (18) | Ceph 17.2.7 |
| Reef (18) | Squid (19) | Ceph 18.2.4 and pve-manager 8.2.8 — Proxmox VE 9 needs Squid |

A plan is not made when the release that runs, the release asked for and the matrix disagree, and
the refusal says which of the three is the unexpected one: a cluster whose daemons run different
releases — already mid-upgrade — or a release Velnox does not know is *the release that runs*; a
release that is not newer is *the target*; a step the matrix does not have, such as Quincy straight to
Squid, is *the matrix*. The plan records the matrix version that made it.

**Before anything changes**, the preflight reads Ceph from Proxmox as it is then and blocks on: Ceph
not `HEALTH_OK`, any placement group not `active+clean`, any monitor out of quorum, daemons on
different releases, a warning Velnox does not know (shown verbatim, as `UNKNOWN`), pve-manager older
than the step needs, no SSH on a node, and — with CephFS — MDS daemons the plan has not been told are
prepared. `noout` already set is a warning: Velnox leaves it as it found it.

**Then, in order:**

1. **repository** — `/etc/apt/sources.list.d/ceph.list` on every node set to Proxmox's line for the
   target, the old file kept as `ceph.list.velnox-before`.
2. **noout** — set, so OSDs restarting are not marked out.
3. **packages** — `apt-get update` and the dist-upgrade on every node. The daemons go on running the
   old release.
4. **restart** and **settle**, daemon by daemon, in Ceph's order — monitors, managers, OSDs, MDS:
   each restarted through Proxmox, proven to run the new release, and Ceph read again until it is
   whole — healthy apart from `noout` and the warning that `require-osd-release` is not raised yet —
   before the next. A warning Velnox does not know stops the run at once; one a restart causes for a
   moment, such as a monitor out of quorum, is waited out, up to the settle time (ten minutes by
   default).
5. **require-release** — `ceph osd require-osd-release` raised to the target, only once every OSD
   runs it.
6. **noout-unset**, then **verify**: every daemon on the target release, `min_mon_release` the target,
   Ceph healthy.

**noout is always cleared.** When the run fails, is cancelled, or its worker dies, Velnox clears
`noout` if it set it — a dead worker's by the next worker, within seconds of noticing.

**CephFS.** Proxmox's guide reduces each file system to one active MDS and turns standby replay off
before restarting MDS daemons. Velnox does not change those settings: do it first, then tick
**CephFS is prepared** on the plan. Without it, a cluster with MDS daemons is blocked.

**SSH and sudo.** The repository and the packages need SSH on every node; the `ceph` command needs
the cluster's admin keyring. Root is simplest. With a dedicated account, add to the sudo rules for
updates the exact commands — for Squid, for example:

```
velnox ALL=(root) NOPASSWD: /usr/bin/ceph osd require-osd-release squid
```

and the repository switch, which Velnox runs as `sh -c` with the exact line for the target; check the
command in the job's output.

---

## Composite plans

A composite runs its plans in order, each as its own job: the next starts when the one before it has
completed and the cluster is free. When one fails — or is blocked — the composite fails, and the plans
after it are cancelled without being started. Its report holds its plans' reports, in order.

A plan inside a composite is not started on its own; start the composite.

---

## The self-tests

Two playbooks prove the engine on any cluster, offered to those who manage the installation
(`system.manage`): one node by node, one Ceph daemon by daemon. They work on a record kept in the plan
and change nothing outside Velnox: a missing marker on each target that Velnox fixes by itself, a
configuration that needs approval to change, a blocker nothing fixes, a target that fails — chosen
when the plan is made.

---

## Where it goes wrong

| What you see | What it means |
|---|---|
| *A condition for this step does not hold: …* | A guard — for example, a node offline. Make the cluster whole, then make a new plan. |
| *… still stop the upgrade* | A blocker or an unrecognised line is open after remediation. The plan says which. |
| *… remediation … failed* | A remediation could not be applied, or did not fix its check. The job's output says why. |
| *The upgrade of … failed* | A target's upgrade or its validation failed. The targets before it are done. |
| *Only a plan that has not run yet can be started or removed* | Make a new plan. |
| *There is no playbook …, or it is not offered to you* | Self-tests need `system.manage`. |
| *The running release, the target and the version matrix disagree* | The refusal names which; see [the version matrix](#ceph-a-major-upgrade). |
| *Ceph is not whole: …* | After a daemon's restart Ceph did not come back healthy within the settle time, or showed a warning Velnox does not know. `noout` has been cleared. |
