# PEN-5234 — refuse a dispatch whose execution workspace is on the other volume (PEN-4932 invariant 9)

Changes to `src/server/job-manifest.ts`, `src/server/job-manifest.per-agent-claim.test.ts` and
`src/server/job-manifest.test.ts`. Paired with a server-side change in `server/src/home-paths.ts`
and `server/src/services/heartbeat.ts` that supplies the discriminator.

The largest of the PEN-4932 stage-4b crossings, because the artifact that crosses the volume is
**the working tree the run operates on**.

The writer is the **server**: `realizeExecutionWorkspace` clones, fetches and — for
`git_worktree`, the default strategy for `isolated_workspace` — runs `git worktree add` against
server-local filesystem paths, rooted at the server's own `/paperclip` mount. The reader is the
**pod**, which reaches that tree only as a `data`-volume `subPath` bind. Those are the same bytes
only while the two processes mount the same *volume*, which is exactly `serverHoldsJobDataClaim`.

Nothing in the realization path is claim-aware. `enablePerAgentWorkspaceVolume`,
`agentWorkspaceClaim` and `agent-workspace-` appear in `heartbeat.ts`, the isolation-reclaim
services and this adapter, and in **none** of `workspace-runtime.ts`, `workspace-realization.ts`
or `execution-workspace-policy.ts`. So on a per-agent claim the server writes to a volume the pod
does not mount, and the two never converge — the only writer is on the wrong side of the boundary.

## It is silent in both isolation modes, and it would have scored a PASS

Under `run` isolation the pod bootstrap is guarded on the source repo existing
(`if git -C <workspaceCwd> rev-parse --verify HEAD`). An empty `workspaceCwd` fails that guard and
falls to the `else` branch — written for stateless runs that legitimately start outside a
repository — which hands the run an empty directory. No error, no warning, exit 0, complete
parseable stdout. Every other isolation mode mounts the execution workspace directly, so the cwd
simply *is* the empty `subPath`: same outcome, one step shorter.

PEN-4932's done-when 1 asks only for two co-located pods reporting **distinct volume IDs**. A run
with no code at all satisfies that perfectly. This is the same false-PASS risk that blocked the
flip for invariants 6/7/8, and the worst instance of it.

It also corrects board approval card `1d46f151`, which told the operator that the nominated
agent's **first** run after the flip starts from an empty workspace — framing that implies
convergence. Every run starts empty.

## Taken: fail the dispatch closed. (a) is the eventual shape, refused *for now*

`buildJobManifest` throws when the Job's claim is not the server's own **and** the server realized
a tree at this run's cwd.

⛔ **Moving realization into the pod — remedy (a) — is the eventual shape and is not taken here.**
It is refused for now rather than rejected, on three costs none of which is payable blind:
`git clone --shared` off a local base is what makes run-isolated pods cheap (`job-manifest.ts`
says so in terms), so cloning from upstream per run is a full network clone of a large repo on
every wake; the server's post-run reads of that tree — branch reconcile-forward, dirty-quarantine
repair, the worktree registry, the isolation reaper — must be re-homed or lost; and no opted-in
run exists to measure any of it against. This row does not close without it.

⛔ **An address translation is refused**, the standing rule from invariants 5 and 7: a prefix swap
is sound only where one volume is reachable from both processes at two roots. The pod's volume is
reachable from the server at *no* path, so a translation converts a wrong answer into a
confidently wrong one.

⛔ **Keeping the execution workspace on the shared claim as one surviving bind is refused** by
PEN-4932 §2's own reasoning — one bind on the shared handle preserves the whole node-wide wedge,
which is the thing the plan exists to remove, so it would buy nothing.

## The refusal is scoped, so done-when 1 stays reachable

A run that resolved no project and no session is handed a workspace-less fallback directory
*because* it is empty, and that expectation holds on a per-agent claim exactly as it does on the
server's own. Those runs dispatch normally, so an operator can nominate such an agent and observe
two co-located pods with distinct volume IDs on a run that genuinely works.

An agent **with** a project or session workspace cannot be the nominee until (a) ships. That is
the true state of the system, not a regression introduced here: such a run was already incapable
of doing anything on a per-agent claim, it just did not say so.

