# Run Transcript Environment Guard

Paperclip applies a default-on defense-in-depth control for agent runtime environment dumps.

## Issue Context

This guard addresses Paperclip issue `PEN-1305`: repeated agent heartbeat transcripts persisted secret-bearing runtime environment variables after agents ran unrestricted environment-inspection commands. The control is intentionally shared by the server heartbeat/run-log path so it applies uniformly across current and future agent adapters.

## Command Policy

- `server/src/agent-shell-guard.ts` classifies full-environment dump commands such as `env`, `printenv`, bare `set`, `export -p`, and `/proc/*/environ` reads as blocked commands.
- Safe name-only inspection must use an allowlisted helper path such as `scripts/safe-env-inspect.mjs`, `safe-env-inspect`, or `paperclip-safe-env`.
- The classifier is shared server policy code for adapter/runtime hooks, but this PR's default-on enforced layer is transcript redaction. Hooks that execute shell commands must wire `classifyAgentShellCommand()` before claiming pre-execution blocking.

## Transcript Redaction

- `compactRunLogChunk()` runs every stdout/stderr chunk through `redactSensitiveText()` before `runLogStore.append()` persists it.
- Secret-bearing env assignment lines are stored with their values replaced by `***REDACTED***`, including bare `KEY=value`, `export KEY=value`, `declare -x KEY="value"`, and NUL-delimited `/proc/*/environ` dump formats for keys ending in `API_KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `JWT`, `PRIVATE_KEY`, `COOKIE`, or `BASE_URL`.
- This applies to new and existing agents automatically because run-log redaction is on the shared heartbeat write path, not in agent configuration.

## Rollout

No operator flag or migration is required. Deploying this version enables persisted-transcript redaction for all heartbeat runs by default. Adapter/runtime command hooks should call `classifyAgentShellCommand()` when adding pre-execution blocking and direct users to the safe env-inspection helper.
