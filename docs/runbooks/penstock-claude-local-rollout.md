---
title: Penstock Claude Local Rollout
summary: Controlled Devbox activation for one Paperclip Claude agent
---

# Purpose

This runbook activates the Penstock-routed Claude runtime for exactly one
Paperclip `claude_local` agent on Devbox. The runtime starts a short-lived
Caveman proxy on loopback, points Claude at that proxy, and removes ambient
provider credentials before either child is started.

The first launch is Devbox-only. The Paperclip server image packages the
reviewed binaries, and `Dockerfile.agent` copies the same three assets into the
actual Kubernetes agent overlay. The Helm contract test guards the
shared-volume boundary; neither image activates an agent or installs Ponytail
into the shared `/paperclip/.claude` volume.

## Non-negotiable boundaries

- Do not proceed while `BLO-26540` or `BLO-26695` is unresolved.
- Do not install packages or write runtime state while Devbox is above the
  documented filesystem threshold. The acceptance target is below 85% for
  seven days under normal activity.
- Configure one named agent. Do not bulk-patch a company or an adapter type.
- Store `PENSTOCK_API_KEY` as a Paperclip `secret_ref`. Never put its value in
  an adapter payload, shell history, command argument, image layer, dotfile,
  comment, or runbook.
- Load Ponytail with the selected agent's `extraArgs`:
  `--plugin-dir /opt/penstock/ponytail` (or the approved host-local equivalent).
  Do not run `claude plugin install ... --scope user` from the shared seed
  container.
- Keep Caveman's listener on `127.0.0.1`; do not expose a port, SSH forward, or
  shared proxy endpoint.
- The production Docker build mints a short-lived GitHub App installation token
  from `COMMITPERCLIP_KEY` and `COMMITPERCLIP_APP_ID`, restricted to read-only
  Contents access on `Blockcast/penstock-llm-proxy-core`. Keep that credential
  flow separate from `PAPERCLIP_BOARD_TOKEN`, which remains reserved for the
  `kkroo/*` vendor source. Missing or unauthorized App credentials must fail the
  build; do not substitute a provider key or a broadly scoped token.

# 1. Gate and inventory

Record these values before changing the host or Paperclip:

| Item | Required evidence |
| --- | --- |
| Blockers | `BLO-26540` and `BLO-26695` are `done` |
| Disk | Devbox is below 85% and the retention policy is active |
| Launcher | `scripts/penstock-agent-runtime.mjs` from the approved merged commit |
| Caveman | Reviewed release and architecture-specific checksum |
| Ponytail | Reviewed commit and hook-manifest SHA256 |
| Target | One Paperclip company ID and one agent ID |
| Auth | A board-authenticated Paperclip session and a Penstock API key held outside the command line |

The image's pinned values are the source of truth for packaged deployments.
Inspect the `PENSTOCK_RUNTIME_REF`, `PENSTOCK_RUNTIME_SHA256`,
`CAVEMAN_RELEASE`, `PONYTAIL_REF`, and `PONYTAIL_HOOKS_SHA256` values in
`Dockerfile` when preparing a host-local copy. Do not silently substitute a
branch, `latest`, or an unverified download.

For Kubernetes, verify both image layers after the server build: the server
image must contain `/opt/penstock/bin/penstock-agent-runtime.mjs`,
`/usr/local/bin/caveman-proxy`, and `/opt/penstock/ponytail/`, and the matching
`Dockerfile.agent` overlay must contain the same paths. Building only the
server image does not update the image used by `claude_k8s` Jobs.

Lightweight host checks:

```sh
df -h /
node --version             # Node.js 22 or newer
claude --version
test -x /opt/penstock/bin/penstock-agent-runtime.mjs
test -x /usr/local/bin/caveman-proxy
test -f /opt/penstock/ponytail/.claude-plugin/plugin.json
```

If the paths differ on Devbox, use one versioned, root-owned runtime directory
and carry the same paths into the agent configuration below. Make the launcher
and Caveman executable but non-writable by the Paperclip execution user. Make
the Ponytail tree readable, not writable, by that user.

# 2. Provision the host-local runtime

Provisioning is an operator action after the gates pass. Fetch the launcher
from the approved immutable commit using the authenticated GitHub mechanism
already available on Devbox, then verify the SHA256 recorded in `Dockerfile`.
Fetch Caveman by its pinned release and Ponytail by its pinned git commit;
verify the Caveman checksums and the Ponytail hook-manifest SHA256 before
installing them. A failed verification is a hard stop; the verification
command prints the expected and received digest so an operator can distinguish
a changed upstream artifact from a transient download failure.

