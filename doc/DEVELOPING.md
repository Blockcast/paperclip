# Developing

This project can run fully in local dev without setting up PostgreSQL manually.

## Deployment Modes

For mode definitions and intended CLI behavior, see `doc/DEPLOYMENT-MODES.md`.

Current implementation status:

- canonical model: `local_trusted` and `authenticated` (with `private/public` exposure)

## Prerequisites

- Node.js 20+
- pnpm 9+

## Dependency Lockfile Policy

GitHub Actions owns `pnpm-lock.yaml`.

- Do not commit `pnpm-lock.yaml` in pull requests.
- Pull request CI validates dependency resolution when manifests change.
- Pushes to `master` regenerate `pnpm-lock.yaml` with `pnpm install --lockfile-only --no-frozen-lockfile`, commit it back if needed, and then run verification with `--frozen-lockfile`.

## Start Dev

From repo root:

```sh
pnpm install
pnpm dev
```

This starts:

- API server: `http://localhost:3100`
- UI: served by the API server in dev middleware mode (same origin as API)

`pnpm dev` runs the server in watch mode and restarts on changes from workspace packages (including adapter packages). Use `pnpm dev:once` to run without file watching.

`pnpm dev:once` auto-applies pending local migrations by default before starting the dev server.

`pnpm dev` and `pnpm dev:once` are now idempotent for the current repo and instance: if the matching Paperclip dev runner is already alive, Paperclip reports the existing process instead of starting a duplicate.

Issue execution may also use project execution workspace policies and workspace runtime services for per-project worktrees, preview servers, and managed dev commands. Configure those through the project workspace/runtime surfaces rather than starting long-running unmanaged processes when a task needs a reusable service.

## Storybook

The board UI Storybook keeps stories and Storybook config under `ui/storybook/` so component review files stay out of the app source routes.

```sh
pnpm storybook
pnpm build-storybook
```

These run the `@paperclipai/ui` Storybook on port `6006` and build the static output to `ui/storybook-static/`.

The Storybook visual regression suite uses external PNG baselines instead of
committed screenshots:

```sh
pnpm test:storybook-visual
pnpm test:storybook-visual:update
```

`pnpm test:storybook-visual` downloads and verifies the baseline archive from
`tests/storybook-visual/baseline-manifest.json` before running Playwright.
Accepted visual changes should update the manifest metadata and publish a new
immutable archive with `pnpm storybook-visual:baseline pack` and
`pnpm storybook-visual:baseline upload`; do not commit generated PNG snapshots.

Known limitation: Storybook visual baselines are Linux/Ubuntu-only. The manifest
pins the capture environment to `ubuntu-24.04` and the Playwright suite uses
pixel-exact comparison, so local runs on macOS, Windows, or other non-matching
platforms can report false-positive diffs from font rasterization and subpixel
rendering. Use the `Storybook Visual` GitHub Actions workflow on `ubuntu-latest`
as the source of truth, or run locally in a matching Linux environment before
accepting or updating baselines.

PR visual checks are opt-in while the suite stabilizes. Add the
`storybook-visual` label to a PR, or run the `Storybook Visual` GitHub Actions
workflow manually, to produce downloadable Playwright report/test-result
artifacts. Normal PR visual runs use read-only repository permissions and do not
upload or mutate baseline objects.

## UI Fonts And Screenshots

The board UI ships its own sans-serif webfont assets in `ui/public/fonts/`.
`ui/src/index.css` declares Inter v4.1 variable regular and italic faces and wires
the Tailwind `font-sans` token to those bundled files before system fallbacks.
Linux screenshot or Storybook capture jobs should not install host Inter packages
or inject external font CSS to make Paperclip text render correctly.

Font assets live in Vite's public directory so `pnpm --filter @paperclipai/ui build`
emits them under `ui/dist/fonts/`. The server package copies the same output into
`server/ui-dist/fonts/` through `scripts/prepare-server-ui-dist.sh`.

Inspect or stop the current repo's managed dev runner:

```sh
pnpm dev:list
pnpm dev:stop
```

`pnpm dev:once` now tracks backend-relevant file changes and pending migrations. When the current boot is stale, the board UI shows a `Restart required` banner. You can also enable guarded auto-restart in `Instance Settings > Experimental`, which waits for queued/running local agent runs to finish before restarting the dev server.

## Hot-Restart Deploys

Primary-instance rebuilds that restart `paperclip.service` can request one-shot live-run adoption instead of using the normal graceful shutdown drain. Before restarting the service, write the marker from the newly staged app with the current service PID:

```sh
old_main_pid="$(systemctl show paperclip.service -p MainPID --value)"
pnpm --filter @paperclipai/server exec tsx ../scripts/request-hot-restart.ts --server-pid "$old_main_pid"
systemctl restart paperclip.service
```

Use `--drain-required` only when the deploy intentionally requires the old terminate-and-retry behavior. Without that flag, the old server verifies that the marker targets its own PID, snapshots currently running heartbeat run IDs and child PIDs, and skips the shutdown drain so eligible detached local-agent processes can keep running. On startup the new server writes `$PAPERCLIP_HOME/hot-restart-report.json` with `previousServerPid`, `newServerPid`, `previousServerVersion`, `newServerVersion`, `adoptedRunIds`, `finalizedWhileDownRunIds`, `lostRunIds`, and per-run classifications before the normal orphan reaper runs.

A healthy guarded deploy must compare the report against `/api/health` (`version` or `serverVersion`) and treat any `lostRunIds` entry as a continuity failure that needs recovery before marking deployment complete.

Tailscale/private-auth dev mode:

```sh
pnpm dev --bind lan
```

This runs dev as `authenticated/private` with a private-network bind preset.
On a fresh authenticated/private instance, open the app, sign in or create an
account, and use the setup screen to claim the first instance admin from the
browser. The CLI fallback remains:

```sh
pnpm paperclipai auth bootstrap-ceo
```

For Tailscale-only reachability on a detected tailnet address:

```sh
pnpm dev --bind tailnet
```

Legacy aliases still map to the old broad private-network behavior:

```sh
pnpm dev --tailscale-auth
pnpm dev --authenticated-private
```

Allow additional private hostnames (for example custom Tailscale hostnames):

```sh
pnpm paperclipai allowed-hostname dotta-macbook-pro
```

## Test Commands

Use the cheap local default unless you are specifically working on browser flows:

```sh
pnpm test
```

`pnpm test` runs the Vitest suite only. For interactive Vitest watch mode use:

```sh
pnpm test:watch
```

Browser suites stay separate:

```sh
pnpm test:e2e
pnpm test:release-smoke
```

These browser suites are intended for targeted local verification and CI, not the default agent/human test command.

For normal issue work, start with the smallest targeted check that proves the change. Reserve repo-wide typecheck/build/test runs for PR-ready handoff or changes broad enough that narrow checks do not cover the risk.

## One-Command Local Run

For a first-time local install, you can bootstrap and run in one command:

```sh
pnpm paperclipai run
```

`paperclipai run` does:

1. auto-onboard if config is missing
2. `paperclipai doctor` with repair enabled
3. starts the server when checks pass

## Docker Quickstart (No local Node install)

Build and run Paperclip in Docker:

```sh
docker build -t paperclip-local .
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

Or use Compose:

```sh
docker compose -f docker/docker-compose.quickstart.yml up --build
```

See `doc/DOCKER.md` for API key wiring (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) and persistence details.

## Docker For Untrusted PR Review

For a separate review-oriented container that keeps `codex`/`claude` login state in Docker volumes and checks out PRs into an isolated scratch workspace, see `doc/UNTRUSTED-PR-REVIEW.md`.

## Local Instance Layout

Every local install keeps runtime state directly under the selected instance root:

```text
~/.paperclip/instances/default/                  # instance root
  config.json                                    # runtime config
  .env                                           # instance env file
  db/                                            # embedded PostgreSQL data
  data/
    storage/                                     # local_disk uploads
    backups/                                     # automatic DB backups
  logs/
  secrets/master.key                             # local_encrypted master key
  workspaces/<agent-id>/                         # default agent workspaces
  projects/                                      # project execution workspaces
  companies/<company-id>/codex-home/             # per-company codex_local home