## The discriminator is supplied, not re-derived — and every local substitute leaks

`serverRealizedTree` arrives on `context.paperclipWorkspace`, computed by
`isWorkspaceLessFallbackWorkspaceDir` (`server/src/home-paths.ts`, sited beside both directory
producers and reused by BLO-18760's existing dispatch guard so the two cannot drift).

The adapter does not re-derive it, because each field it could key on leaks in a different
direction:

* **`source`** — only the FIRST workspace-less run carries `source: "agent_home"`. That cwd is
  persisted into the task session, so every resume resolves the identical directory back as
  `source: "task_session"`. A label test clears run 1 of a stateless agent and refuses runs 2..n.
  (BLO-18760 already records this at the guard it added, for the same reason.)
* **`repoUrl`, `workspaceId`** — both `null` on a `local_path` project workspace, which keeps
  `source: "project_primary"`. Neither separates the cases either.

**Absent means refuse.** A server too old to send the field tells us nothing about which case this
is, and the costly direction is the silent empty run, not a named refusal on a claim nobody has
opted into yet.

## Secondary, same root cause: `resolveLinkedWorktreeCommonDir`

Skipped outright on a foreign claim. Its three reads are server-side `readFileSync`s of **pod**
paths landed on `serverRoot`. On a foreign claim they ENOENT, and the first failure takes
`if (!pointer) return null` — the early return **above** the `worktree_gitdir_rejected` warn — so
the answer is not merely wrong but indistinguishable from the legitimate "ordinary checkout, no
linked worktree" one, and the diagnostic that exists to make the resulting mid-run `EROFS`
readable is lost with it.

The other direction is worse: the server's own volume may hold a **verifiable** registration at
that exact path — the identically-spelled tree it realized — in which case the function returns a
confident `common` for a worktree this pod will never see, and the manifest grows a writable mount
covering another volume's git dir.

`resolveScopedWritableMounts` already **takes** `serverHoldsDataClaim` and uses it for PEN-5191's
read-only instructions root. Every other crossing found in this sweep got that guard; this call
simply did not consult it.

## The `else` branch stops absorbing three cases as one

Three runs reach it and, until now, produced byte-identical behaviour: one never meant to find a
repository; one whose project workspace is a `local_path` directory that is not a repository; and
the severed one. It now emits `claude_k8s.workspace_source_absent` naming which, and **exits
non-zero** on the severed case.

⚠️ That predicate is `serverRealizedTree && !serverHoldsDataClaim` — **both** conjuncts.
`serverRealizedTree` alone is routinely true on the server's own claim for the `local_path` case,
where this branch is the correct outcome and a working run today; failing on it would convert a
working run into a hard pod failure. The severed branch is unreachable behind the dispatch
refusal. It is emitted anyway, because its whole value is that the silence does not come back if
that refusal is ever narrowed or bypassed.

`claude_k8s.data_claim_foreign` additionally now publishes `executionWorkspace` and
`sessionResume`, which closes **PEN-5189's recorded residual** — that the invariant-7 refusal had
no observable except the absence of a flag from the Job spec.

## Inert today, asserted by negative controls

Every agent still resolves `dataClaimName` to the server's own PVC, so nothing on the fleet
reaches any of this. That is a test rather than a claim: the control and the opted-in case are the
same fixture with the same workspace context, differing only in the claim.

⚠️ **Closed is not verified**, exactly as for invariants 5, 6 and 8. This is measured from the
builder; `kubectl get pvc -n paperclip` still lists no `agent-workspace-*` claim, so there is no
foreign-claim run to read.

## Why the mount inventory could not find it

PEN-4932 §3's inventory is keyed on **paths** — what the server writes, what the pod mounts. Here
the server writes and the pod reads the *same* `subPath`; only the volume differs. It is the fifth
consecutive find for the writer/reader test (*name the writer and the reader separately, then ask
whether they are the same volume once the Job's claim is per-agent*) and the first where the two
agree on the path, which is exactly what makes a path-keyed inventory structurally blind to it.
