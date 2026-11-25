# BLO-20366 — stage large prompts through the Paperclip runtime API

This vendored adapter carries the runtime prompt handoff from
`kkroo/paperclip-adapter-opencode-k8s` commit `9ac390fd7c1283880353fdab7fa480b0fa1c6702`.

The host now stages each rendered run prompt behind a run-scoped Paperclip API
route. Jobs download it with the signed run token through a Secret-backed env
reference, so prompt bodies do not enter Kubernetes Secret data or the Job
manifest. The adapter keeps the compressed prompt Secret path for older hosts
that do not provide `stageRuntimePrompt`.

Blockcast-specific MCP, workspace, runtime-cache, isolation, and Secret
handling changes remain in this tree.
