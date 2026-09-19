---
title: Penstock Kubernetes Agent Rollout
summary: Controlled Caveman and Ponytail rollout for claude_k8s and opencode_k8s
---

# Scope

This runbook covers the Kubernetes-only rollout of the Penstock agent launcher
and Ponytail for Paperclip's `claude_k8s` and `opencode_k8s` adapters. It does
not activate either feature fleet-wide, install a plugin into a shared volume,
or authorize a live payment. The first deployment is one non-production Job.

The path for one run is:

```text
Paperclip worker
  -> adapter Job
  -> /opt/penstock/bin/penstock-agent-runtime.mjs
  -> 127.0.0.1:<ephemeral-port>/health/ready
  -> /usr/local/bin/caveman-proxy
  -> https://api.penstock.run
```

The launcher owns the short-lived Caveman process and temporary files. The
adapter owns the Kubernetes Job and cleanup. Ponytail changes the selected
agent's behavior; it is not a provider credential or a shared transport.

The adapter/provider scope is deliberately limited to `claude_k8s` and
`opencode_k8s` using the reviewed Penstock launcher. The native local adapter
is not part of this rollout.

## Hard boundaries

- Use only `claude_k8s` or `opencode_k8s`. Do not configure the retired local
  adapter path in this rollout.
- Configure one named non-production agent and pause it during changes. Do not
  bulk-patch a company, adapter type, or fleet default.
- `PENSTOCK_API_KEY` is a worker-only Kubernetes Secret binding. It must not be
  in `env.extra`, the API Deployment, an adapter payload, a command argument,
  an image layer, a checked-in file, or a log.
- Caveman must bind to IPv4 loopback only. Do not expose, forward, or share its
  listener between Jobs.
- Keep Caveman in `mode: record` for this rollout. Compression or retention
  changes require a separate measured review and recovery test.
- Do not claim an Anthropic canary until the Penstock allocation is verified
  for the selected org, provider, and BYOS node. A prior attempt failed closed
  with `allocation_missing` for `org_penstock` / `anthropic` on
  `blockcast-sfo12`; that is an allocation gate, not a reason to add a raw
  provider key.
- Do not treat a green image build as activation. Image packaging, adapter
  configuration, readiness, one canary, and cleanup evidence are separate
  gates.

## 1. Preflight and pinned assets

Record the following before changing the release or agent:

| Item | Required evidence |
| --- | --- |
| Adapter code | The OpenCode adapter change is reviewed and merged, and the Claude adapter vendor update is included in the image source |
| Image | The exact server and agent image digests to test; both contain the runtime assets |
| Launcher | `PENSTOCK_RUNTIME_REF` and `PENSTOCK_RUNTIME_SHA256` from `Dockerfile` |
| Caveman | `CAVEMAN_RELEASE`, architecture-specific checksum, and `caveman-proxy version` output |
| Ponytail | `PONYTAIL_REF`, plugin identity, and `PONYTAIL_HOOKS_SHA256` |
| Secret | Worker Secret name/key and a successful non-secret reference check |
| Target | One company, one agent, one environment, and one provider allocation |
| Canary | A non-production namespace or explicitly labeled test Job |

The current packaging pins are intentionally inspectable in `Dockerfile`:

```text
PENSTOCK_RUNTIME_REF=9878ca2499ea8a8e24ec7d8bcf3222db65ac014a
CAVEMAN_RELEASE=bin-v1.1.6
PONYTAIL_REF=0a4dd63ad4541f4f655c4108a295916f3c1d8fda
```

The launcher path is:

```text
/opt/penstock/bin/penstock-agent-runtime.mjs
```

The Caveman path is:

```text
/usr/local/bin/caveman-proxy
```

The packaged Ponytail paths are adapter-specific:

| Adapter | `ponytailPluginPath` | Loading mechanism |
| --- | --- | --- |
| `claude_k8s` | `/opt/penstock/ponytail` | Claude `--plugin-dir` |
| `opencode_k8s` | `/opt/penstock/ponytail/.opencode/plugins/ponytail.mjs` | Generated OpenCode config `plugin` entry |

