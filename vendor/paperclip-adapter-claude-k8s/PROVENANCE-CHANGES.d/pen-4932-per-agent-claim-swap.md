# PEN-4932 stage 4b — swap `dataClaimName` to the per-agent workspace claim

`src/server/job-manifest.ts`, `src/server/execute.ts`, and a new
`src/server/job-manifest.per-agent-claim.test.ts`; five tests added to
`src/server/execute.test.ts`. Outside the adapter: the new key is pinned to agent provenance in
`server/src/services/heartbeat.ts`, with two tests in
`server/src/__tests__/heartbeat-model-profile.test.ts`, and the new
`k8s_agent_workspace_pvc_failed` code is enrolled at both of the sites its
sibling `k8s_concurrency_guard_unreachable` occupies.

That enrolment is not optional bookkeeping. An adapter errorCode that no gate
admits falls through to the `adapter_failed` / `process_lost` tail: never
retried, and billed to the assignee by the productivity review for an
infrastructure fault it had no part in. This repo has been bitten by a partial
application of exactly that three times (#1669, #2159, BLO-17938), so the rule
applied here is to MIRROR the sibling's membership rather than re-derive a
class — both of its sites get the new code, and the set it is absent from
(`TRANSIENT_INFRA_CONTINUATION_ERROR_CODES`) stays absent. The code is
unreachable in production today, which is precisely why it is enrolled now:
an un-enrolled code that becomes reachable later leaves every gate mutually
consistent and green while production emits something none of them admits.

This is the change PEN-4932 exists for. A Job whose agent is opted in stops mounting the one
shared RWX CephFS claim and mounts `agent-workspace-<agentId>` instead, provisioned by
`ensureAgentWorkspacePvc` (#3168) before the Job is built. Distinct claims get distinct CephFS
subvolumes and therefore distinct volume handles; ceph-csi's per-volume lock
(`internal/util/idlocker.go`) keys on the Volume ID, so a wedged `NodeUnstageVolume` — an
uninterruptible kernel `umount` with no timeout — strands **one agent** rather than every agent pod
on the node. That is done-when 1: two agent pods on one node reporting distinct volume IDs.

## Shape

- `resolveAgentWorkspaceClaimName({config, agentId})` — the rollout gate and the name, together.
  Returns `""` for every agent not opted in.
- `resolveDataClaimName` gains one slot: operator `workspaceVolumeClaim` → per-agent claim →
  the server's own PVC → none. The operator claim stays on top because it is an explicit
  instruction about which volume a Job mounts, and the per-agent claim is a default.
- `execute.ts` provisions the claim before `buildJobManifest`, from the SAME pure derivation the
  builder uses. Three independent derivations of a claim name is how a Job ends up mounting a
  claim nothing created; there are now exactly two call sites and one function.

## Default OFF, and it is a ROLLOUT gate

`enablePerAgentWorkspaceVolume`, on the `enableGitHubPublishBroker` precedent. **A per-agent claim
is a fresh, EMPTY volume.** The project checkout, `wt/<companyId>`, the pnpm store and session
state all live on the shared claim and do not travel — the plan accepts that (§5: "a first-run cold
`pnpm` install per agent, and worktrees created by one agent no longer visible to another of the
same company"), but accepting it one agent at a time is not the same act as accepting it for the
whole fleet in one roll, where it would additionally strand whatever uncommitted work sits in
`wt/<companyId>` at that moment. So the flip is per agent through `adapter_config`, and the
fleet-wide default is a later deliberate change rather than a side effect of this one. It also
gives a rollback that needs no code roll.

The key is **pinned to agent provenance** (`AGENT_SCOPE_ONLY_CONFIG_KEYS`, `heartbeat.ts`), on the
list's own stated obligation — it decides what uid runs an init container, and it can fire a
refusal. Both directions are real. Turning it ON for an agent that does not run it moves that run
onto a fresh, empty volume: anyone able to assign an issue could do that once per issue, and the run
would complete "successfully" having thrown away its workspace. Turning it OFF for an agent that
does puts the single uid-0 seeder shape back into the pod in place of the invariant-4 split.
Agent scope — where the rollout happens — is unaffected. No `config-schema.ts` toggle is added:
see the blocker below. An operator-visible switch for a path known to fail every run is a trap, and
it goes in when that blocker closes.

## Fail closed, never fall back

A provisioning failure fails the run with `k8s_agent_workspace_pvc_failed` and creates no Job.
Falling back to the shared claim would quietly restore the node-wide blast radius on exactly the
runs where something is already wrong — and would deliver the prompt bundle for the wrong claim
shape, since `promptBundleNeedsSecretDelivery` is resolved from the claim being refused. Mounting a
claim that does not exist is not an option either: the pod would sit `Pending` on an unbound PVC
with no run-level error to read. The `ReadWriteMany` adoption refusal (#3168) surfaces through the
same code.

## ⛔ Found while writing this: the gate is NOT yet safe to enable

The pod log crosses the volume in the **read** direction, and nothing covered that. Invariant 1
inventoried the trees the SERVER WRITES for the pod; this is the pod writing and the server reading.

`buildPodLogPath` returns two addresses for one file, under a comment that says so outright. The
container writes `containerLogPath` (rooted at `dataMountPath`); `execute.ts` **tails `podLogPath`**
(rooted at `SELF_POD_DATA_MOUNT_PATH`), and that tail is how the run's entire stdout is collected.
Identical strings on the default mount; different VOLUMES once the claim is per-agent. So
`tailPodLogFile` waits 30 s, throws *"Pod log file never appeared at …"*, `Promise.allSettled` turns
that into `stdout = ""`, and the parser has nothing to read.

Three things that look like fallbacks and are not: the belt-and-braces on-disk re-read uses the
same unreachable `podLogPath`; `readPodContainerLogTail` is a 120-line diagnostic; and the
container's stdout carries no NDJSON to read through the Kubernetes log API anyway, because the
pipeline ends `| tee <containerLogPath> | <failFastFilter> > /dev/null`.

Keeping `run-logs` on the server's claim is refused for §2's reason — one surviving bind on the
shared handle preserves the whole node-wide wedge, so it would pay the swap's cost for no
reduction. The candidate remedy is to stop making the log a shared-volume artifact at all: `tee`
the redacted NDJSON to container stdout and consume it with `readNamespacedPodLog`. That replaces
an offset-tracking tail with a stream carrying its own failure modes, so it is a separate change,
and it is the remaining blocker on enablement. Recorded as invariant 5 in the plan.

This does not make the swap unlandable — it makes it inert, which is the posture every other piece
of stage 4b landed in. It does mean nobody should flip the gate yet.

## What the swap turns on downstream

`serverHoldsJobDataClaim` goes false, which is what selects the split seeder shape (invariant 4,
#3165) and routes the prompt bundle onto the Secret channel (invariant 1, #3153/#3157/#3158/#3170).
Those all landed inert ahead of this change precisely so this one is a claim change and nothing
else. The manifest test asserts the predicate flips and that `scopedWritableDirs` empties — the
server must not `mkdir` a foreign Job's tree inside its own volume — that the SPLIT seeder shape is
the one selected (uid-0 `own-volume-root` over one inode, then uid-1000
`seed-writable-dirs`), against a negative control proving the shared claim still gets the single
uid-0 container byte-for-byte — and that the agent container's every `data` mount is still a
`subPath` bind, because §4.1's correction is that a per-agent volume is a *different* volume, not an
empty one, and losing the narrowing would expose the volume root.

## One trap found while testing

`execute.test.ts`'s `vi.mock("./k8s-client.js")` overrides the exported `getCoreApi`, but
`getPvc`/`createPvc` close over k8s-client's own module-scope binding — so mocking `getCoreApi`
leaves them talking to the real cluster. The first draft of these tests issued a live
`readNamespacedPersistentVolumeClaim` and failed on the cluster's 403. They are mocked at the
`getPvc`/`createPvc` level instead.
