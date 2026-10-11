# Major upgrades

**Plans that upgrade a cluster target by target, the checks before, the remediations, and the report
after.** A plan runs one playbook — a Ceph upgrade, a Proxmox VE upgrade — or, as a *composite*,
several plans one after another: Ceph first, then Proxmox VE. The Ceph and Proxmox VE playbooks arrive
in Phases 9A and 9B; until then the only playbooks are the engine's own self-tests, which change
nothing outside Velnox.

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
