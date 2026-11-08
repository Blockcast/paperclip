# BLO-54721 — the concurrency guard's unreachable branch writes a pod-stdout line

Tracking: [BLO-54721](https://paperclip.blockcast.net/BLO/issues/BLO-54721)

**Files:** `src/server/execute.ts`, `src/server/execute.test.ts`

When the guard's Job LIST failed or hit its 15s timeout, the run failed with `k8s_concurrency_guard_unreachable` but the only trace was a run-log line, which `kubectl logs` on the worker cannot see. On 2026-11-07 that hid 576 failures on paperclip-0 from log triage (cause turned out to be libuv threadpool starvation, fixed in #3535). The catch now also emits a `claude_k8s.concurrency_guard_unreachable` JSON line on stderr via `console.warn` with companyId, agentId, runId, namespace, errorName and error, following the `claude_k8s.prompt_bundle_projection_refused` precedent. The existing unreachable test asserts the line; renaming the event turns it red.