The GitHub Actions build uses the same trust boundary. It mints a short-lived
GitHub App installation token from the existing `COMMITPERCLIP_KEY`, restricted
to read-only Contents access on `Blockcast/penstock-llm-proxy-core`, and passes
that token as the BuildKit secret `penstock_runtime_token`. It never repoints or
reuses `gh_token`, and no long-lived Penstock repository token is required.
Before dispatching, verify that `COMMITPERCLIP_KEY` and
`COMMITPERCLIP_APP_ID` are configured and that the App installation can read
the Penstock repository. Token minting and the Dockerfile both fail closed if
that access is absent.

The resulting layout should be equivalent to:

```text
/opt/penstock/bin/penstock-agent-runtime.mjs   0555
/usr/local/bin/caveman-proxy                   0555
/opt/penstock/ponytail/                        read-only tree
```

Do not place `PENSTOCK_API_KEY` in any of these paths. The launcher creates a
0600 temporary Caveman config and 0700 temporary runtime directory for each
run, and removes both during cleanup.

# 3. Create the Paperclip secret

Use the board UI at **Company Settings -> Secrets**, or the documented board
route:

```text
POST /api/companies/{companyId}/secrets
```

Create one managed secret with:

```json
{
  "name": "penstock-anthropic-api-key",
  "key": "PENSTOCK_API_KEY",
  "value": "<supplied through the authenticated secret-entry flow>"
}
```

Enter the value through a protected prompt or approved vault integration. Do
not put the value in a JSON file tracked by Git, a command argument, or a
clipboard shared with the agent. Record only the returned Paperclip secret ID;
the API never needs the plaintext again for this configuration.

Before continuing, confirm that the secret is active and company-scoped. The
agent binding will use:

```json
{
  "type": "secret_ref",
  "secretId": "<paperclip-secret-id>",
  "version": "latest"
}
```

# 4. Configure one `claude_local` agent

Pause the selected agent while editing its configuration. Read its current
`adapterConfig` first and merge the fields below; `PATCH /api/agents/{id}`
persists the effective adapter configuration, so replacing the object blindly
can remove an existing prompt, workspace, or permission policy.

The required shape is:

```json
{
  "adapterType": "claude_local",
  "adapterConfig": {
    "engine": "cli",
    "command": "/opt/penstock/bin/penstock-agent-runtime.mjs",
    "cwd": "/opt/paperclip/workspaces/<agent-id>",
    "extraArgs": [
      "--plugin-dir",
      "/opt/penstock/ponytail"
    ],
    "env": {
      "PENSTOCK_API_KEY": {
        "type": "secret_ref",
        "secretId": "<paperclip-secret-id>",
        "version": "latest"
      },
      "PENSTOCK_PROVIDER": {
        "type": "plain",
        "value": "anthropic"
      },
      "PENSTOCK_BASE_URL": {
        "type": "plain",
        "value": "https://api.penstock.run"
      },
      "PENSTOCK_AGENT_COMMAND": {
        "type": "plain",
        "value": "/usr/local/bin/claude"
      },
      "PENSTOCK_CAVEMAN_COMMAND": {
        "type": "plain",
        "value": "/usr/local/bin/caveman-proxy"
      },
      "PONYTAIL_DEFAULT_MODE": {
        "type": "plain",
        "value": "full"
      },
      "CLAUDE_CONFIG_DIR": {
        "type": "plain",
        "value": "/opt/paperclip/agents/<agent-id>/.claude"
      }
    }
  }
}
```

`<agent-id>` is a placeholder, not a literal shared directory. Create the
selected agent's `cwd` and `CLAUDE_CONFIG_DIR` with mode 0700 and ownership
limited to the Paperclip execution user. Keep `CLAUDE_CONFIG_DIR` explicitly
per-agent for this rollout. Do not omit it and rely on the adapter's managed
default: Ponytail may otherwise resolve state under the shared
`/paperclip/.claude` tree. If non-persistent state is required later, use an
adapter-supported per-run private directory and verify its ownership before
enabling it.

The launcher receives Claude's normal Paperclip-generated CLI arguments. It
adds the two Ponytail arguments as configured above, starts Caveman with
`serve`, validates `/health/ready` and its identity response, then sets
Claude's provider base URL to the ephemeral loopback listener. The Penstock
key is therefore available only in the child process environment for that run.

After the patch, verify the returned configuration shows one target agent and
the secret reference object, never a resolved value. Keep the agent paused
until the environment test is ready.

