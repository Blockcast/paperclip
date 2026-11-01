# PEN-5191 — the agent's instructions root in the WRITE direction, on a claim the server does not hold

Changes to `src/server/job-manifest.ts` and a new
`src/server/job-manifest.instructions-root-write.test.ts`.

Invariant 8 of PEN-4932 stage 4b. Invariant 6 (PEN-5183, #3212) asked whether an opted-in run can
READ the instruction files its charter names. This is the opposite question about the same tree, and
it was filed separately rather than folded into #3212 for that reason: a write-path defect hidden
behind a read-path fix is a defect nobody reviews.

## The measurement came back different from the issue's premise

PEN-5191 was filed as *"the instructions tree becomes READ-ONLY on an opted-in run"*, reasoning that
a Secret volume is read-only and the bundle root is materialized by `cp -L` into a pod-owned
directory. **That is not what happens.** Measured 2026-11-01 by building the manifest both ways
through `buildJobManifest` itself:

| | shared claim (today) | per-agent claim (`enablePerAgentWorkspaceVolume: true`) |
|---|---|---|
| claim | `paperclip-data` | `agent-workspace-29033747-…` |
| instructions-root mount | `{name: data, mountPath: …/agents/cto, subPath: .paperclip/…/agents/cto}` | **byte-identical** |
| `readOnly` | absent | **absent** |

The two are the same mount. The prompt-bundle Secret mounts at `PROMPT_BUNDLE_SECRET_MOUNT_PATH` and
is copied into the *bundle root*, which is a different path entirely — it never shadows the
instructions tree and never made it read-only.

**What is actually wrong is the second hazard the issue listed and did not rank: the mount is
writable, EMPTY, and SEVERED.**

- `narrowWritableSurface` is `isolation.enabled && dataClaimName !== ""` — claim-identity
  independent since stage 4a, and the source says so in as many words (`foreign_claim` is "no longer
  a reachable broad-mount reason"). So the `subPath` bind is still emitted, now rooted in the
  per-agent claim.
- A per-agent claim is a **fresh CephFS subvolume**, so that subtree starts with nothing in it.
  `seed-writable-dirs` `mkdir -m 2775`s it and hands uid 1000 an empty directory.
- The server assembles the next run's instructions by reading `config.instructionsFilePath` through
  its OWN mount (`SELF_POD_DATA_MOUNT_PATH = "/paperclip"`, `execute.ts`). It never reads the
  per-agent claim.

So an edit made on an opted-in run **persists** — it is a PVC, not an emptyDir — onto a volume that
nothing consults when the charter is next assembled. The write succeeds, there is no `EROFS` to
notice, and the register never moves. That is the harness-memory failure one layer down, which the
CTO charter records as: *"the costlier half is the false record — the run truthfully reports 'I
recorded it' and nothing was recorded."*

This matters because that charter is not decoration. `HEARTBEAT.md` §S13 routes the agent off the
per-run harness memory path and onto this tree **because** the harness path was measured to be a
no-op for durability. An opted-in run silently re-breaks the thing that instruction exists to fix.

## The remedy: withdraw the write, do not withdraw the mount

On a claim the server does not hold, the agent's own instructions root is now bound **read-only**.
A durable-register write fails `EROFS` at the call site, where the run can see it and route the edit
somewhere that survives. The tree is empty on such a claim, so the refusal costs that run nothing it
actually had — this converts a silent loss into a refusal, which is this channel's established
posture (#3153/#3157/#3158/#3170, and #3212's own `optional: false`).

**Dropping the mount instead would be worse, not simpler.** `/paperclip` on a narrowed Job is the
root-overlay `emptyDir`; without the `subPath` bind the path lands *there*, where a write succeeds
and dies with the pod. That is the silent loss being closed, not a fix for it. A test pins that the
mount is still present.

Three details the implementation turns on:

- **Matched on the resolved path, not on the candidate that produced it.** With a prompt bundle the
  `instructionsFilePath` candidate is the prompt-cache COPY — the file the run actually reads,
  materialized into a tree the pod owns, and it must stay writable or delivery itself breaks.
  Without a bundle that same candidate resolves to the canonical root. Keying on the path means the
  copy is never caught and the canonical root is never missed; mutation M5 is that assertion.
- **The claim fact is the one `buildJobManifest` already computed**, not a fresh derivation.
  `serverHoldsDataClaim` already decides the delivery channel and `serverCanPreCreate`; a third
  answer to "whose volume is this" could drift, and the permissive direction of that drift is the rw
  mount this withdraws.
- **`readOnlySubPaths` is untouched, so `resolveSeedShape` is exactly as strict as it was.** That
  guard refuses `split` seeding alongside a declared read-only `subPath`, because the split seeder
  walks paths as uid 1000. The instructions root stays an ordinary seed target and only the *bind*
  changes direction — the precedent is `companySkillsMount`, already a `readOnly: true` data subPath
  whose target is seeded the same way.

Default is read-write when the resolver is called without the claim fact, and that asymmetry is
deliberate: the shared claim IS the durable tree, so an omitted argument must not silently withdraw
write access from the live fleet.

## What this does NOT do

**It does not close done-when 1 by observation.** That asks for a read from a real foreign-claim
run. There is none to read, and the cluster says so rather than the config default: `kubectl get pvc
-n paperclip` lists **no `agent-workspace-*` claim at all** (the per-agent claims present are the
unrelated `opencode-db-*`, `pvc-type=agent-db`). `enablePerAgentWorkspaceVolume` is off everywhere,
and turning it on is an operator action — one the source documents as destructive, since it moves
that agent onto a fresh empty volume. The measurement above is from the builder, and this is stated
rather than glossed.

**It does not re-home the durable register.** Read-only makes the loss loud; it does not give the
register a home that works on both claims. One already exists —
`GET`/`PUT /agents/:id/instructions-bundle/file` writes the canonical tree through the server's own
mount — and routing the charters that maintain a register onto it is the follow-up that must land
before any such agent is opted in. It needs the `agents:suggest-changes` grant, which the CTO seat
does not currently hold (measured: `403 deny_missing_grant`).

**It does not update the PEN-4932 plan §5 invariant table.** #3206 is still open and is the only PR
touching that document; editing it here would be a guaranteed conflict that voids an at-head review
attestation. Same sequencing #3212 (invariant 6) and #3211 (invariant 7) took.

**It does not change the shared claim.** Three negative-control tests assert the mount is emitted
byte-for-byte as before, in both containers, with and without a prompt bundle.

## A wording mismatch left for #3212

#3212's foreign-claim directive tells the run *"That directory is NOT mounted in this pod."* As
measured above it **is** mounted — before this change read-write, after it read-only. Flagged on
that PR rather than edited here, since the two branches must not both touch `execute.ts`.

## Verification

`tsc --noEmit` clean. Full adapter suite green: **36 files, 1968 tests**, 12 of them new.
**7 mutations, 7 caught**, applied by a script that aborts if the pattern did not match exactly once
or the file did not change, and that restores the source and asserts the restore:

| mutation | caught by |
|---|---|
| tag read-only unconditionally (lose the claim guard) | all three shared-claim negative controls |
| never tag read-only | `is mounted READ-ONLY …` |
| agent container drops `readOnly` | `is mounted READ-ONLY …` |
| init container drops `readOnly` | `is read-only in the init container too` |
| match the candidate field instead of the resolved path | `keeps the prompt-cache copy … WRITABLE` |
| stop passing the claim fact at the call site | `is mounted READ-ONLY …` |
| drop the mount instead of narrowing it | `is still MOUNTED, not dropped` |

The negative controls are controls that can actually fail: mutation 1 fails all three of them.
