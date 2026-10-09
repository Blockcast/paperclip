# PEN-3714 — keep the GitHub egress wrappers ahead of the managed CLI runtime root

`src/server/runtime-pin.ts`, in `buildClaudeCodeRuntimeShell()`: the
adapter-managed Claude Code CLI root
(`<dataMountPath>/.local/lib/paperclip-k8s-runtimes/claude-code/<version>/node_modules/.bin`)
is still prepended to `PATH`, but no longer ahead of
`/usr/local/libexec/paperclip/bin`. When `$PATH` already carries that directory
as a whole entry, the snippet emits it first and the runtime root second;
otherwise it runs the previous bare prepend unchanged. The same file now exports
`IMAGE_WRAPPER_BIN_DIR`, mirroring the constant of the same value in
`job-manifest.ts` (which imports this module, so it cannot be imported the other
way).

Why. PEN-3713 (`pen-3713.md`) made the wrapper directory `PATH[0]` on the Job
env so a write to the shared PVC cannot reach `gh` / `git` /
`github-mcp-server`. The runtime-pin snippet runs later, in the Job's own shell,
so it was the last writer of `PATH` and put the agent-writable runtime root
(on the shared CephFS volume, writable as the Job's uid) back in front of the
root-owned wrappers. The branch is keyed off `$PATH`, not the filesystem, so an
image that predates the wrappers gains no phantom entry. The version pin is
unaffected: the wrapper directory carries no `claude`.

Tests: `src/server/runtime-pin.test.ts` gains a suite that executes the emitted
snippet under `/bin/sh` and asserts the resulting `PATH` (ordering, version pin
surviving, no phantom entry, whole-entry matching).
`src/server/job-manifest.test.ts` updates the assertion that pinned the old bare
prepend to cover both arms of the new branch.