```

`PAPERCLIP_HOME` and `PAPERCLIP_INSTANCE_ID` override the home root and instance id respectively. `paperclipai onboard` echoes the resolved values in its banner (`Local home: <home> | instance: <id> | config: <path>`) so you can confirm where state will land before continuing.

## Database in Dev (Auto-Handled)

For local development, leave `DATABASE_URL` unset.
The server will automatically use embedded PostgreSQL and persist data at:

- `~/.paperclip/instances/default/db`

Override home or instance:

```sh
PAPERCLIP_HOME=/custom/path PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```

No Docker or external database is required for this mode.

## Storage in Dev (Auto-Handled)

For local development, the default storage provider is `local_disk`, which persists uploaded images/attachments at:

- `~/.paperclip/instances/default/data/storage`

Configure storage provider/settings:

```sh
pnpm paperclipai configure --section storage
```

## Optional ccrotate-serve active verifier (ccrotate tier-gate)

The ccrotate tier-gate can active-verify a stale cache snapshot against a
live `ccrotate-serve` HTTP probe before denying a heartbeat for "no usable
account". Without it, a `ccrotate refresh` cron that throws false-flag
"exhausted" labels (e.g. per-org Usage API throttling) leaves the gate
denying agents on a stale snapshot until the next refresh cycle.

To enable, point the gate at a running `ccrotate-serve`:

```sh
CCROTATE_SERVE_BASE_URL=http://ccrotate-serve.svc.cluster.local:3000  # required
CCROTATE_SERVE_TOKEN=<bearer>                                          # required
```

In-cluster, the k8s-injected pair `CCROTATE_SERVE_SERVICE_HOST` +
`CCROTATE_SERVE_SERVICE_PORT_SERVE` are also recognized as a fallback for
`CCROTATE_SERVE_BASE_URL` when the explicit env var is unset.

Notes:

- Verifier is **off by default** — without `CCROTATE_SERVE_TOKEN` the tier
  gate keeps its original deny-on-stale-snapshot behavior and logs a single
  `ccrotate.verifier_disabled` line at boot.
- The verifier fails **closed on auth errors** (401/403 short-circuit and
  count toward circuit-breaker budget) and **open on transport errors**
  (timeouts / 5xx degrade to "allow if cache snapshot was inconclusive").
  This matches the existing snapshot-fallback policy.
- Bursts are bounded by a 3-error circuit breaker: a ccrotate-serve outage
  sees at most ~3 probes per cooldown window per (target, email) pair.

## Optional Slack stakeholder progress notifications

To emit Slack notifications when issues move to `done`, `blocked`, or get handed back to the requesting user, set a Slack Incoming Webhook in local env/runtime config:

```sh
PAPERCLIP_STAKEHOLDER_PROGRESS_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

Notes:

- Do not commit webhook URLs to the repo.
- Message links use `PAPERCLIP_PUBLIC_URL` when set; otherwise Paperclip falls back to the current request host / `PAPERCLIP_API_URL`.

## Agent Artifact Uploads

When an agent generates a file that a board user or reviewer should inspect as
a deliverable, attach it to the issue before marking the task complete. Do not
rely on a local workspace path as the only access path.

Use the helper bundled with the Paperclip skill from the repo root:

```sh
skills/paperclip/scripts/paperclip-upload-artifact.sh dist/demo.mp4 \
  --title "Demo video render" \
  --summary "MP4 render for board review"
```

For WebM output:

```sh
skills/paperclip/scripts/paperclip-upload-artifact.sh out/walkthrough.webm \
  --title "Walkthrough video" \
  --summary "WebM walkthrough render"
```

The helper uploads the file as an issue attachment, creates an artifact work
product by default, and prints markdown links for the final issue comment. See
`doc/AGENT-ARTIFACTS.md` for the full completion pattern and direct API shape.
If a file intentionally remains workspace-only, create a work product with
`metadata.resourceRef.kind: "workspace_file"` and include the workspace-relative
path in the final comment. Use browse/search only as the fallback for recovering
that file, not as the main completion path for deliverables.

## Default Agent Workspaces

When a local agent run has no resolved project/session workspace, Paperclip falls back to an agent home workspace under the instance root:

- `~/.paperclip/instances/default/workspaces/<agent-id>`

This path honors `PAPERCLIP_HOME` and `PAPERCLIP_INSTANCE_ID` in non-default setups.

For `codex_local`, Paperclip also manages a per-company Codex home under the instance root and seeds it from the shared Codex login/config home (`$CODEX_HOME` or `~/.codex`):

- `~/.paperclip/instances/default/companies/<company-id>/codex-home`

If the `codex` CLI is not installed or not on `PATH`, `codex_local` agent runs fail at execution time with a clear adapter error. Quota polling uses a short-lived `codex app-server` subprocess: when `codex` cannot be spawned, that provider reports `ok: false` in aggregated quota results and the API server keeps running (it must not exit on a missing binary).

Local adapters require their corresponding CLI/session setup on the machine running Paperclip. External adapters are installed through the adapter/plugin flow and should not require hardcoded imports in `server/` or `ui/`.

## Config Freshness

Agent, project, environment, secret, skill, and workspace config edits are sampled at the next run boundary. A heartbeat that is already running finishes with the config it started with.

When effective run config changes, Paperclip may intentionally skip a saved adapter session, refresh persisted workspace runtime config, replace a reused execution workspace, or avoid reusing a sandbox/environment lease. Fresh execution can lose adapter-specific session, workspace, or sandbox state; correctness of the next run's config takes priority over continuity. Plain environment values affect freshness through value hashes; run result JSON and workspace operation logs expose only the non-sensitive freshness decision categories, without storing secret values, full env maps, provider credentials, or private path details.

## Worktree-local Instances

When developing from multiple git worktrees, do not point two Paperclip servers at the same embedded PostgreSQL data directory.

Instead, create a repo-local Paperclip config plus an isolated instance for the worktree:

```sh
paperclipai worktree init
# or create the git worktree and initialize it in one step:
pnpm paperclipai worktree:make paperclip-pr-432
```

This command:

- writes repo-local files at `.paperclip/config.json` and `.paperclip/.env`
- creates an isolated instance under `~/.paperclip-worktrees/instances/<worktree-id>/`
- when run inside a linked git worktree, mirrors the effective git hooks into that worktree's private git dir
- picks a free app port and embedded PostgreSQL port
- by default seeds the isolated DB in `minimal` mode from the current effective Paperclip instance/config (repo-local worktree config when present, otherwise the default instance) via a logical SQL snapshot

Seed modes:

- `minimal` keeps core app state like companies, projects, issues, comments, approvals, and auth state, preserves schema for all tables, but omits row data from heavy operational history such as heartbeat runs, wake requests, activity logs, runtime services, and agent session state
- `full` makes a full logical clone of the source instance
- `--no-seed` creates an empty isolated instance

Seeded worktree instances quarantine copied live execution by default for both `minimal` and `full` seeds. During restore, Paperclip disables copied agent timer heartbeats, resets copied `running` agents to `idle`, blocks and unassigns copied agent-owned `in_progress` issues, and unassigns copied agent-owned `todo`/`in_review` issues. This keeps a freshly booted worktree from starting agents for work already owned by the source instance. Pass `--preserve-live-work` only when you intentionally want the isolated worktree to resume copied assignments.

After `worktree init`, both the server and the CLI auto-load the repo-local `.paperclip/.env` when run inside that worktree, so normal commands like `pnpm dev`, `paperclipai doctor`, and `paperclipai db:backup` stay scoped to the worktree instance.

`pnpm dev` now fails fast in a linked git worktree when `.paperclip/.env` is missing, instead of silently booting against the default instance/port. If that happens, run `paperclipai worktree init` in the worktree first.

Provisioned git worktrees also pause seeded routines that still have enabled schedule triggers in the isolated worktree database by default. This prevents copied daily/cron routines from firing unexpectedly inside the new workspace instance during development without disabling webhook/API-only routines.

That repo-local env also sets:

- `PAPERCLIP_IN_WORKTREE=true`
- `PAPERCLIP_WORKTREE_NAME=<worktree-name>`
- `PAPERCLIP_WORKTREE_COLOR=<hex-color>`

The server/UI use those values for worktree-specific branding such as the top banner and dynamically colored favicon.
Authenticated worktree servers also use the `PAPERCLIP_INSTANCE_ID` value to scope Better Auth cookie names.
Browser cookies are shared by host rather than port, so this prevents logging into one `127.0.0.1:<port>` worktree from replacing another worktree server's session cookie.

Print shell exports explicitly when needed:

```sh
paperclipai worktree env
# or:
eval "$(paperclipai worktree env)"
```

### Worktree CLI Reference

**`pnpm paperclipai worktree init [options]`** — Create repo-local config/env and an isolated instance for the current worktree.

| Option | Description |
|---|---|
| `--name <name>` | Display name used to derive the instance id |
| `--instance <id>` | Explicit isolated instance id |
| `--home <path>` | Home root for worktree instances (default: `~/.paperclip-worktrees`) |
| `--from-config <path>` | Source config.json to seed from |
| `--from-data-dir <path>` | Source PAPERCLIP_HOME used when deriving the source config |
| `--from-instance <id>` | Source instance id (default: `default`) |
| `--server-port <port>` | Preferred server port |
| `--db-port <port>` | Preferred embedded Postgres port |
| `--seed-mode <mode>` | Seed profile: `minimal` or `full` (default: `minimal`) |
| `--no-seed` | Skip database seeding from the source instance |
| `--force` | Replace existing repo-local config and isolated instance data |

Examples:

```sh
paperclipai worktree init --no-seed
paperclipai worktree init --seed-mode full
paperclipai worktree init --from-instance default
paperclipai worktree init --from-data-dir ~/.paperclip
paperclipai worktree init --force
```

Repair an already-created repo-managed worktree and reseed its isolated instance from the main default install. Point `--from-config` at the instance config:

