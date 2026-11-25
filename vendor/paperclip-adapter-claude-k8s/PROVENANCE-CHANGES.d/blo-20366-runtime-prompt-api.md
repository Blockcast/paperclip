# BLO-20366 — run-scoped runtime prompt API handoff

Tracking: [BLO-20366](https://paperclip.blockcast.net/BLO/issues/BLO-20366)

The vendored Claude Kubernetes adapter now accepts the host's optional
`stageRuntimePrompt` callback. The callback stores the rendered prompt in the
Paperclip run-scoped API, and the Job's init container downloads it with the
signed run token. This avoids Kubernetes Secret size limits for large prompts
while retaining the Secret path for older hosts that do not provide the
callback.

Source change: merged upstream adapter commit
`9d529294bddea4041af2d3f4b1c2a44e84134bfc` from
<https://github.com/kkroo/paperclip-adapter-claude-k8s>. The vendored files
retain Blockcast-specific isolation, prompt-bundle, shared-document, MCP, and
credential-boundary changes around the upstream handoff.

## 2. Fix: the runtime-prompt path dropped every other `write-prompt` step

**Files:** `src/server/job-manifest.ts`, `src/server/job-manifest.test.ts`

Production incident 2026-11-25. The first release of this change (deployed 13:45Z, rolled back
14:05Z) failed every `claude_k8s` run with `claude exited 1`:
`mkdir: cannot create directory '/runtime-cache/paperclip-runs/<run>/workspace': Permission denied`.

Cause: the upstream handoff replaces the `write-prompt` command with the downloader
(`["node", "-e", DOWNLOAD_RUNTIME_PROMPT]`), but in this fork that init container is not only the
prompt write. `initCommandParts` also creates the run's isolation roots on the `/runtime-cache`
emptyDir, the Chrome BrowserMetrics link, the tool-child RLIMIT files and the `mcp.json` copy,
and the `claude` container cannot start without them. `initCommandParts` was still being built and
then ignored.

Fix: with a runtime prompt the container runs `sh -c '<every setup step>; exec node -e <downloader>'`.
The downloader is last, so a failed download still fails the init container (exit status
propagates through `exec`). The memory limit is 128Mi for the node process (the opencode adapter
uses the same figure) and stays 64Mi for the busybox paths.

Verified by running the generated command in `node:22-bookworm-slim` as uid 1000 against a stub
endpoint: exit 0 with the prompt written and the setup steps applied, exit 1 when the endpoint
refuses. The new tests fail against the previous command. The opencode adapter is not affected: its
`write-prompt` container only writes the prompt and MCP config.