# 5. Prove the runtime and perform one smoke run

First use Paperclip's **Test Environment** action for the selected agent. With
the wrapper command above, this action proves the working directory and
executable resolution and confirms the explicit CLI engine. The generic
`claude_local` environment probe deliberately skips its normal Claude hello
probe when `command` is not named `claude`; it does not start Caveman or prove
that Caveman accepts the `.json` config. A passing result here is necessary but
not sufficient.

Before resuming the agent, run this one-time, no-provider-credential smoke on
Devbox. It is specifically required because the launcher uses a `.json` config
path and the real Caveman binary, rather than the launcher test double, must
accept that path:

```sh
set -eu
CAVEMAN=/usr/local/bin/caveman-proxy
ROOT="$(mktemp -d)"
PID=""
cleanup() {
  if [ -n "${PID}" ] && kill -0 "${PID}" 2>/dev/null; then
    kill "${PID}" 2>/dev/null || true
    wait "${PID}" 2>/dev/null || true
  fi
  rm -rf "${ROOT}"
}
trap cleanup EXIT INT TERM
mkdir -m 700 "${ROOT}/home"

for attempt in 1 2 3; do
  PORT="$(node -e 'const net=require("node:net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p));});')"
  CONFIG="${ROOT}/caveman.json"
  cat > "${CONFIG}" <<EOF
{"mode":"record","listen":"127.0.0.1:${PORT}","providers":{"anthropic":{"base_url":"https://api.penstock.run"},"openai":{"base_url":"https://api.penstock.run"}}}
EOF
  : > "${ROOT}/caveman.log"
  CAVEMAN_CONFIG="${CONFIG}" CAVEMAN_HOME="${ROOT}/home" \
    "${CAVEMAN}" serve >"${ROOT}/caveman.log" 2>&1 &
  PID=$!
  for tick in $(seq 1 150); do
    BODY="$(curl --noproxy '*' --silent --show-error --connect-timeout 1 --max-time 1 \
      "http://127.0.0.1:${PORT}/health/ready" 2>/dev/null || true)"
    if printf '%s' "${BODY}" | jq -e \
      '.ok == true and .service == "caveman-proxy" and .schema == "caveman.proxy.health.v1" and .billing == "byok" and (.adapters | numbers) > 0' \
      >/dev/null 2>&1; then
      echo "real Caveman accepted caveman.json and passed readiness"
      exit 0
    fi
    if ! kill -0 "${PID}" 2>/dev/null; then break; fi
    sleep 0.1
  done
  kill "${PID}" 2>/dev/null || true
  wait "${PID}" 2>/dev/null || true
  PID=""
done
cat "${ROOT}/caveman.log" >&2
exit 1
```

Record the successful attempt, binary version, architecture, config path
extension, and readiness response shape. Do not attach the full log if it
contains provider routing details; confirm only that it contains no secrets.

After that smoke passes, resume the agent and run one non-destructive, small
task. Capture the Paperclip run ID and config revision. Check the run metadata
and logs for:

- `PENSTOCK_BASE_URL=https://api.penstock.run` at the configuration level;
- an ephemeral `127.0.0.1` Caveman route at runtime;
- no Penstock key, provider key, or Paperclip token in stdout, stderr, command
  arguments, or the persisted config;
- successful cleanup after both success and an intentionally cancelled test.

Do not use a production-mutating prompt for the first run. A provider request
may still incur normal billing; set the agent/company budget before resuming.

# 6. Rollback

1. Pause the selected agent and wait for any active run to terminate.
2. Restore the prior `adapterConfig` using the recorded config revision, or
   patch `command` back to the ordinary Claude executable and remove the
   Penstock env bindings and Ponytail `extraArgs`.
3. Confirm no new run starts, then remove only the host-local runtime files if
   they are no longer needed.
4. Leave the Paperclip secret record intact for audit, or rotate/disable it
   through the Secrets UI if the key may have reached an unintended process.

Never delete a shared `/paperclip/.claude` tree as part of this rollback.

# Evidence record

Attach or comment the following non-secret evidence on the rollout issue:

- approved launcher commit and SHA256;
- Caveman release, architecture, and SHA256;
- Ponytail commit and hook-manifest SHA256;
- company ID, selected agent ID, and config revision;
- environment-test result and one smoke run ID;
- confirmation that logs contained no credential values;
- rollback revision and operator.

Do not attach secret values, raw secret payloads, provider cookies, or complete
environment dumps.
