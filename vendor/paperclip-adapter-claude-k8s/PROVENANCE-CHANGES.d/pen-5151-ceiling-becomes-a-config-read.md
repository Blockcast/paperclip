# PEN-5151 — the capacity precondition stops being a standing price and becomes a config read

`src/server/job-manifest.ts`, comment only. No statement, no signature, no behaviour.

[`pen-5125-reclamation-ceiling.md`](./pen-5125-reclamation-ceiling.md) added a second precondition to
`resolveAgentWorkspaceClaimName`'s DO-NOT-ENABLE block whose first sentence was **"Nothing reclaims
an opted-in agent's `k8s-isolation/workspaces/*` tree."** PEN-5151 built the thing that reclaims it,
so that sentence is now false as a statement about the code — while remaining true as a statement
about a deployment that has not enabled the sweep. This entry records the rewrite that tells those
two apart.

## What changed, and why it is a re-point rather than a deletion

PEN-5151's done-when 3 asks for the capacity clause to be *dropped*. It is dropped **as an
unconditional price** and kept **as a conditional one**, because deleting it outright would assert
something the deployment does not support:

- The reclaimer exists end to end (`isolation-reclaim-sweep.ts` → `isolation-reclaim-driver.ts` →
  `isolation-reclaim-job-port.ts` / `isolation-reclaim-report.ts`), over the **same**
  `REAPABLE_LAYOUT` allowlist and `classifyIsolationWorkspaceAge` predicate the mounted sweep uses —
  shared functions, which is the property that keeps the foreign path from acquiring a weaker
  transcription of a rule that exists to keep files.
- It is **opt-in** (`isolationReclaimSweepEnabled` / `PAPERCLIP_ISOLATION_RECLAIM_SWEEP_ENABLED`,
  read at `server/src/index.ts`), for the reaper's own stated reason: deleting files irreversibly
  must not be the same act as deploying the code.
- `deploy/helm/paperclip/values.blockcast.yaml` does not set it. **So on Blockcast today the ceiling
  still applies in full**, and a reader who found the clause deleted would conclude the opposite.

The comment therefore now points at the flag and says to read it, instead of asserting a state.

## Why this shape, and not another sentence of state

This is the second time this row has paid for a comment written in the present tense.
`isolation-workspace-reaper.ts`'s header said *"what is still missing is the acting half"* after the
acting half landed, and needed its own PR (#3234) to correct. The same sentence pattern — *"nothing
X yet"* — had by then gone stale in four places at once: this block, the plan's §4 stage 4b, the
runbook, and that header.

**A comment that names what is missing needs an edit per increment and gives no signal when it has
missed one.** The fix is not a more careful edit; it is to name a thing the reader can evaluate. A
flag read at a named call site cannot go stale, because the reader resolves it against the
deployment in front of them rather than against the author's memory. Every surface touched here now
routes the live question that way, and the numbers (≈10 GiB/agent/month, 50 Gi, ≈13.2 G, ≈3.7
months) are kept as the consequence *conditional on the flag being unset*, which is the part that
does not move.

## The gauge correction, which is the part most likely to be read backwards

The block previously said not to read
`paperclip_isolation_workspace_reaper_unreachable_agents` as informational *while PEN-5151 is open* —
which invites the inference that closing PEN-5151 returns it to `0`. It does not, and the comment now
says so explicitly.

That gauge counts **agents whose trees the MOUNTED sweep cannot reach**. That is a property of where
the tree lives, not of whether anything reclaimed it: an opted-in agent is unreachable from the
server's mount whether or not an executor is sweeping its claim. `createDbUnreachableAgentCount`'s
own header makes the same point from the other side — *"the count it owes is of agents"*, and do not
fix the gauge by reading the reclaimer's output into it.

So the reading is a **pair**, and this is what satisfies PEN-5151's done-when 2 companion:
`unreachable_agents != 0` with a fresh
`paperclip_isolation_reclaim_last_sweep_timestamp_seconds` is *unreachable but reclaimed*; with a
stale or absent one it is the standing record that an unreclaimed tree exists. Only the second
carries the "opt an agent in only together with an owner for its claim's capacity" obligation.

## What is deliberately NOT changed

- **The FIRST precondition — invariant 5 / PEN-5120 — is untouched and still BLOCKS the flip.** The
  two were separated on purpose by the PEN-5125 entry (one blocks, one prices) and that distinction
  is load-bearing in both directions: a reader who treats the capacity note as a blocker never
  enables the gate, and one who treats the blocker as a capacity note enables it while the pod log
  still crosses the volume in the read direction.
- **The alert-not-deployed qualifier stays.** `prometheusRule.enabled: false` on Blockcast and
  Blockcast/onprem-k8s#7210 still open were both re-checked on 2026-11-02; the paragraph is accurate
  and keeps pointing at `/api/v1/rules` as the check.
- **The opting-out asymmetry stays**, including Ally's correction on the PEN-5125 entry that opting
  out stops the growth and does not undo it, leaving the bytes unreclaimed *and* uncounted.

## Why it is in the vendored tree at all

`resolveAgentWorkspaceClaimName` is vendored adapter source and the gate it guards is vendored. The
sibling copies — `docs/plans/2026-10-28-pen-4932-per-agent-volumes.md` §4 stage 4b and
`runbooks/isolation-workspace-reaper.md` — are corrected in the same commit for the same reason, and
the PR's review focus asks for the four surfaces to be checked against each other.
