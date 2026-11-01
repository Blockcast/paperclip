# PEN-5183 — carry the instruction files the charter NAMES, and stop pointing the pod at a directory it cannot reach

Changes to `src/server/prompt-bundle-projection.ts`, `src/server/execute.ts` and their tests.

Invariant 6 of PEN-4932 stage 4b, and the same shape as invariant 5 in the same direction as
invariant 1 — covered by neither. Invariant 1's unit is the prompt bundle, which §4.2 measured as
`agent-instructions.md` **plus the skill symlink farm** and nothing else. The agent's *instructions
tree* is a separate scoped-writable `data` `subPath`, written by the agent rather than by the
server, which is why a list derived from the server's own writes did not contain it.

## The defect was worse than an absence

`instructionsContents` is the entry file's bytes plus a generated path directive, and that directive
tells the run:

> Resolve any relative file references from `<dir>`. This base directory is authoritative for
> sibling instruction files such as `./HEARTBEAT.md`, `./SOUL.md`, and `./TOOLS.md`.

Once the Job's claim is per-agent, `<dir>` is an empty mount. The run is *instructed* to read files
that are not there, every read `ENOENT`s, the Job still exits 0, and the run completes looking
normal — the silent-degradation outcome this channel exists to prevent, delivered by the channel
itself.

## The projected set is derived from the CHARTER, not from a directory listing

This is the whole design, and the measurement is why. The instructions root is **agent-writable**,
so a listing makes the server's payload a function of whatever the agent last wrote beside its
charter. Measured on the live CTO tree, 2026-11-01:

| set | files | bytes | vs. the 1 MiB cap |
|---|---|---|---|
| whole root, dot-prefixed entries excluded | 9 | 1,942,995 | **185 % — over cap** |
| what `AGENTS.md` actually names | 3 | 29,755 | 2.8 % |

The 1.9 MB is editor hygiene, not instructions: two `HEARTBEAT.md.bak-*` snapshots of 620 KB and
610 KB, plus a 674 KB evidence log whose own header reads *"you should never need to open the case
law to execute a heartbeat."*

⛔ **And a cheaper filter does not work.** The documented backup convention is dot-prefixed
(`.HEARTBEAT.md.bak-<UTC>`), so "skip dotfiles" looks sufficient — but two of the live snapshots
were written **without** the leading dot. A name-shaped filter misclassifies, and it misclassifies
in the **expansive** direction: it ships 1.2 MB of backups and pushes the run past a cap that
*refuses*, converting a silent degradation into a hard failure for every run of the opted-in agent.
Deriving the set from the charter cannot be polluted by what the agent writes beside it.

Naming is necessary but not sufficient: each candidate must also resolve to a regular file inside
the root. A named-but-absent file is simply not projected — an `items[]` entry whose key has no
Secret value is a pod that cannot start, so inventing one would trade this bug for a worse one.
`..` escapes are rejected on the resolved path, and the entry file is excluded from its own sibling
set (it already travels as `agent-instructions.md`).

**One level, deliberately.** Transitive references are not followed. `HEARTBEAT.md` names
`HEARTBEAT-CASELAW.md`, and following that edge re-admits the 674 KB the table above rules out.
"What the charter itself names" is the line.

## Sizing: §4.2's escalation trigger does not bite for this remedy

Done-when 3 asks for this explicitly. The declared set is **29,755 bytes — 2.8 % of the 1 MiB
decoded cap**, against a 50 % escalation trigger. Sibling bytes are added to `totalValueBytes`, so
the budget guard and the trigger both see them; a test pins that, because a payload excluded from
the quantity the trigger reads would make the trigger under-report exactly what this change adds.
The init-container escalation is **not** taken, and the measurement rather than a preference is the
reason.

## The directive now matches the delivery mode

The shared-claim directive is kept **byte-identical** — it is correct there, every live run is on
that path today, and it is the negative control done-when 2 asks for. On a foreign claim the
directive instead names `agent-instructions/`, **relative to the file it is appended to**.

Relative is forced, not stylistic: the bundle root is content-addressed by a key derived from these
very bytes, so an absolute directive would have to name a path that depends on its own content.

`serverHoldsJobDataClaim` is now evaluated **once**, hoisted above the directive, and reused by the
delivery decision. The claim decides whether the instructions directory is reachable *and* whether
the bundle goes by Secret; two derivations would be free to drift, and the permissive direction of
that drift is a directive naming an unreachable directory on a run whose bundle went by Secret —
the original defect. One call site, pinned by test.

`instructionsRootPath` falls back to the entry file's own directory, because it arrives from
instance scope and an agent's own `adapterConfig` may be `{}` while its pod still carries the mount.

## What this does NOT do

**It does not close PEN-5183's first done-when by observation.** No run has happened on a foreign
claim; `enablePerAgentWorkspaceVolume` is default-off and the opt-in is an operator action no agent
seat can perform. What changed is that the failure is no longer structural.

**It does not update the PEN-4932 plan §5 invariant table.** #3206 is in the merge queue and is the
only PR touching that document; editing it here would be a guaranteed conflict that voids an
at-head review attestation. The resolved-state row is a follow-up, matching how invariant 7 is being
sequenced on #3211.

**It does not address write-back.** A Secret volume is read-only, so on an opted-in run the
instructions tree stops being a durable register the agent can edit. That is a *separate* crossing
in the opposite direction, not a residual of this one, and it is recorded on PEN-5183 rather than
folded in here.

## Verification

`tsc --noEmit` clean; full adapter suite green. **8 mutations, 8 caught**, each applied by a script
that aborts loudly if the pattern did not match or the file did not change:

| mutation | caught by |
|---|---|
| drop the sibling projection block | `carries the named siblings beside the entry file` |
| drop the `..` containment check | `refuses a reference that escapes the instructions root` |
| drop the entry-file exclusion | `never projects the entry file as its own sibling` |
| drop the sibling-count refusal | `refuses rather than truncating past the sibling ceiling` |
| directive always takes the shared-claim form | `branches the directive on the claim` |
| directive loses the not-mounted warning | `stops pointing at the server directory on a foreign claim` |
| re-derive the claim instead of reusing it | `evaluates the claim predicate once and reuses it` |
| stop passing the root to the projection | projection + execute suites |

The shared-claim negative control was separately shown to **fail** under two independent rewordings
of the directive, so it is a control that can actually fail rather than one that cannot.