```sh
cd /path/to/paperclip/.paperclip/worktrees/PAP-884-ai-commits-component
pnpm paperclipai worktree init --force --seed-mode minimal \
  --name PAP-884-ai-commits-component \
  --from-config ~/.paperclip/instances/default/config.json
```

That rewrites the worktree-local `.paperclip/config.json` + `.paperclip/.env`, recreates the isolated instance under `~/.paperclip-worktrees/instances/<worktree-id>/`, and preserves the git worktree contents themselves.

For an already-created worktree where you want the CLI to decide whether to rebuild missing worktree metadata or just reseed the isolated DB, use `worktree repair`.

**`pnpm paperclipai worktree repair [options]`** — Repair the current linked worktree by default, or create/repair a named linked worktree under `.paperclip/worktrees/` when `--branch` is provided. The command never targets the primary checkout unless you explicitly pass `--branch`.

| Option | Description |
|---|---|
| `--branch <name>` | Existing branch/worktree selector to repair, or a branch name to create under `.paperclip/worktrees` |
| `--home <path>` | Home root for worktree instances (default: `~/.paperclip-worktrees`) |
| `--from-config <path>` | Source config.json to seed from |
| `--from-data-dir <path>` | Source `PAPERCLIP_HOME` used when deriving the source config |
| `--from-instance <id>` | Source instance id when deriving the source config (default: `default`) |
| `--seed-mode <mode>` | Seed profile: `minimal` or `full` (default: `minimal`) |
| `--no-seed` | Repair metadata only when bootstrapping a missing worktree config |
| `--allow-live-target` | Override the guard that requires the target worktree DB to be stopped first |

Examples:

```sh
# From inside a linked worktree, rebuild missing .paperclip metadata and reseed it from the default instance.
cd /path/to/paperclip/.paperclip/worktrees/PAP-1132-assistant-ui-pap-1131-make-issues-comments-be-like-a-chat
pnpm paperclipai worktree repair

# From the primary checkout, create or repair a linked worktree for a branch under .paperclip/worktrees/.
cd /path/to/paperclip
pnpm paperclipai worktree repair --branch PAP-1132-assistant-ui-pap-1131-make-issues-comments-be-like-a-chat
```

For an already-created worktree where you want to keep the existing repo-local config/env and only overwrite the isolated database, use `worktree reseed` instead. Stop the target worktree's Paperclip server first so the command can replace the DB safely.

**`pnpm paperclipai worktree reseed [options]`** — Re-seed an existing worktree-local instance from another Paperclip instance or worktree while preserving the target worktree's current config, ports, and instance identity.

| Option | Description |
|---|---|
| `--from <worktree>` | Source worktree path, directory name, branch name, or `current` |
| `--to <worktree>` | Target worktree path, directory name, branch name, or `current` (defaults to `current`) |
| `--from-config <path>` | Source config.json to seed from |
| `--from-data-dir <path>` | Source `PAPERCLIP_HOME` used when deriving the source config |
| `--from-instance <id>` | Source instance id when deriving the source config |
| `--seed-mode <mode>` | Seed profile: `minimal` or `full` (default: `full`) |
| `--yes` | Skip the destructive confirmation prompt |
| `--allow-live-target` | Override the guard that requires the target worktree DB to be stopped first |

Examples:

```sh
# From the main repo, reseed a worktree from the current default/master instance.
cd /path/to/paperclip
pnpm paperclipai worktree reseed \
  --from current \
  --to PAP-1132-assistant-ui-pap-1131-make-issues-comments-be-like-a-chat \
  --seed-mode full \
  --yes

# From inside a worktree, reseed it from the default instance config.
cd /path/to/paperclip/.paperclip/worktrees/PAP-1132-assistant-ui-pap-1131-make-issues-comments-be-like-a-chat
pnpm paperclipai worktree reseed \
  --from-instance default \
  --seed-mode full
```

**`pnpm paperclipai worktree:make <name> [options]`** — Create `~/NAME` as a git worktree, then initialize an isolated Paperclip instance inside it. This combines `git worktree add` with `worktree init` in a single step.

| Option | Description |
|---|---|
| `--start-point <ref>` | Remote ref to base the new branch on (e.g. `origin/main`) |
| `--instance <id>` | Explicit isolated instance id |
| `--home <path>` | Home root for worktree instances (default: `~/.paperclip-worktrees`) |
| `--from-config <path>` | Source config.json to seed from |
| `--from-data-dir <path>` | Source PAPERCLIP_HOME used when deriving the source config |
| `--from-instance <id>` | Source instance id (default: `default`) |
| `--server-port <port>` | Preferred server port |
| `--db-port <port>` | Preferred embedded Postgres port |
| `--seed-mode <mode>` | Seed profile: `minimal` or `full` (default: `minimal`) |
| `--no-seed` | Skip database seeding from the source instance |
| `--force` | Replace existing repo-local config and isolated instance data |

Examples:

```sh
pnpm paperclipai worktree:make paperclip-pr-432
pnpm paperclipai worktree:make my-feature --start-point origin/main
pnpm paperclipai worktree:make experiment --no-seed
```

**`pnpm paperclipai worktree env [options]`** — Print shell exports for the current worktree-local Paperclip instance.

| Option | Description |
|---|---|
| `-c, --config <path>` | Path to config file |
| `--json` | Print JSON instead of shell exports |

Examples:

```sh
pnpm paperclipai worktree env
pnpm paperclipai worktree env --json
eval "$(pnpm paperclipai worktree env)"
```

For project execution worktrees, Paperclip can also run a project-defined provision command after it creates or reuses an isolated git worktree. Configure this on the project's execution workspace policy (`workspaceStrategy.provisionCommand`). The command runs inside the derived worktree and receives `PAPERCLIP_WORKSPACE_*`, `PAPERCLIP_PROJECT_ID`, `PAPERCLIP_AGENT_ID`, and `PAPERCLIP_ISSUE_*` environment variables so each repo can bootstrap itself however it wants.

## App-Shipped Skills Catalog

The Paperclip app ships a curated catalog of company skills out of the box. The
catalog is a workspace package at `packages/skills-catalog`:

```text
packages/skills-catalog/
  catalog/
    bundled/<category>/<slug>/SKILL.md   # recommended defaults
    optional/<category>/<slug>/SKILL.md  # role/domain-specific
  generated/catalog.json                  # checked-in manifest
  scripts/
    build-catalog-manifest.ts             # regenerate generated/catalog.json
    validate-catalog.ts                   # validation only
  src/                                    # builder + types consumed by server/CLI
```

Server and CLI import the generated manifest; they do not crawl repository
paths at request time. Root `skills/` remains reserved for Paperclip runtime
skills and is not part of the catalog.

Validate the catalog without writing the manifest:

```sh
pnpm --filter @paperclipai/skills-catalog validate
```

Regenerate `generated/catalog.json` after editing any catalog `SKILL.md`,
frontmatter, file inventory, category, or slug:

```sh
pnpm --filter @paperclipai/skills-catalog build:manifest
```

The package's `build` script runs `build:manifest` and then `tsc`; tests live
under `pnpm --filter @paperclipai/skills-catalog test`. Validation fails when:

- a catalog entry is not under `catalog/bundled/<category>/<slug>` or
  `catalog/optional/<category>/<slug>`
- `SKILL.md` is missing or the frontmatter `name`/`description` is empty
- the frontmatter `key` disagrees with the generated canonical key
- two catalog entries share an `id`, `key`, or `slug`
- file inventory contains absolute paths, `..`, broken symlinks, or files
  outside the skill directory
- the regenerated manifest differs from the checked-in
  `generated/catalog.json`

Trust level is derived from inventory: `markdown_only` (markdown + references
only), `assets` (other non-script files), or `scripts_executables` (any
executable script). The build contract is documented in
`doc/plans/2026-05-26-skills-cli-catalog-contract.md`.

CI runs `pnpm --filter @paperclipai/skills-catalog validate` and the package's
vitest suite, so always regenerate the manifest in the same commit as the
catalog change.

## App-Shipped Teams Catalog

The team catalog package mirrors the skills catalog workflow for
agentcompanies/v1 team packages:

```text
packages/teams-catalog/
  catalog/
    bundled/<category>/<slug>/TEAM.md
    optional/<category>/<slug>/TEAM.md
  generated/catalog.json
  scripts/
    build-catalog-manifest.ts
    validate-catalog.ts
```

Validate without writing the manifest:

```sh
pnpm --filter @paperclipai/teams-catalog validate
```

Regenerate `generated/catalog.json` after editing catalog team files:

```sh
pnpm --filter @paperclipai/teams-catalog build:manifest
```

Team install/preview APIs enforce source policy. External skill sources require
explicit approval flags, and local-path skill sources are development-only
unless `allowLocalPathSources` is set by the caller.

## Quick Health Checks

In another terminal:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Expected:

- `/api/health` returns `{"status":"ok"}`
- `/api/companies` returns a JSON array

## Reset Local Dev Database