Verify the exact image layers before creating an agent config:

```sh
kubectl -n <test-namespace> run asset-check --rm -i --restart=Never \
  --image=<exact-agent-image> --command -- sh -c '
    test -x /opt/penstock/bin/penstock-agent-runtime.mjs &&
    test -x /usr/local/bin/caveman-proxy &&
    test -f /opt/penstock/ponytail/.claude-plugin/plugin.json &&
    test -f /opt/penstock/ponytail/.opencode/plugins/ponytail.mjs
  '
```

Use an image digest, not `latest` or a mutable branch tag. If the test image
does not contain all four paths, stop and fix the image/overlay build.

## 2. Bind the worker-only Secret

The Helm chart's `worker.extraEnv` is the only approved location for the
shared Penstock org credential. The chart rejects `PENSTOCK_API_KEY` in the
shared `env.extra` block because that block is rendered on the API Deployment.

Create or verify the Secret out of band, without printing its value:

```sh
kubectl -n paperclip get secret paperclip-penstock-org-key \
  -o jsonpath='{.data.token}' | base64 -d | wc -c
```

The production values shape is:

```yaml
worker:
  extraEnv:
    - name: PENSTOCK_API_KEY
      valueFrom:
        secretKeyRef:
          name: paperclip-penstock-org-key
          key: token
```

Apply the Helm change only to the test release first. Confirm:

```sh
helm template paperclip deploy/helm/paperclip \
  -f deploy/helm/paperclip/values.blockcast.yaml \
  --namespace paperclip > /tmp/paperclip-rendered.yaml
grep -n 'PENSTOCK_API_KEY' /tmp/paperclip-rendered.yaml
```

The reference may appear in the worker StatefulSet, but must not appear in the
API Deployment. Do not attach the rendered file to an issue if it contains
other secret references.

The Job receives the Secret reference through `valueFrom`; the resolved value
must never be visible in the adapter configuration or Job manifest.

Note what the adapter actually does with worker env, because it is broader than
a `PENSTOCK_API_KEY` carve-out: `getSelfPod` copies **every** non-empty literal
env entry off the worker's main container into `inheritedEnv`, and every
`valueFrom` entry into `inheritedEnvValueFrom`. There is no name allowlist or
denylist. So any non-secret `PENSTOCK_*` tunable added to `worker.extraEnv`
reaches every agent Job — this is the supported way to set a fleet-wide
launcher default without editing each agent's `adapterConfig` (see
`PENSTOCK_READY_TIMEOUT_MS`, BLO-33279). Per-agent `adapterConfig.env` is
layered after inheritance and still wins for a single agent.

Because inheritance is unfiltered, treat the worker container env as the
blast radius: never put a credential there as a literal value.

## 3. Configure one test agent

Pause the selected agent and merge these fields into its existing
`adapterConfig`. Preserve its current model, workspace, permissions, service
account, and other settings. Do not replace the whole object blindly.

Claude example:

```json
{
  "adapterType": "claude_k8s",
  "adapterConfig": {
    "agentCommand": "/opt/penstock/bin/penstock-agent-runtime.mjs",
    "ponytailPluginPath": "/opt/penstock/ponytail",
    "ponytailDefaultMode": "full",
    "env": {
      "PENSTOCK_BASE_URL": "https://api.penstock.run",
      "PENSTOCK_PROVIDER": "anthropic",
      "PENSTOCK_CAVEMAN_COMMAND": "/usr/local/bin/caveman-proxy"
    }
  }
}
```

OpenCode example:

```json
{
  "adapterType": "opencode_k8s",
  "adapterConfig": {
    "agentCommand": "/opt/penstock/bin/penstock-agent-runtime.mjs",
    "ponytailPluginPath": "/opt/penstock/ponytail/.opencode/plugins/ponytail.mjs",
    "ponytailDefaultMode": "full",
    "env": {
      "PENSTOCK_BASE_URL": "https://api.penstock.run",
      "PENSTOCK_PROVIDER": "openai",
      "PENSTOCK_CAVEMAN_COMMAND": "/usr/local/bin/caveman-proxy"
    }
  }
}
```

