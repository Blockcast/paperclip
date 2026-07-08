# Run Transcript Environment Guard

Paperclip applies a default-on defense-in-depth control for agent runtime environment dumps.

## Enforcement

- `server/src/agent-shell-guard.ts` classifies full-environment dump commands such as `env`, `printenv`, bare `set`, `export -p`, and `/proc/*/environ` reads as blocked commands.
- Safe name-only inspection must use an allowlisted helper path such as `scripts/safe-env-inspect.mjs`, `safe-env-inspect`, or `paperclip-safe-env`.
- The guard is shared server code so adapters and runtime hooks can apply the same policy for `opencode_k8s`, `claude_k8s`, and future agent runtimes instead of per-agent opt-in rules.

## Transcript Redaction

- `compactRunLogChunk()` runs every stdout/stderr chunk through `redactSensitiveText()` before `runLogStore.append()` persists it.
- Secret-bearing env assignment lines are stored with their values replaced by `***REDACTED***`, including keys ending in `API_KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `JWT`, `PRIVATE_KEY`, `COOKIE`, or `BASE_URL`.
- This applies to new and existing agents automatically because run-log redaction is on the shared heartbeat write path, not in agent configuration.

## Rollout

No operator flag or migration is required. Deploying this version enables persisted-transcript redaction for all heartbeat runs by default. Adapter/runtime command hooks should call `classifyAgentShellCommand()` when they need pre-execution blocking and direct users to the safe env-inspection helper.