To wipe local dev data and start fresh:

```sh
rm -rf ~/.paperclip/instances/default/db
pnpm dev
```

## Optional: Use External Postgres

If you set `DATABASE_URL`, the server will use that instead of embedded PostgreSQL.

## Automatic DB Backups

Paperclip can run automatic logical database backups on a timer. These backups cover
non-system database schemas, including migration history and plugin-owned database
schemas. Defaults:

- enabled
- every 60 minutes
- retain 30 days
- backup dir: `~/.paperclip/instances/default/data/backups`

Configure these in:

```sh
pnpm paperclipai configure --section database
```

Run a one-off backup manually:

```sh
pnpm paperclipai db:backup
# or:
pnpm db:backup
```

Environment overrides:

- `PAPERCLIP_DB_BACKUP_ENABLED=true|false`
- `PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES=<minutes>`
- `PAPERCLIP_DB_BACKUP_RETENTION_DAYS=<days>`
- `PAPERCLIP_DB_BACKUP_DIR=/absolute/or/~/path`
- `PAPERCLIP_DB_BACKUP_MAX_AGE_HOURS=<hours>` controls the `/api/health`
  stale-backup warning threshold
- `PAPERCLIP_DB_BACKUP_ALERT_FILE=/path/to/failure-marker` lets external cron
  wrappers surface the last failed backup in `/api/health`

Without `PAPERCLIP_DB_BACKUP_ALERT_FILE`, health checks look for
`db-backup-to-s3.failure` in the backup directory, beside the backup directory,
and in the default sibling `health/` directory.

DB backups are not full instance filesystem backups. For full local disaster
recovery, also back up local storage files and the local encrypted secrets key if
those providers are enabled.

## Heap Snapshots

For diagnosing a heap leak whose cause no metric names (PEN-3314), the worker tier
can write V8 heap snapshots to the Paperclip instance directory. **Off by default.**

```sh
PAPERCLIP_HEAP_SNAPSHOT_ENABLED=true
```

Snapshots land in `<instance-root>/data/diagnostics/heap/`. On a deployment where
that directory sits on a shared volume, any pod mounting it can read the result —
which is the point: retrieving a snapshot needs no `pods/exec` and no new HTTP
route on the worker.

Request one by dropping a sentinel file into the snapshot directory from anywhere
that can write it:

```sh
touch <instance-root>/data/diagnostics/heap/snapshot.request
```

The worker consumes the sentinel on its next poll and writes a snapshot. Contents
are ignored; only the file's existence is read.

**The sentinel is a trigger for a stop-the-world pause on the singleton worker,
and every pod mounting the shared claim can write it.** Requests are therefore
rate-limited (`SENTINEL_MIN_INTERVAL_MINUTES`, default 5): a sentinel arriving
inside that window is deleted but declines to snapshot, so a script touching the
file in a loop cannot pause the process that drives every heartbeat, dispatch and
recovery pass once per poll. The sentinel is consumed either way, so a burst of
touches does not queue up.

**So the file disappearing does not mean a snapshot was taken.** Deletion is how
the request is claimed, not how it is honoured, and a declined request deletes it
just the same. Read the worker log rather than the directory to tell them apart:

| worker log | what happened | what to do |
| --- | --- | --- |
| `Heap snapshot written` (warn) | honoured | retrieve it; it holds secrets in plaintext |
| `Heap snapshot request declined` (info) | claimed, rate-limited | wait out `SENTINEL_MIN_INTERVAL_MINUTES`, touch again |
| `Heap snapshot request seen but not claimed` (warn) | delete failed, **file still there** | if it repeats, the worker cannot delete the file — remove it by hand. Only the request path is affected; threshold capture keeps running |
| `Heap snapshot skipped` (error) | honoured, then refused | read `skipped` (e.g. `insufficient-free-space`) |

Environment overrides:

Every numeric override below is resolved through `resolveNumericSetting()` against
the bounds declared in `NUMERIC_SETTING_BOUNDS` (BLO-27641), so each carries a
ceiling as well as a floor. A value outside the range is clamped into it and a
value that is not a finite positive number — `Infinity`, `1e999`, `abc`, a
negative — is rejected and falls back to the documented default. Both are
reported on stderr at startup, because the banner prints only the resolved
number and so cannot otherwise distinguish "the operator asked for this" from
"the operator asked for something impossible".

- `PAPERCLIP_HEAP_SNAPSHOT_ENABLED=true|false` (default `false`)
- `PAPERCLIP_HEAP_SNAPSHOT_DIR=/absolute/or/~/path`
- `PAPERCLIP_HEAP_SNAPSHOT_KEEP=<count>` (default `2`, range `1`–`20`)
- `PAPERCLIP_HEAP_SNAPSHOT_MIN_FREE_GB=<gb>` (default `10`, range `1`–`1024`)
- `PAPERCLIP_HEAP_SNAPSHOT_THRESHOLD_MB=<mb>` — take one unprompted at or above
  this live-heap size. Default `0`, which leaves the sentinel as the only trigger;
  range `0`–`65536`. This is the one setting whose floor is `0`, because `0` is
  the off switch — an explicit `0`, and anything else the resolver rejects, lands
  on the default and so stays off. The failure direction that matters is the
  other one: a typo must never be able to *enable* an unprompted
  stop-the-world pause.
- `PAPERCLIP_HEAP_SNAPSHOT_MIN_INTERVAL_MINUTES=<minutes>` (default `120`, range
  `1`–`10080`) — minimum gap between *automatic* snapshots.
- `PAPERCLIP_HEAP_SNAPSHOT_SENTINEL_MIN_INTERVAL_MINUTES=<minutes>` (default `5`,
  range `1`–`10080`) — minimum gap between *sentinel* snapshots. The floor of 1
  minute is a floor on a path anything with write access to the volume can reach,
  so there is deliberately no way to switch it off — and unlike the `Math.max(1, …)`
  this replaced, the floor also holds against `Infinity`, which used to pass
  straight through it.
- `PAPERCLIP_HEAP_SNAPSHOT_MAX_AGE_MINUTES=<minutes>` (default `1440`, i.e. 24h;
  range `1`–`43200`, i.e. 30 days) — how long a snapshot may remain on disk,
  measured from the capture stamp in its filename. See the security section
  below: this is an exposure window, not a disk cap, so it is bounded at *both*
  ends and overrides `KEEP`. The 30-day ceiling is why: the file holds every
  string on the heap, so an unbounded value turns a diagnostic into indefinite
  retention of the process's secrets on a shared volume. Keep it comfortably
  above `MIN_INTERVAL_MINUTES` or the older half of a diff pair can expire
  before the newer half exists; the worker warns at startup if it is not.
  It bounds the exposure only while capture is *on*: setting `ENABLED=false`
  deletes the snapshots outright rather than waiting for this to elapse.
- `PAPERCLIP_HEAP_SNAPSHOT_POLL_SECONDS=<seconds>` (default `60`, range `5`–`3600`)

### ⛔ A snapshot is a credential, not a diagnostic

`v8.writeHeapSnapshot()` serialises **every reachable string**, and `loadConfig()`
reads this process's secrets out of the environment into exactly such strings
(`githubAppPrivateKey` is a required field). So a snapshot contains, in plaintext:
the GitHub App private key, the agent JWT signing secret, `DATABASE_URL`, the
webhook secret, and any provider API tokens on the heap.

This is measured, not inferred. A value read from the environment onto a live
object appears verbatim in the resulting file; a value left in the environment
and never dereferenced does not.

**File permissions do not mitigate this on the deployed cluster.** The worker and
every agent pod run as the *same uid* against the same ReadWriteMany claim, so a
`0600` file owned by `1000` is fully readable by uid `1000` in another pod. There
is no mode that separates them. The retrieval property this feature is built on —
readable from any agent seat with no privilege change — is the identical
mechanism, so it cannot be kept while dropping the exposure.

What follows from that:

- **The file's lifetime is the only control.** Hence `MAX_AGE_MINUTES`, which
  overrides `KEEP`: "there are only two of them" is not a security property.
- **⚠️ Disabling the flag DELETES the snapshots. Retrieve them first.** Retention
  runs on the worker tier whether or not capture is enabled, and with
  `ENABLED=false` it retains **nothing** — the sweep runs at startup and on every
  poll with an effective `KEEP` of `0`. Disabling capture is how an operator
  declares the window closed, so the files go at that point rather than ageing
  out over the next `MAX_AGE_MINUTES`.

  **The ordering is therefore load-bearing, not a nicety:**

  1. Copy the snapshot pair **off** the volume (`cp` to somewhere the claim is
     not shared, or pull it down and delete the copy on the volume).
  2. Read the diff.
  3. *Then* set `PAPERCLIP_HEAP_SNAPSHOT_ENABLED=false`.

  Flip the flag first and the pair is gone on the next worker start — including a
  snapshot you had not retrieved. This is the deliberate trade: the prune used to
  live *inside* the feature flag, so switching capture off stopped the sweep with
  it and whatever was on the volume stayed there forever. The moment an operator
  believed the exposure had ended was the moment it became permanent. Losing an
  un-retrieved snapshot is recoverable — take another. A credential-bearing file
  left on a shared volume indefinitely is not.