Do not add `PENSTOCK_API_KEY` to either object. The worker environment is
resolved by the adapter's allowlist and forwarded as a Secret-backed Job env
entry. `PENSTOCK_PROVIDER` must match a verified Penstock allocation. For
OpenCode, the launcher receives `PENSTOCK_AGENT_COMMAND=opencode` by default;
for Claude it receives `PENSTOCK_AGENT_COMMAND=claude`. `PONYTAIL_DEFAULT_MODE`
may be supplied as a non-secret environment preference; the adapter's
`ponytailDefaultMode` field is the preferred per-agent form and an explicit
environment value wins.

The adapters reject launcher values containing arguments or shell syntax. Keep
all native CLI arguments in the adapter's existing `extraArgs` field. The
Claude adapter passes the plugin directory with `--plugin-dir`; the OpenCode
adapter writes the `.mjs` path into the generated OpenCode config.

## 4. Readiness and smoke checks

Run the Paperclip environment test for the selected agent. This checks Job
creation prerequisites and image/executable resolution; it does not by itself
prove that the real Caveman binary accepted the generated configuration.

Before resuming heartbeats, run one non-destructive test Job. Confirm the
launcher reaches `GET http://127.0.0.1:<ephemeral-port>/health/ready` and that
the response satisfies every field below:

```json
{
  "ok": true,
  "service": "caveman-proxy",
  "schema": "caveman.proxy.health.v1",
  "billing": "byok",
  "adapters": 1
}
```

`adapters` may be greater than one; it must be a positive safe integer. A
redirect, a non-loopback address, missing identity field, or non-`byok`
billing value is a hard failure.

Capture only non-secret evidence:

- Paperclip run ID, image digest, adapter type, provider, and config revision;
- readiness response shape and the ephemeral loopback port (not credentials);
- the launcher/Caveman/Ponytail versions and checksums;
- proof that the plugin loaded at the adapter-specific path;
- successful completion cleanup and a separately cancelled-run cleanup;
- confirmation that logs, arguments, Job YAML, and persisted config contain no
  Penstock key, provider key, Paperclip token, or secret value.

The launcher creates a 0700 temporary runtime directory, a 0600
`caveman.json`, and a temporary Caveman home for each run. It removes them on
success, child failure, proxy failure, and signal cancellation. Do not claim
that this removes Paperclip's own transcript or run-log retention.

## 5. Provider allocation gate

Before any provider request, verify an allocation for the exact tuple:

```text
org:      <Penstock org>
provider: <anthropic or openai>
node:     <BYOS node or managed route>
```

A canary with an unallocated provider is not a valid wiring test and must not
be retried with a raw upstream key. Resolve the allocation or choose a
provider with a documented, verified allocation, then record the allocation
check ID and timestamp. Keep the canary task small and non-mutating; normal
provider billing may still apply.

## 6. Cleanup and rollback

After the canary:

1. Pause the test agent and wait for the Job to terminate.
2. Confirm completed and cancelled Jobs, their per-run Secrets, and temporary
   runtime files are cleaned according to the adapter policy.
3. Restore the previous `adapterConfig` from its recorded revision, or remove
   only the launcher/plugin fields.
4. Leave the worker Secret managed and auditable; rotate or disable it through
   the approved secret process if exposure is suspected.
5. Do not delete the shared `/paperclip` or any shared Claude/OpenCode config
   tree as part of rollback.

No production heartbeat may be resumed if the canary leaves a Job, Secret,
temporary file, provider credential, or log-redaction finding unresolved.

## Evidence checklist

Attach non-secret evidence to the rollout issue:

- exact image digests and the four asset-path checks;
- adapter type and selected agent/company IDs;
- worker Secret name and key only, never its value;
- provider allocation tuple and verification timestamp;
- readiness identity response and run IDs;
- adapter-specific Ponytail load confirmation;
- cleanup/cancellation results and secret-free log review;
- rollback revision and operator.

Do not attach environment dumps, raw Secret objects, provider cookies,
`caveman.json`, prompt contents, or complete unredacted logs.
