# Watching, cancelling and approving jobs

**Everything Velnox does that takes longer than a page load is a job.** A job has a status, a list
of steps, a history of events and the output its steps produced, and all four are kept after it
finishes. This guide is about reading them and deciding what happens to them.

For who may do what, see [Roles and permissions](permissions.md). For why the job system works the way it
does, see ADR-035 and ADR-036 in [Technology decisions](tech-decisions.md).

---

## The Jobs screen

**Jobs** in the sidebar lists every job this account may see, newest first, with its status, how
far it has got, who started it and how long it took. Filter by status at the top of the list.

The list re-reads itself on your refresh setting (**Settings → Refresh screens automatically**) and
pauses while a form on it is open. Opening a job shows it **live**: its events arrive as they
happen, not when you reload.

## What the statuses mean

| Status | Meaning |
|---|---|
| **Queued** | Accepted, waiting for a worker to pick it up. |
| **Preflight** | A worker has it and is checking it can start. |
| **Running** | Executing its steps. |
| **Waiting for approval** | Parked at a gate until someone with the right permission decides. |
| **Validating** | Checking the result of what it did. |
| **Succeeded** | Finished, and every step succeeded. |
| **Partially succeeded** | Finished, with some targets done and some not. |
| **Failed** | Did not finish. The job says why. |
| **Rolled back** | Its changes were reverted. |
| **Cancelled** | Stopped on request. |

The last five are final. A job never moves again once it reaches one of them.

---

## Watching a job

A job's page shows, top to bottom: its status and progress, the reason it stopped if it failed,
the approval waiting for a decision if there is one, its steps, its events, and the raw output of
its steps.

**Live** in the corner means the stream is connected. **Reconnecting…** means it dropped and the
browser is getting it back; nothing is lost, because every event has a sequence number and the
browser asks for everything after the last one it saw.

The event list hides progress reports by default, because a long step reports progress every few
seconds and buries everything else. Tick **Show progress reports** to see them.

---

## Cancelling a job

**Cancel job** asks the job to stop. What happens next depends on where it is:

- **Queued or waiting for approval** — nothing has run, so it is cancelled at once.
- **Running** — it stops at the next safe point. A step that can be interrupted part-way (a wait, a
  poll, a transfer) is interrupted; a step that must not be — a package installation, a reboot — is
  allowed to finish first. Velnox never kills a change halfway through a transaction.

On the job's page, a step interrupted by the cancellation shows as **failed**, with *Interrupted:
the job was cancelled* beside it, and the steps after it as **skipped**. The step began and did not
finish, and "never ran" would be untrue.

A finished job cannot be cancelled.

---

## Approving a job

Some jobs stop at an **approval gate** before a step that changes something, and wait. The job's
page shows the reason, the permission it needs, and the **change set** — exactly what the step will
do. **Approve** lets it carry on from the gate; **Reject** fails it, and nothing after the gate runs.
Either way, add a note if the next person will want to know why.

To decide you need `jobs.approve` for the job's tenant, **and** whatever permission the gate itself
names. An upgrade gate asks for the right to run upgrades, not just to approve jobs.

### Four-eyes

A gate can require a **different** person from the one who started the job. Then the person who
started it cannot approve it — the point is that nobody pushes their own change through alone — but
they can still reject it, which is the same as withdrawing their own request.

---

## Retrying a job

**Retry** on a failed, cancelled or rolled-back job starts a **new** job with the same parameters.
The original is not touched: its history stays exactly as it was, and each links to the other
(**Retry of** and **Retried as**). A job that succeeded cannot be retried.

---

## One job per cluster

A job that changes a cluster holds that cluster while it is active — including while it waits for
approval, because an approved change set has to still describe the cluster it runs on. Starting a
second one against the same cluster is refused with the job that is in the way named, and becomes
possible the moment the first one finishes.

The database enforces this, not only the application, so two requests arriving at the same moment
cannot both get through.

---

## When the worker stops mid-job

If the worker is killed, crashes or is redeployed while running a job, the job cannot finish. About
half a minute later Velnox notices — the worker stops renewing its claim on the job — and marks the
job **failed** with *The worker stopped unexpectedly*.

It is **not** restarted automatically. It may have been halfway through changing something, and
running it again from the top would do the first half twice. Look at which step it was on, check
the state of what it was changing, and retry it yourself when it is safe to.

---

## The diagnostic job

**Diagnostic job** on the Jobs screen (with `system.manage`) starts a job that does nothing but take
time and report on itself. It touches no infrastructure. Use it to see the job system working on
your installation: set a number of steps and a duration, optionally a step to fail at or an approval
gate to stop at, and watch it.

`scripts/verify-jobs.sh` uses the same job type to check all of the above against a running
installation, including killing the worker mid-job. Run it on a test installation, not on one doing
real work.

---

## Permissions

| To | You need |
|---|---|
| See jobs | `jobs.read` for the job's tenant |
| Cancel a job | `jobs.cancel` for the job's tenant |
| Approve or reject | `jobs.approve` for the job's tenant, plus the gate's own permission |
| Retry a job | Whatever starting that kind of job needs — `system.manage` for a diagnostic job |
| Start a diagnostic job | `system.manage` |