- **Age is read from the filename stamp, not mtime.** Retrieval means copying
  these off the volume and copy tooling rewrites mtimes; keying on mtime would
  let any reader extend the window just by touching the file. This holds for
  unfinished `.partial` files as well as completed ones — see below.
- **⚠️ An unfinished `.partial` is just as dangerous, and `ls *.heapsnapshot`
  will not show it.** `writeHeapSnapshot` serialises incrementally, so a
  `<stamp>.heapsnapshot.partial` holds the same plaintext secrets as a completed
  snapshot. One is left behind whenever a capture does not return — and an OOM
  *during* the write is this feature's own most likely failure mode, since it
  runs on a worker whose failure mode is heap exhaustion.

  So when checking that the snapshot directory is clear, **match both suffixes**:

  ```sh
  ls -la <instance-root>/data/diagnostics/heap/*.heapsnapshot*
  ```

  Spell the directory out rather than reaching for `$PAPERCLIP_HEAP_SNAPSHOT_DIR`.
  That variable is an *optional override* (`config.ts` falls back to the path
  above) and it is set nowhere in `deploy/helm/paperclip/`, so on both the worker
  and the agent pod you would shell into it is unset — and
  `ls -la "$PAPERCLIP_HEAP_SNAPSHOT_DIR"/*.heapsnapshot*` expands to
  `ls -la /*.heapsnapshot*`, which reports `No such file or directory` no matter
  what is sitting in the real directory. That is this paragraph's own failure
  mode with the suffix fixed and the path wrong: a false all-clear over a
  multi-gigabyte credential-bearing partial. If you do set the override, quote it
  with the fallback inline — `"${PAPERCLIP_HEAP_SNAPSHOT_DIR:-<instance-root>/data/diagnostics/heap}"`.

  A glob ending at `.heapsnapshot` reports an empty directory while a
  multi-gigabyte credential-bearing partial sits in it. The startup warning
  counts both and lists them separately; the periodic sweep deletes a partial
  once it is past its abandonment window (10 minutes from its filename stamp),
  which is also why a freshly stranded one keeps the poll armed rather than
  arming nothing.
- **Treat each capture as a credential-exposure event.** Decide on rotation of
  the App private key and the agent JWT secret the same way you would for any
  other disclosure, rather than filing it as a diagnostic. Delete the snapshot as
  soon as it has been analysed rather than waiting for it to age out, and prefer
  analysing it somewhere the volume is not shared.
- Where the trade is acceptable, a `kubectl debug` ephemeral container against
  `--heapsnapshot-signal` writes to `/proc/<pid>/cwd` (container-local, **not**
  the shared claim) and is the safer option on this axis. It needs
  `pods/ephemeralcontainers` and is a one-off manoeuvre rather than something
  repeatable, which is why it is not the default here — but it is a real trade.

Two more things to know before enabling it:

- A snapshot is **stop-the-world**. Expect a pause of seconds on a multi-gigabyte
  heap, during which the process answers nothing, health checks included.
- A snapshot file is roughly 1.5-2x the live heap. The retention cap and the
  free-space floor are what keep that from filling a shared volume, so do not
  raise `KEEP` without checking what else lives there.

If the volume is too full, the worker logs `Heap snapshot skipped` and writes
nothing — **and retains the snapshots it would otherwise have pruned.** The
free-space test already credits the bytes that prune would release
(`reclaimableBytes` in the log line), so a refusal means deleting them would not
have been enough. Snapshots of a past heap state cannot be retaken, so they are
kept rather than spent on a write that cannot happen.

One snapshot names what is on the heap. It takes **two, hours apart**, to name what
is *accumulating* — load the pair into Chrome DevTools (Memory → Load) and use the
"Objects allocated between snapshot 1 and 2" comparison view. Copy the pair off
the volume before you disable the flag — see the security section above, where
that ordering and the reason for it are spelled out — and delete both once the
diff has been read.

## Secrets in Dev

Agent env vars now support secret references. By default, secret values are stored with local encryption and only secret refs are persisted in agent config.

## Heartbeat Run Transcript Access and Auditing

### Who may read a run transcript

Run *transcript content* — the `GET /api/heartbeat-runs/:runId/log` body, the
`message` / `payload` of `GET /api/heartbeat-runs/:runId/events`, and the
captured output of a workspace operation — is scoped to
the run's owning agent, that agent's manager chain, operator-grade human board
members of the company, and any principal holding the `runs:read_transcript`
grant (PEN-3142, implementing the decision on PEN-3140). Company-wide peer read
was withdrawn because the run log has carried vendor credential material across
several incidents and the scrub protecting it runs only at write time.

**Operator-grade** means an active `owner`, `admin`, or `operator` membership in
the company (`TRANSCRIPT_OPERATOR_MEMBERSHIP_ROLES`, `routes/authz.ts`), plus
the trusted local board, which has no membership row. A `viewer` or `member`
does *not* read transcripts by default — the same line the codebase already
draws for `workspace_runtime:read`, which guards less sensitive material. That
is a default rather than a lockout: such an actor falls through to the
authorization service, so an explicit `runs:read_transcript` grant admits one,
and the denial carries the named boundary reason either way. The gate is the
only place the human operator set is written down; the
`runs_read_transcript_grant_seed` migration seeds the grant for `ceo` / `cto`
agents and deliberately says nothing about humans.

Run *state* is unchanged and stays company-readable: `GET
/api/heartbeat-runs/:runId` (status, exit/park reason, retry edge, error text,
`lastActivityAt`) and watchdog decisions.

### Workspace operations are a mix

A `workspace_operations` row is **partly state and partly transcript**
(PEN-3204, implementing the ruling on PEN-3202). Do not treat the whole row as
either.

| field | treatment |
|---|---|
| `phase`, `status`, `exitCode`, `command`, `cwd`, `metadata`, the ids, the timestamps, and the log volume/location/digest (`logStore`, `logRef`, `logBytes`, `logSha256`, `logCompressed`) | **state** — company-readable |
| `stdoutExcerpt`, `stderrExcerpt` | **transcript** — scoped on `runs:read_transcript` as above |
| `GET /api/workspace-operations/:operationId/log` body | **transcript** — scoped on `workspace_runtime:read` **and** the run-transcript gate, ANDed. See below. |

