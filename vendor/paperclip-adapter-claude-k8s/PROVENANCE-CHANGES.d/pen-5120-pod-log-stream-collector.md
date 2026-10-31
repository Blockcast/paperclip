# PEN-5120 — collect the run's transcript from the container log when the server cannot reach the Job volume

New `src/server/pod-log-stream.ts` and `src/server/pod-log-stream.test.ts`; changes to
`src/server/execute.ts`, `src/server/job-manifest.ts`, `src/server/config-schema.ts` and their tests.

The companion to the emit half (`pen-5120-pod-log-stream-framing.md`). That change made the
container stamp `POD_LOG_STREAM_MARKER` on every transcript line and stop discarding the fail-fast
filter's stdout, on a claim the server does not hold. Nothing read it. This change is the reader,
and with it a Job on a foreign claim has a complete stdout path for the first time.

## The transport is selected from the builder's own answer, not re-derived

`buildJobManifest` now returns `podLogStreamedToContainerStdout`, and `execute.ts` reads it. The
prompt-bundle Secret channel re-runs `serverHoldsJobDataClaim` because it must decide BEFORE the
manifest exists; the collector decides after, so it can simply be told. A second derivation here
would be free to drift from the one that shaped the pod command, and the permissive direction of
that drift is a server tailing a file no pod writes — the exact failure PEN-5120 is about. The
drift guard is one assertion: the flag is true **exactly when** the shipped command contains the
marker.

`tailPodLogFile` is untouched and remains the implementation for every run on the server's own
claim. The branch is a ternary at the call site rather than a merged function, so the shared-claim
path keeps its exact code instead of a generalisation of it.

## Four properties, each a test rather than a comment

**The marker is the only accepted frame.** `readNamespacedPodLog` has no usable stream selector
here, so fd 1 and fd 2 arrive interleaved — the agent's own stderr, the launcher preflight and the
wrapper's diagnostics are in the same view as the NDJSON. Anything unmarked is dropped. (The
generated request type does carry a `stream` parameter, but it is honoured only where the
`PodLogsQuerySplitStreams` feature gate is on, and it would still not separate the agent's stderr
from the wrapper's. Framing is not made redundant by it.)

**A stream end is not evidence the run ended.** `@kubernetes/client-node`'s own `Log.log` carries
the comment *"the follow search param still has the stream close prematurely based on my testing"*,
and FAR-10 is the opposite failure — the API holding a connection open indefinitely, which is what
the test harness's never-resolving `mockLogFn` was built to model. So the follow is a loop that
reconnects until `waitForJobCompletion` reports the Job terminal, and a watchdog ends the sink on
that signal rather than waiting for the socket. `Log.log` pipes the response body into the sink
**without forwarding source errors**, so an aborted request leaves the sink un-ended; ending it
ourselves is what turns an abort into a resolution instead of a hang.

**Resume is anchored, so a reconnect cannot silently skip.** `timestamps: true` plus `sinceTime` at
the last accepted line's second. `sinceTime` is second-granular and inclusive, so the replay is a
known SUPERSET of what is already held — and the re-delivered lines are de-duplicated within that
second. The dedup set is cleared when the second advances, so it is bounded by lines-per-second
rather than by run length; a 10 Mi transcript does not grow it. Truncation is downwards for the
same reason: rounding up would convert a guaranteed overlap into a possible gap.

Both reads go through `getLogApi().log`, not `coreApi.readNamespacedPodLog`, and that is forced
rather than stylistic: the generated `CoreV1ApiReadNamespacedPodLogRequest` exposes `sinceSeconds`
but **no `sinceTime`**, so a resume through it could only say "the last N seconds" — a window wrong
by however long the reconnect took.

**Every accepted line is persisted to the server's own `podLogPath`.** That path is rooted at
`SELF_POD_DATA_MOUNT_PATH` — this process's OWN claim — so it is writable whichever claim the Job
mounted. Keeping it populated is what leaves `reapPodLogFile`'s `unlink`, `isReapablePodLogPath`
and `orphaned-run-terminal-result.ts` working unchanged rather than each needing a foreign-claim
branch. A persist failure is reported and non-fatal: the stream is this run's delivery path, the
file is for later readers, and losing the file must not lose the run.

## The 10 Mi rotation bound

Handled explicitly rather than deferred again. While the follow is CONNECTED, the kubelet's 10 Mi
container-log rotation is transparent — its reader rolls over with the file. The only window in
which bytes can be lost is between connections, which is exactly what the anchored resume covers,
bounded by what the node still retains. Each reconnect prints the resume point it used, so a gap is
attributable afterwards instead of silent. Reconnects are bounded (`maxReconnects`, default 50) and
exhausting them degrades to a single non-follow read rather than to nothing.

## The belt-and-braces re-read is skipped on this path, deliberately

Not an optimisation. On the streamed path the file at `podLogPath` is written by this process from
the very accumulator `stdout` came from, so re-reading it cannot add a line — it can only differ by
the trailing newline the file carries and `join("\n")` does not, which would satisfy
`onDisk.length > stdout.length` on **every single run** and print a "tail accumulator < on-disk pod
log" warning that means nothing. The streamed path's own analogue of that re-read is the final
non-follow pass inside `collectPodLogStream`, which exists for the same reason: the trailing
`result` line is written moments before the Job reports Complete, and the follow can be torn down
by the stop signal in between. A terminated pod's log stays readable until the POD is deleted —
which is why this beats `pods/exec`, whose tail dies with the container exactly when that line
matters.

## `enablePerAgentWorkspaceVolume` is surfaced in the config schema

Withheld when the swap landed, because an operator-visible switch for a path that empties every
opted-in run's stdout is a trap. It is added now for the reason that makes it no longer one: the
remaining acceptance — a real run on a foreign claim producing parseable stdout — is unreachable
without a way to opt one agent in. The hint says plainly that nothing has proven it in production,
names the first-run-starts-from-an-empty-workspace consequence, and names the orphan-reader
residual. Default false, pinned by test.

## What this does NOT do

**It does not close PEN-5120.** The first done-when asks for a real run on a foreign claim, and this
is tests and source. What changed is that the failure stopped being structural.

**It does not rescue `orphaned-run-terminal-result.ts`.** That reader recovers a vanished Job's own
terminal verdict from the pod-written `<run>.pod.ndjson` (PEN-2421). The server-persisted copy this
change writes cannot stand in: the orphan case is precisely the one where the process that would
have written it died. Recorded on PEN-5120 and in the plan, not fixed here.

## Verification

`tsc --noEmit` clean; 35 files / 1947 tests green. **9 mutations, 9 caught** — marker filter
removed, dedup removed, final non-follow read removed, resume rounding inverted, reconnect loop
reduced to one pass, partial-line buffering removed, builder flag forced false, the re-read's
streamed-path gate removed, and the transport selection forced to the file tail. Each was applied
through a script that **fails loudly if the pattern did not match or the file did not change** —
the emit half recorded a mutation that passed because it had never applied, and that is the third
occurrence in this issue family.
