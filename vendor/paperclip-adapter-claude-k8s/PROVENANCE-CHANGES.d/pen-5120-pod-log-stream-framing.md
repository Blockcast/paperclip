# PEN-5120 — frame the pod log onto container stdout when the server cannot reach the Job volume

`src/server/job-manifest.ts`, `src/server/pod-log-redactor.ts`, `src/server/execute.ts`, and a new
`src/server/job-manifest.pod-log-stream.test.ts`.

`buildPodLogPath` returns **two absolute addresses for one file**, under a comment that states the
premise outright: the server and the pod mount the *same volume* at different roots. The container
writes `containerLogPath`; `execute.ts` tails `podLogPath`, and that tail is how the run's **entire
stdout** is collected. PEN-4932's per-agent claim removes the premise, and `tailPodLogFile` then
waits 30 s, throws *"Pod log file never appeared"*, `Promise.allSettled` turns that into
`stdout = ""`, and the parser has nothing to read — every run of the opted-in agent fails.

This change gives the transcript a second exit from the pod that assumes no shared volume: the
fail-fast `awk`, which already sees every line, stops discarding its stdout and stamps each line
with `POD_LOG_STREAM_MARKER`. Nothing consumes it yet — the server-side collector is the next
change — so this is inert in exactly the sense #3153/#3157/#3158 and #3170 were.

## Why the stream needs framing at all

The Kubernetes log API has **no stream selector**: `readNamespacedPodLog` serves one interleaved
view of fd 1 and fd 2. `parse.ts` already records that interleaving as the reason
`readPodContainerLogTail` must stay confined to diagnostics. So the agent's stderr, the launcher
preflight and the wrapper's own messages all arrive mixed into the NDJSON, and redirecting the
other writers to stderr would not help — stderr is in the same view. A per-line prefix is what
makes the transcript separable again.

It is a **prefix added downstream of `tee`**, so the FILE keeps today's bytes exactly. That is
load-bearing, not incidental: `orphaned-run-terminal-result.ts` and the belt-and-braces re-read
both parse that file as one JSON object per line.

Nine bytes, chosen against the kubelet's 10 Mi container-log rotation default — ~450 KiB on a
50k-line transcript. Rotation is a real bound on the *consumer* and is called out in PEN-5120's
done-when; it is not addressed here, because nothing reads this yet.

## The fleet command is byte-identical, and that is asserted rather than argued

Both halves are conditional on `!serverHoldsJobDataClaim`, the same predicate the prompt-bundle
channel uses. The negative control asserts the literal pipeline tail (`{ print; fflush() }` and a
trailing `> /dev/null`), not merely the absence of the marker: the marker could be absent while the
sink was still dropped, and that mutation would put a 10 Mi transcript into every node's container
log on every run in the fleet. Both directions of the gate, both halves independently, the marker
itself, and the diagnostic filter are mutation-checked — 7 mutations, 7 caught.

One of those mutations **passed on first attempt** and the pattern had simply not matched the
source. It is recorded here because the lesson is the one #3170 already paid for once: a passing
mutation check is a finding about the tests only if you have confirmed the mutation applied.

## The emptyDir branch is reachable without the 4b swap

`dataClaimName === ""` — a deployment whose server has no PVC — also reports false, so it takes
the stream path today. That is a fix, not a widening, and it is the same call the prompt-bundle
Secret channel already makes for the same branch: such a pod writes its log to an emptyDir the
server cannot read either, so the tail is already collecting nothing. Pinned by its own test,
because it is the only branch here that is live before PEN-4932'''s gate is enabled for anyone.

## The redactor fails CLOSED on this path, and only on this path

`buildPodLogRedactorSetupShell` fails **open** — a lost race, an unwritable volume or a missing
`node` degrades the filter to `cat` rather than taking every run in the fleet down through
`set -o pipefail`. That is right while the pod log's only home is a file on a volume the control
plane already owns.

It is not right once the same stream is also on the container's stdout, which the node holds and
anything scraping the cluster can read. Falling open there does not degrade to "today's behaviour";
it publishes the transcript somewhere it has never been. So the new `failClosedOnFallOpen` option
makes that one branch `exit 1`, by name, **after** writing the existing stderr line and the
`<podLogPath>.unredacted` sentinel — the forensic record of *why* is identical in both modes.

This does not weaken the fleet guarantee it appears to contradict: the option is passed only when
the server cannot reach the Job's volume, which no agent does until PEN-4932's gate is enabled.

The refusal message is interpolated into a single-quoted `echo`, so one apostrophe in it would end
the string and leave the rest of the line to be re-parsed as shell — syntactically valid, silently
mangled, on a branch that only runs when something else has already failed. The first draft carried
exactly that apostrophe. A test now pins the message, and pins quote parity over the redactor
fragment rather than over the whole rendered command. Whole-command parity is not an invariant of a
*valid* command: POSIX single-quote escaping renders an apostrophe as `'\''`, so a quoted argument
containing one contributes an odd number of quote characters while staying well-formed, and the
first such argument anywhere in the fixture would have failed the check on correct code.

## The failure diagnostic had to learn about the marker

`extractContainerLogDiagnostic` keeps the last five non-empty lines of a 120-line tail. On this path
those last lines are the transcript — long, and enough to push the actual error out of the window,
so the diagnostic would report the run's *output* instead of its *error* precisely when the caller
needs the error. Marked lines are dropped before the last-five cut. For a container log carrying no
marked line the predicate is a no-op, which is its own negative control.

That rescues the error from the last-five cut and **not** from the 120-line one above it: the
`tailLines: 120` bound is applied by the Kubernetes log API, so the filter never sees anything
older. On a foreign claim a long enough transcript can therefore fill the whole window and carry an
early failure — a launcher preflight error followed by output — off the end before the filter runs.
Raising `tailLines` on the stream path, or taking the diagnostic from the collector's de-framed
stderr instead, belongs with the collector; the bound is stated here rather than left implicit.

## What this does NOT do

No server-side consumer. The run's stdout still comes from `tailPodLogFile`, so on a foreign claim
it is still empty — PEN-5120 is not closed by this change and PEN-4932's gate must stay off. The
10 Mi rotation bound, reconnect/resume, and persisting the stream back to the server's own
`podLogPath` all belong to the collector.

Nor does it rescue `orphaned-run-terminal-result.ts`, which reads the pod-written
`<run>.pod.ndjson` from the server's `run-logs` tree to recover a vanished Job's own verdict
(PEN-2421). On a foreign claim that artifact is unreachable, and a server-persisted copy cannot
replace it: the orphan case is precisely the one where the process that would have written it died.
That is a second pod→server read-direction consumer, recorded on PEN-5120 rather than fixed here.