The excerpts are withheld on **both list routes**, or the boundary is not
closed: `GET /api/heartbeat-runs/:runId/workspace-operations` and
`GET /api/execution-workspaces/:id/workspace-operations` (the widest — it
returns every operation for a workspace, including other agents' runs).
Withheld rows carry
`withheldFields: ["stdoutExcerpt", "stderrExcerpt"]`, so a client can tell "not
entitled" from "this operation captured no output"; every state field survives
beside them, because hiding the operator's text is the point and hiding that an
operation ran is not.

**The per-operation `/log` body is gated by two controls, ANDed, and both are
deliberate.** BLO-34631 landed a `workspace_runtime:read` entitlement on that
route while PEN-3204 was open; PEN-3204 then ANDed `decideRunTranscriptRead`
onto it (through `runTranscriptReadGate`, against the operation's owning agent).
The body is disclosed only to a reader who clears **both**; a reader refused by
either gets the masked 200 described below, never a 403. The rationale is on the
route in `routes/agents.ts`.

The entitlement alone was kept for a time, on the reasoning that it is *strictly
tighter* than the run-transcript gate. **That reasoning is sound for agents and
unsound for humans**, which is why the second gate is now there.

For agents it holds: `workspace_runtime:read` is unmapped in
`permissionForAction` and deliberately absent from the same-company agent
allow-list (PEN-2852, `services/authorization.ts`), so **no agent actor resolves
it** — the body is withheld from every agent, owner or not. Reaching for a grant row is a dead end for two
*independent* reasons: the action is unmapped, so the generic `permissionKey`
fallback at the bottom of `decideBase` never fires for it — and
`workspace_runtime:read` is not a `PermissionKey` at all, so there is no row to
insert in the first place. The second reason is compiler-held (it is absent
from `PERMISSION_KEYS`, `packages/shared/src/constants.ts`) and is therefore
the one a future implementer cannot accidentally undo; widening the allow-list
is the only lever that works.

For humans it does not hold. The two gates read the same unconstrained
`company_memberships.membership_role` text column in opposite failure
directions:

- the transcript gate **normalizes** it (`normalizeHumanRole(value, "viewer")`,
  union `[owner, admin, operator, viewer]` plus `member → operator`) and so
  fails **closed** on an unrecognized role — deliberate, see
  `boardActorIsTranscriptOperator`;
- `workspace_runtime:read` tests the **raw** column (`membershipRole !== "viewer"`,
  `allow_simple_company_member`) and so fails **open** on one.

A non-union role really is written: `middleware/auth.ts` persists the Cloud
stack role verbatim for anything that is not owner/admin, and
`stackMembershipRole` admits `support`. Such a member had the excerpts withheld
on both list routes and was served the whole log body here, one URL over — a
gate on one sibling and not the other, which is the failure this whole section
exists to prevent. The AND is strictly narrowing: operator-grade humans and the
local board clear the transcript gate anyway, viewers and agents are already
withheld by the entitlement, and the only decision that changes is the
divergent one. If you are tempted to drop one of the two gates, that is the
case to re-check first.

⚠️ The underlying divergence is **not** fixed by this route — every other
`workspace_runtime:read` consumer still reads the raw column. Narrowing that is
tracked separately; do not assume an unrecognized role is handled safely
elsewhere.

Two consequences follow, and neither is an oversight:

- **`runs:read_transcript` does not reach this route on its own.** The gate is
  an AND, not an OR, so a holder of the grant who lacks `workspace_runtime:read`
  — every agent, and every viewer — gets a withheld body here, unlike on the
  run-transcript routes. That is a real narrowing of the PEN-3140 escape hatch,
  decided on PEN-3204 rather than inherited: the grant was sized from an audit
  of *run* transcript reads, no demand for workspace-operation log reads was
  measured, and human operators (active non-viewer board members) retain the
  read, which is the principal incident response actually uses. Widening it
  back is a product decision that needs its own evidence, not a default.
- **Withheld here means masked, not emptied.** The body returns 200 with
  `content` replaced wholesale by the redaction sentinel
  (`maskWorkspaceRuntimeTextForRead`), so a reader can still tell "this operation
  logged nothing" from "the log was withheld". It is a total replacement, not a
  heuristic scrub.

For agents, the transcript bytes on that route still ride first on an
entitlement whose charter is *operator-authored runtime config* rather than
transcript content. Adding `workspace_runtime:read` to the agent allow-list for
a runtime-config workflow would leave the transcript gate as the only gate an
agent meets here, so `runs:read_transcript` would reach this route as a side
effect and undo the narrowing above without anyone deciding to. That coupling
is pinned by a test in `authorization-service.test.ts` (PEN-3204) which fails if
a `runs:read_transcript` holder ever resolves `workspace_runtime:read`.

The route carries the same rationale beside the code (`routes/agents.ts`, the
`/workspace-operations/:operationId/log` handler). It is stated here as well
because this is the paragraph a maintainer reads to answer "is the operation log
gated?", and the answer is yes, by the gate above it **and** a second one. The
two gates agree on viewers by default — neither admits one — and differ in what
can widen them: a viewer can be granted `runs:read_transcript`, while
`workspace_runtime:read` has no grant to issue, so under the AND a viewer stays
withheld even with the grant.

`command` / `cwd` / `metadata` are separately masked by an **orthogonal** gate,
`workspace_runtime:read` (`routes/workspace-response.ts`). The two compose and
neither covers the other: one answers "may you see the operator's command?", the
other "may you see what it printed?". A route applying only one is half-gated.

**Owner resolution fails closed.** `workspace_operations` has no owning-agent
column, so the owner is resolved through `heartbeatRunId → heartbeat_runs.agentId`.
That edge is `onDelete: "set null"` and is never set by the POST runtime-command
recorders, so an unresolvable owner is normal — and the captured output is then
withheld from **every agent actor, including a `runs:read_transcript` grant
holder**, because there is no owner for the grant to be about. Human operators
keep the read. `issues.assigneeAgentId` is not an acceptable substitute for the
run edge: assignees move.

The two transcript routes deny differently, on purpose:

- `/log` returns **403** with the decider's named boundary reason in the error
  details. Its entire body is transcript, so there is nothing left to return.
  A cross-tenant caller still gets the pre-existing **404** — that is the case
  where the run's existence is itself the secret.
- `/events` returns **200** with the event envelope (`seq`, `eventType`,
  `stream`, `level`, `color`, `createdAt`) and `message` / `payload` set to
  `null`, plus `withheldFields: ["message", "payload"]` so a client can tell
  "not entitled" from "the event carried no content". `seq` — the pagination
  cursor every consumer depends on — is always readable.

Withholding on `/events` covers **every** event type rather than a classified
subset. Adapters supply their own `eventType` string, and the in-repo
`lifecycle` emitters already carry agent-written prose and adapter failure text,
so a type allowlist would rest on a convention nothing enforces.

### The live-event push channel

The two routes above are **pull** paths. The same transcript content is also
**pushed**, over the company live-event WebSocket
(`GET /api/companies/:companyId/events/ws`), and it is scoped by the same
decision — closing one and not the other would leave the highest-fidelity copy
of the material on an ungated socket.

Three of the eleven `LIVE_EVENT_TYPES` carry transcript content:

| live event type | transcript-bearing keys |
|---|---|
| `heartbeat.run.log` | `chunk` |
| `heartbeat.run.event` | `message`, `payload`, `lastAssistantSnippet` |
| `heartbeat.run.progress` | `message`, `lastAssistantSnippet` |

A subscriber receives **every** event; only those keys are nulled, and the
payload then carries `withheldFields` — same contract as `/events`. A peer can
still see that a run is producing output (`runId`, `seq`, `stream`, `phase`,
`currentToolName`), which is state. `currentToolName` in particular stays
readable, matching the REST projection that recomputes `currentStatusMessage`
*from* it rather than nulling it.

The filter matches on **key name, not event type**
(`withholdLiveEventTranscriptContent`, `redaction.ts`). `LiveEventType` is a
closed server-owned union, so a type allowlist would be sound today — but it
would reopen silently the first time a twelfth type carried prose. Matching keys
means a new type carrying `chunk` / `message` / `payload` /
`lastAssistantSnippet` is withheld the day it is added, and widening is a
deliberate act. State-only types (`heartbeat.run.status` and its `error`,
`heartbeat.run.queued`, `agent.status`, `activity.logged`,
`external_object.updated`) carry none of those keys and pass through untouched.

The decision is memoized per socket, keyed on the run's owning agent, and the
entry **expires after 30s**. The REST list gate memoizes too, but its cache
cannot outlive one request; a socket is long-lived by design (`live-events-ws.ts`
keeps it alive with ping/pong), so an entry with no expiry would keep streaming
transcript content after a revoked grant, a reporting-line change, or a move out
of a low-trust boundary — for as long as the client stayed connected. Bounding
the reuse window in time keeps the per-event saving without that fail-open
direction. The entry is stamped when the decision starts, so a slow authorizer
shortens the window rather than extending it.

**Not audited, deliberately.** The two pull routes emit an `activity_log` row per
read. The push channel does not: it would emit one row per log chunk per
subscriber, which is a different order of volume, and the audit already records
the pull reads that a `denied` finding would be investigated through. Auditing
the subscription rather than the event is the shape to reach for if this is ever
needed.

### Access auditing

Both transcript routes emit a company-scoped `activity_log` entry for allowed
and denied reads:

| route | action |
|---|---|
| `GET /api/heartbeat-runs/:runId/log` | `heartbeat.run_log_accessed` |
| `GET /api/heartbeat-runs/:runId/events` | `heartbeat.run_events_accessed` |
| `GET /api/workspace-operations/:operationId/log` | `workspace_operation.log_accessed` |

**All three actions exist and a consumer needs all three.** They are separately
reachable paths over the same material; wiring an alert or digest to some and
not the others reproduces the blindness that got this audit rejected as a
standalone compensating control on PEN-3140. The workspace-operation path is the
one that had *neither* half of the control pair — no gate and no audit — until
BLO-34631 gave it both; its row is keyed `entity_type = workspace_operation` and
carries the operation's owning run in `runId` — the only owner reference it
records (no owning-agent id is written: the route resolves the owner only to
decide the transcript gate, and does not record it). That `runId` is **`null`** for a workspace-scoped operation
that has no owning run, so a run pivot alone never sees those. See the sweep
below.

The audit row records the actor type/id, company id, heartbeat run id, timestamp
(`activity_log.created_at`), access result, and the requested window (byte
offset/limit for `/log`; `afterSeq`/`limit`/`eventCount` for `/events`), plus the
log store type for `/log`. It deliberately does not record transcript content,
log chunks, log references/paths, environment values, or credential material.

Incident response can inspect these events through the company activity API or
activity UI filtered by action/entity/run. To isolate a run's access history,
query all three actions above — the two run-transcript routes are keyed
`entity_type = heartbeat_run` with `entity_id = <runId>`, while the
workspace-operation route is keyed `entity_type = workspace_operation` with the
owning run in `runId`. Querying only the `heartbeat_run` rows silently omits the
workspace-operation path, which is the same partial-coverage blindness this
section warns about immediately above.

⚠️ **The run pivot does not close the workspace-operation path either — it
misses every run-less operation.** `workspace_operations.heartbeatRunId` is
nullable (`packages/shared/src/types/workspace-operation.ts`), the route writes
it through to the audit row verbatim, and `listForRun` *deliberately* also
returns the workspace-scoped cleanup rows that have no owning run
(`services/workspace-operations.ts`). `/log` takes a bare operation id, so those
rows are reachable and audited like any other — they simply book `runId: null`.
Filtering `entity_type = workspace_operation` by `runId = <runId>` therefore
returns every run-attached read and **zero** run-less ones. Pair the pivot with
an `entity_type = workspace_operation` sweep scoped by `companyId` and time
window (or by the specific `entity_id`s) to get the whole set.

⚠️ **`details.result` does not mean the same thing on all three rows, and
filtering on it alone under-counts.** On the two run-transcript routes an
unentitled same-company caller books `result: "denied"`, whether the response is
`/log`'s 403 or `/events`' 200-with-withheld-content. (That implication runs one
way only on `/log` — see the classification note below.) On the
workspace-operation `/log` route it is not: that caller clears both company
checks and receives a 200 whose `content` is masked, and the row books
`result: "allowed"` with **`details.withheld: true`**
(BLO-34631 added that flag for exactly this reason — there, the access check
decides reachability and the entitlement ANDed with the transcript decision
decides the bytes). `details.withheld`
is present *only* on the workspace-operation rows. An incident query that
enumerates unentitled transcript access as `details.result = "denied"` therefore
returns every run-route attempt and **zero** workspace-operation attempts. Read
`result: "denied" OR details.withheld = true` across the three actions to get
the whole set.

⚠️ **`denied` also conflates two different failures — a separate axis from the
under-count above, and one the recommended query does not fix.** That query
still returns the whole set; this is conflation, not omission. But a responder
*classifying* what it returns needs to know that `denied` is not one thing.

One leg is easy to misread as a boundary denial and is not. The two `/log`
routes wrap `assertCompanyAccess` in a `try`/`catch` that audits `denied`, but
that call is reached only *after* `hasCompanyAccess` has already passed, so its
cross-tenant throws (`routes/authz.ts`) re-test a predicate that just succeeded
and cannot fire, and its remaining throws are gated on a non-safe method. On a
GET the one leg still live is `RESPONSIBLE_USER_UNAVAILABLE` — an agent actor
carrying a responsible user whose membership in the company is not `active`.
That is **not** a JWT-only shape: an **agent API key** carries one too, always
(`middleware/auth.ts` refuses a key whose responsible user is missing, so every
key actor that authenticates has one). The check itself (`routes/authz.ts`)
gates on the actor having a responsible user at all and never reads `source`.
It is deliberately not safe-method-gated (unlike its
`RESPONSIBLE_USER_UNAUTHORIZED` sibling) and throws unless the opt-in shadow
mode is on (`services/authorization.ts`). That caller is **same-company**.

⚠️ **The table below describes enforce mode.** Under
`PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE=shadow` (or the
`PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW` boolean) that throw is suppressed,
`assertCompanyAccess` completes, the `catch` never runs, and the
responsible-user leg leaves every row: a same-company `denied` on
`heartbeat.run_log_accessed` is then unambiguously an entitlement denial, and
`workspace_operation.log_accessed` books no same-company `denied` at all. Check
the deployment's mode before classifying against this table.

| action | what `result: "denied"` covers |
|---|---|
| `heartbeat.run_events_accessed` | an entitlement denial **or**, in enforce mode, a responsible-user *authorization* denial — `/events` runs the same `decideRunTranscriptRead`, so the intersection denial books here too. Two other denials book **no row at all**: both the cross-tenant caller and the same-company responsible-user-*unavailable* caller exit inside `getAccessibleResource` (`routes/authz.ts`), which 404s or throws upstream of this route's single audit call |
| `heartbeat.run_log_accessed` | an entitlement denial, **or** a cross-tenant 404, **or** a same-company responsible-user-*unavailable* denial, **or**, in enforce mode, a responsible-user *authorization* denial — all four book the identical row shape |
| `workspace_operation.log_accessed` | a cross-tenant 404 **or** a same-company responsible-user-unavailable denial — **never** an entitlement denial, which books `allowed` + `withheld: true` instead, per the block above |

So counting "same-company unentitled reads" off `result: "denied"` folds in
cross-tenant probes on both `heartbeat_run` and `workspace_operation` rows,
folds in responsible-user denials on the run actions, and on
`workspace_operation` rows finds no entitlement denial at all. Isolating one
takes two filters, neither of which is a plain predicate over `activity_log` —
and on one action even both together fall short, so a third source is needed:

- **The row's `companyId` is the *entity's* company** (`run.companyId` /
  `operation.companyId`) — the actor's own company is nowhere on the row, whose
  actor fields are `actorType`, `actorId`, `agentId`, `details.actorSource` and
  `details.actorRunId`. Splitting cross-tenant from same-company is therefore a
  join — to `agents.company_id` for an agent actor, to company membership for a
  user actor — not a comparison between two columns of the row.
- **Within same-company, `details.actorSource` finishes the job on one action
  and does not touch the other.** On `workspace_operation.log_accessed` there
  is no entitlement leg, so every same-company `denied` is
  responsible-user-unavailable whatever the source says. On
  `heartbeat.run_log_accessed` both legs are reachable and `actorSource` does
  **not** separate them. An agent actor books `agent_jwt` or `agent_key` and
  nothing else (`getRunLogAuditActor`, `routes/agents.ts`), and both values are
  ambiguous: `agent_key` always carries a responsible user, `agent_jwt` carries
  one whenever the claim is signed (and, for an unsigned legacy token, whenever
  the run records one — `middleware/auth.ts`), and either can fail either way. So a same-company `denied` on that
  action is **not** decomposable from the row alone. Filtering it to
  `actorSource != 'agent_jwt'` and reporting the result as unentitled
  transcript reads promotes a responsible-user **availability** failure — an
  offboarded owner, a stale key — into an insider **entitlement** finding.
- **The discriminator that row lacks is in the log stream, not in
  `activity_log`.** The responsible-user denial is not silent:
  `throwOrShadowResponsibleUserCompanyAccessDeny` (`routes/authz.ts`) emits a
  structured `logger.warn` *before* deciding whether to throw, carrying
  `action: "company_access"` — the field that selects these lines out of the
  stream — plus `code` (`RESPONSIBLE_USER_UNAVAILABLE` vs
  `RESPONSIBLE_USER_UNAUTHORIZED`), `authzMode`, `companyId`, `actorAgentId`,
  `responsibleUserId` and `method`. Two limits on what that buys. **`code` does
  not discriminate *within this emitter*:** all three routes are GETs and the
  `RESPONSIBLE_USER_UNAUTHORIZED` branch is gated on a non-safe method, so on
  these paths this emitter can only ever write `RESPONSIBLE_USER_UNAVAILABLE`.
  **And it is not the only emitter:** `applyResponsibleUserIntersection`
  (`services/authorization.ts`) writes its own warn — "responsible-user
  authorization intersection denied" — carrying the same `companyId`,
  `actorAgentId`, `authzMode` and `code`, but `action: <the authz action>`
  (`runs:read_transcript` on these routes). It fires only when the **agent**
  was entitled and its responsible user was not, and that denial *is* booked at
  the entitlement call site — so an entitlement-path row can carry a warn after
  all. The claim that holds is the narrower one: nothing on the **cross-tenant**
  path emits a warn, and an entitlement denial where the **agent** lacked the
  grant emits none either. Both emitters are in scope for the correlation
  below — do **not** filter the stream to one of them.
- **Correlate in enforce mode only, against *both* emitters, and treat the join
  as probabilistic.** In enforce mode, match a same-company `denied` row
  against the warn stream on `actorAgentId` + `companyId` + time, and read the
  matched line's `action`:
  - `action: "company_access"` — the responsible-user **availability** leg
    (`code` is always `RESPONSIBLE_USER_UNAVAILABLE` here, per the bullet
    above).
  - `action: "runs:read_transcript"` with `code: RESPONSIBLE_USER_UNAUTHORIZED`
    — the responsible-user **authorization** leg. `denyCode` is `UNAUTHORIZED`
    exactly when the responsible user exists *and* holds an active membership
    (`services/authorization.ts`), so this is the case where the agent passed
    `assertCompanyAccess` silently and was then denied on the intersection.
  - **no match on either** — the agent's own entitlement denial.

  Filtering the stream to `action: "company_access"` and calling the residue
  the entitlement denial is the mistake this bullet exists to prevent: it sorts
  the authorization leg into "entitlement denial", so the responder reports an
  insider unentitled transcript read by an agent that **was** entitled — the
  denial came from its responsible user — and the investigation is pointed at
  the wrong principal. The row cannot correct that on its own: the decision's
  `RESPONSIBLE_USER_UNAUTHORIZED` code travels to the client in the 403 body
  via `authorizationDeniedDetails` and is **not** among the fields the audit
  writes (`result`, `actorSource`, `actorRunId`, `offset`, `limitBytes`,
  `logStore`). This is the same harm as the `actorSource` trap above, reached
  by a different mechanism. Note that `code` *is* the discriminator on the
  second emitter even though it is constant on the first — it is a property of
  each emitter, not of the stream.

  Reachability is not marginal, which is why the two-emitter form matters: an
  agent **API key** always carries a responsible user (`middleware/auth.ts`
  refuses a key whose responsible user is missing before building the actor),
  `runs:read_transcript` is a *mapped* action, and a mapped action skips the
  `allow_simple_company_member` visibility branch that unmapped read actions
  take — so the responsible user is re-decided against a per-user
  `runs:read_transcript` grant row that most members do not hold.

  Do **not** run any of this under shadow. The ⚠️ block above already answers
  the question directly there, and the correlation *inverts*: the
  `company_access` warn still fires, but the throw is suppressed, so the row it
  would have matched is never booked — while the same-company `denied` that
  *is* booked on `heartbeat.run_log_accessed` comes from the entitlement leg
  further down the same request and matches the warn on every key. The second
  emitter inverts the same way and for the same reason:
  `applyResponsibleUserIntersection` (`services/authorization.ts`) writes its
  warn *before* choosing what to return, then returns the agent's own decision
  under shadow — so the line **is** emitted and the denial books nothing.
  Following the rule in shadow mode therefore discards a genuine insider
  unentitled transcript read as an availability failure, which is the one
  direction this section exists to prevent.

  **Neither emitter is enforce-only, and the presence of either warn is not
  evidence the deployment is enforcing.** Read `authzMode` on the line itself:
  both emitters carry it as their first field, and it is the only mode signal
  either one gives you.

  Even in enforce mode the join is time-fuzzy: neither warn carries a request
  or run correlator, so the row's own `runId` and `details.actorRunId` have
  nothing on the log side to join to. For the `company_access` leg the
  imprecision is larger than per-request noise, because its condition — "this
  agent's responsible user has no active membership in this company" — is a
  **state**, not an event: while it holds, essentially every company-scoped
  request that agent makes emits the warn, from over twenty `assertCompanyAccess`
  call sites in `routes/agents.ts` alone. So a match establishes that the
  responsible user was unavailable *around that time* and carries almost no
  per-request information. That cuts both ways, and the useful half is the
  contrapositive: a single matching warn anywhere in the window is enough, so
  the responder does not need per-request alignment. Restricting candidates to
  `method: "GET"` buys one narrowing and only one — it drops the write-route
  noise from the other `assertCompanyAccess` call sites, since all three of
  these routes are GETs. ⚠️ Apply that filter to the `company_access` leg
  **only**: `method` is a field of the first emitter's warn, and the
  intersection warn does not carry it at all, so a blanket `method: "GET"`
  predicate over the whole stream silently drops every authorization-leg line
  and reproduces the single-emitter mistake this bullet exists to prevent.
  (`action` cannot tighten anything here either; it is the field being read to
  classify the match, so it is fixed by construction.)
  Finally, the log stream's retention is not `activity_log`'s, so on an older
  row the absence of a match may mean the logs aged out rather than that the
  denial was an entitlement one — though the state-not-event property above
  makes an aged-out `company_access` leg less likely than a single-event join
  would be.

Retention follows the deployment's normal
`activity_log` database retention and backup policy; Paperclip does not
currently apply a separate shorter retention window for these access-audit rows.

- Default local key path: `~/.paperclip/instances/default/secrets/master.key`
- Override key material directly: `PAPERCLIP_SECRETS_MASTER_KEY`
- Override key file path: `PAPERCLIP_SECRETS_MASTER_KEY_FILE`
- Back up the key file and database together; either one alone is not enough to restore local encrypted secrets.

Strict mode (recommended outside local trusted machines):

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

When strict mode is enabled, sensitive env keys (for example `*_API_KEY`, `*_TOKEN`, `*_SECRET`) must use secret references instead of inline plain values.
Authenticated deployments default strict mode on unless explicitly overridden.

CLI configuration support:

- `pnpm paperclipai onboard` writes a default `secrets` config section (`local_encrypted`, strict mode off, key file path set) and creates a local key file when needed.
- `pnpm paperclipai configure --section secrets` lets you update provider/strict mode/key path and creates the local key file when needed.
- `pnpm paperclipai doctor` validates secrets adapter configuration, can create a missing local key file with `--repair`, and reports missing AWS Secrets Manager bootstrap env when that provider is selected.
- Provider health is available at `GET /api/companies/:companyId/secret-providers/health` and reports local key permission warnings plus backup guidance.

Per-company provider vaults are configured in the board UI under
`Company Settings → Secrets → Provider vaults`, backed by
`/api/companies/{companyId}/secret-provider-configs`. The CLI does not own
vault lifecycle today. See `docs/deploy/secrets.md` (`Provider Vaults` section)
for the operator model.

Migration helper for existing inline env secrets:

```sh
pnpm secrets:migrate-inline-env         # dry run
pnpm secrets:migrate-inline-env --apply # apply migration
```

## Company Deletion Toggle

Company deletion is intended as a dev/debug capability and can be disabled at runtime:

```sh
PAPERCLIP_ENABLE_COMPANY_DELETION=false
```

Default behavior:

- `local_trusted`: enabled
- `authenticated`: disabled

## CLI Client Operations

Paperclip CLI now includes client-side control-plane commands in addition to setup commands.

Quick examples:

```sh
pnpm paperclipai issue list --company-id <company-id>
pnpm paperclipai issue create --company-id <company-id> --title "Investigate checkout conflict"
pnpm paperclipai issue update <issue-id> --status in_progress --comment "Started triage"
```

Set defaults once with context profiles:

```sh
pnpm paperclipai context set --api-base http://localhost:3100 --company-id <company-id>
```

Then run commands without repeating flags:

```sh
pnpm paperclipai issue list
pnpm paperclipai dashboard get
```

See full command reference in `doc/CLI.md`.

## Agent Invite Onboarding Endpoints

Agent-oriented invite onboarding now exposes machine-readable API docs:

The board UI generates agent onboarding prompts from the add-agent modal (`+` in the agent sidebar), so agent onboarding sits with the rest of agent creation rather than company member invite settings.

- `GET /api/invites/:token` returns invite summary plus onboarding and skills index links.
- `GET /api/invites/:token/onboarding` returns onboarding manifest details (registration endpoint, claim endpoint template, skill install hints).
- `GET /api/invites/:token/onboarding.txt` returns a plain-text onboarding doc intended for both human operators and agents (llm.txt-style handoff), including optional inviter message and suggested network host candidates.
- `GET /api/skills/index` lists available skill documents.
- `GET /api/skills/paperclip` returns the Paperclip heartbeat skill markdown.

Hermes gateway agents use this same generic agent invite flow with
`adapterType=hermes_gateway` and `agentDefaultsPayload.apiBaseUrl` /
`agentDefaultsPayload.apiKey`. See
[HERMES_GATEWAY_ONBOARDING.md](./HERMES_GATEWAY_ONBOARDING.md) for the full
operator path, including Hermes credentials, invite approval, key claim, and
fresh-state Docker smoke setup.

## OpenClaw Join Smoke Test

Run the end-to-end OpenClaw join smoke harness:

```sh
pnpm smoke:openclaw-join
```

What it validates:

- invite creation for agent-only join
- agent join request using `adapterType=openclaw_gateway`
- board approval + one-time API key claim semantics
- callback delivery on wakeup to a dockerized OpenClaw-style webhook receiver

Required permissions:

- This script performs board-governed actions (create invite, approve join, wakeup another agent).
- In authenticated mode, run with board auth via `PAPERCLIP_AUTH_HEADER` or `PAPERCLIP_COOKIE`.

Optional auth flags (for authenticated mode):

- `PAPERCLIP_AUTH_HEADER` (for example `Bearer ...`)
- `PAPERCLIP_COOKIE` (session cookie header value)

## OpenClaw Docker UI One-Command Script

To boot OpenClaw in Docker and print a host-browser dashboard URL in one command:

```sh
pnpm smoke:openclaw-docker-ui
```

This script lives at `scripts/smoke/openclaw-docker-ui.sh` and automates clone/build/config/start for Compose-based local OpenClaw UI testing.

Pairing behavior for this smoke script:

- default `OPENCLAW_DISABLE_DEVICE_AUTH=1` (no Control UI pairing prompt for local smoke; no extra pairing env vars required)
- set `OPENCLAW_DISABLE_DEVICE_AUTH=0` to require standard device pairing

Model behavior for this smoke script:

- defaults to OpenAI models (`openai/gpt-5.2` + OpenAI fallback) so it does not require Anthropic auth by default

State behavior for this smoke script:

- defaults to isolated config dir `~/.openclaw-paperclip-smoke`
- resets smoke agent state each run by default (`OPENCLAW_RESET_STATE=1`) to avoid stale provider/auth drift

Networking behavior for this smoke script:

- auto-detects and prints a Paperclip host URL reachable from inside OpenClaw Docker
- default container-side host alias is `host.docker.internal` (override with `PAPERCLIP_HOST_FROM_CONTAINER` / `PAPERCLIP_HOST_PORT`)
- if Paperclip rejects container hostnames in authenticated/private mode, allow `host.docker.internal` via `pnpm paperclipai allowed-hostname host.docker.internal` and restart Paperclip
