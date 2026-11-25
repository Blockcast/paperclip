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
