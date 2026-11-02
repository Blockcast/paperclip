# PEN-5151 — a quiet tick is not a skipped claim

`src/server/job-manifest.ts`, comment only. No statement, no signature, no behaviour.

Supersedes one clause of
[`pen-5151-ceiling-becomes-a-config-read.md`](./pen-5151-ceiling-becomes-a-config-read.md), which
landed the per-claim evidence rule in `resolveAgentWorkspaceClaimName`'s DO-NOT-ENABLE block: *a
`drive complete` line for this claim at `dryRun=false` means it was reclaimed.* That rule is right
in the positive direction and has a hole in the negative one, which is the direction an operator
reading the `PaperclipIsolationWorkspaceReaperCoverageGap` alert actually travels.

## The hole

`server/src/services/isolation-reclaim-driver.ts` returns early when the plan has nothing to do:

```ts
if (plan.eligibleIds.length === 0) {
  // The ordinary quiet tick. No Job: see the header.
  return { ...base, ok: true, nothingEligible: true };
}
```

That return precedes the module's **only** `drive complete` log site — `grep -c` over the module
returns `1`. `buildIsolationReclaimPlan` leaves `eligibleIds` empty whenever every entry is still
inside `maxAgeDays` (`fresh` by `mtime`, or `in_use` by `lastUsedAt`, per
`classifyIsolationWorkspaceAge`) and whenever the tree has no named entries at all.

So on an ordinary quiet tick a **covered** claim emits no per-claim line. The drive is nonetheless
`ok`, and `isolation-reclaim-sweep.ts` counts it into `claimsOk`, which `metrics.ts` publishes as
`paperclip_isolation_reclaim_claims_total{outcome="ok"}` — the claim is recorded as driven in the
aggregate and invisible per-claim. A reader applying the rule in reverse classes it as unreclaimed.

## Why this is a comment fix and not a code fix

It fails toward *unreclaimed*, which is the safe direction: the cost is an unnecessary opt-out, not
an unreclaimed tree believed reclaimed. Emitting a line on the quiet path would be the other
candidate fix, and it is rejected here for the reason the early return names itself — a quiet tick
launches no Job, so there is no execution to report, and logging one per claim per daily tick for
the fleet buys nothing the aggregate does not already carry.

What the header owed instead is the condition under which absence *is* evidence. That condition is a
**conjunction**, and the first draft of this change stated only half of it — caught by Ally in
review of this PR at head `f556f3e8`, and worth recording because the half-stated form moved the
failure to the *unsafe* direction while purporting to fix the safe one:

1. **The window contains a fresh `{dry_run="false"}` sweep timestamp**, and `failed`/`deferred`
   show zero increase at `{dry_run="false"}` across it. Without the freshness the zero is
   **vacuous**: `recordIsolationReclaimSweep` labels the entire `paperclip_isolation_reclaim_*`
   family — counters and the `last_sweep` gauge alike — with the sweep's *own* `dry_run`
   (`metrics.ts`, `const dry_run = options.dryRun ? "true" : "false"`). Under the dry-run-only
   rollout the runbook calls *"the first state a correct rollout is in"*, no `{dry_run="false"}`
   series exists at all, so every count read there is zero, no `drive complete` line exists at
   `dryRun=false`, and the half-stated rule concluded *covered* for a deployment that had reclaimed
   nothing — while the sentence immediately above it concluded *unreclaimed* for the same state.
   Freshness is a non-vacuity precondition only; it is not a coverage claim, since the timestamp
   advances on `deferred` sweeps too.
2. **The claim is one the sweep lists.** `listReclaimableClaims` selects agents with
   `enablePerAgentWorkspaceVolume` true or a `workspaceVolumeClaim` distinct from the server's own,
   so a claim left behind by **opting an agent back out** is not listed. The runbook names opting
   out as the cheapest remedy and tells the operator to *"write down the claim you left behind"* —
   so this is a case the page creates itself, and for it absence **is** the unreclaimed reading.

With both stated, the direction is preserved: the rule still fails toward *unreclaimed*.

## Where the same clause went

Three surfaces carried the rule and all three now carry the correction — leaving one uncorrected
would recreate the drift PEN-5151 exists to remove:

- `runbooks/isolation-workspace-reaper.md`, the per-claim evidence paragraph. Its negative clause
  also read *"stale, absent, or dry-run-only means unreclaimed"*, where "absent" could attach to
  the line rather than the timestamp; it is now scoped to the timestamp explicitly.
- `vendor/paperclip-adapter-claude-k8s/src/server/job-manifest.ts`, the DO-NOT-ENABLE header (this
  entry's vendored change).
- `PROVENANCE-CHANGES.d/pen-5151-ceiling-becomes-a-config-read.md`, pointed here rather than
  rewritten, per this directory's append-only rule.

Origin: Ally's non-blocking suggestion on
[#3252](https://github.com/Blockcast/paperclip/pull/3252) at head `0dbcd4bfc`
(0 critical / 0 important / 1 suggestion). It was deliberately not pushed to that PR's head — a
clean head-pinned verdict is not re-burned for a comment — and was carried on PEN-5151 until a
change touched these files.
