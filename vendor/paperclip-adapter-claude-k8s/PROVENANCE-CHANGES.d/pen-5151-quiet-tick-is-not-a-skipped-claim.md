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

What the header owed instead is the condition under which absence *is* evidence, which is what this
adds: zero `failed` and zero `deferred` increase at `{dry_run="false"}` over the window says every
claim the sweep listed was driven, and a claim driven with nothing eligible is covered.

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
