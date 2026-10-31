# PEN-5125 — price the unreclaimed foreign-claim tree on the gate's own DO-NOT-ENABLE block

`src/server/job-manifest.ts`, comment only. No statement, no signature, no behaviour.

PEN-5125 closed its done-when 2 through that criterion's *second* clause — bound the growth another
way and write the accepted ceiling down — rather than by building a sweep. The reclaimer itself
moved to PEN-5151 with its shape already chosen. This change is where the accepted ceiling gets
recorded somewhere the person it binds will actually read it.

That place is `resolveAgentWorkspaceClaimName`'s existing DO-NOT-ENABLE block, because it is the one
comment whoever flips `enablePerAgentWorkspaceVolume` has to pass through. The added paragraph says
three things (the headroom subtraction is left implicit there and spelled out in the plan and the
runbook):

- **Nothing reclaims an opted-in agent's `k8s-isolation/workspaces/*` tree.** The isolation-workspace
  reaper walks that path through the *server's* mount, so moving the tree to a per-agent claim moves
  it out of the only sweep there is. The miss is silent by construction: the enumeration is
  directory-driven, so an unreachable workspace lands in no outcome bucket and the pass still
  reports `stop_reason="complete"`.
- **The accepted ceiling, in numbers that can be re-checked rather than remembered** — ≈10 GiB per
  agent per month (the measured July → 2026-09-02 fleet rate) against a 50 Gi claim already carrying
  ≈13.2 G, i.e. ≈36.8 GiB of headroom, i.e. one opted-in agent fills its own claim in ≈3.7 months.
  `allowVolumeExpansion` is true, so the terminal state is an operator resizing a PVC rather than a
  run losing data — which is what makes this priceable instead of blocking.
- **The cheapest remedy, which does not need the reclaimer**: opt the agent back out, which returns
  its runs to the shared claim where the existing `{home, session}` + `lastUsedAt` predicate applies
  unchanged. The comment names only this one — the second (expand the claim) and the cold-start cost
  of opting back out live in `runbooks/isolation-workspace-reaper.md`, which is where an operator
  already in the alert will be, rather than in a comment aimed at whoever flips the toggle.

## Why this is a second PRECONDITION and not a second blocker

The block it joins already carries one. The distinction is deliberate and is stated in the comment:
invariant 5 (PEN-5120) is what *blocks* the flip; this one *prices* it. Conflating them would be the
expensive error in the safe-looking direction — a reader who treats a capacity note as a blocker
never enables the gate, and a reader who treats a blocker as a capacity note enables it while the
pod log still crosses the volume in the read direction.

## What makes the ceiling checkable instead of remembered

`paperclip_isolation_workspace_reaper_unreachable_agents` (landed in #3180) counts exactly this
population, and `PaperclipIsolationWorkspaceReaperCoverageGap` fires on `!= 0`. So the **first**
opt-in raises the alert within one daily sweep and it stays raised. The comment names that alert and
says in those words not to read it as informational while PEN-5151 is open — silence is the state
the whole gauge was added to end, so silencing it is the specific failure to avoid.

## Why it is in the vendored tree at all

`resolveAgentWorkspaceClaimName` is vendored adapter source, and the gate it guards is vendored. The
ceiling could have lived only in `docs/plans/2026-10-28-pen-4932-per-agent-volumes.md` §4 stage 4b —
it is there too, along with `runbooks/isolation-workspace-reaper.md` — but a plan document is not on
the path of the person flipping a default-off toggle in `config-schema.ts`. The three copies are
intentional and the PR's review focus asks for them to be checked against each other.
