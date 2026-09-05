# AGENTS.md

Guidance for human and AI contributors working in this repository.

## 1. Purpose

Paperclip is a control plane for AI-agent companies.
The current implementation target is V1 and is defined in `doc/SPEC-implementation.md`.

## 2. Read This First

Before making changes, read in this order:

1. `doc/GOAL.md`
2. `doc/PRODUCT.md`
3. `doc/SPEC-implementation.md`
4. `doc/DEVELOPING.md`
5. `doc/DATABASE.md`

`doc/SPEC.md` is long-horizon product context.
`doc/SPEC-implementation.md` is the concrete V1 build contract.

## 3. Repo Map

- `server/`: Express REST API and orchestration services
- `ui/`: React + Vite board UI
- `packages/db/`: Drizzle schema, migrations, DB clients
- `packages/shared/`: shared types, constants, validators, API path constants
- `packages/adapters/`: agent adapter implementations (Claude, Codex, Cursor, etc.)
- `packages/adapter-utils/`: shared adapter utilities
- `packages/plugins/`: plugin system packages
- `doc/`: operational and product docs

## 4. Dev Setup (Auto DB)

Use embedded PGlite in dev by leaving `DATABASE_URL` unset.

```sh
pnpm install
pnpm dev
```

> **`NODE_ENV=production` and `pnpm install`.** pnpm treats `NODE_ENV=production`
> as an implicit `--prod` and skips every devDependency **while still exiting 0**.
> The agent toolchain image inherits `NODE_ENV=production` from the
> `paperclip-runtime` base, so this bites agents in particular. The repo's
> `.npmrc` sets `production=false` to neutralize it — do not remove that line
> (the `prod=false` alias does **not** work; only `production=false` does).
> If you ever see `devDependencies: skipped because NODE_ENV is set to production`
> in install output, the resulting tree has no `vitest` / `typescript` / `tsx`,
> so no test, typecheck or build entrypoint will run. Re-run with
> `pnpm install --prod=false`. This is not specific to `git worktree`; a plain
> checkout installs just as incompletely. See BLO-19064.

This starts:

- API: `http://localhost:3100`
- UI: `http://localhost:3100` (served by API server in dev middleware mode)

Quick checks:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Reset local dev DB:

```sh
rm -rf data/pglite
pnpm dev
```

## 5. Core Engineering Rules

1. Keep changes company-scoped.
Every domain entity should be scoped to a company and company boundaries must be enforced in routes/services.

2. Keep contracts synchronized.
If you change schema/API behavior, update all impacted layers:
- `packages/db` schema and exports
- `packages/shared` types/constants/validators
- `server` routes/services
- `ui` API clients and pages

3. Preserve control-plane invariants.
- Single-assignee task model
- Atomic issue checkout semantics
- Approval gates for governed actions
- Budget hard-stop auto-pause behavior
- Activity logging for mutating actions

4. Do not replace strategic docs wholesale unless asked.
Prefer additive updates. Keep `doc/SPEC.md` and `doc/SPEC-implementation.md` aligned.

5. Keep repo plan docs dated and centralized.
When you are creating a plan file in the repository itself, new plan documents belong in `doc/plans/` and should use `YYYY-MM-DD-slug.md` filenames. This does not replace Paperclip issue planning: if a Paperclip issue asks for a plan, update the issue `plan` document per the `paperclip` skill instead of creating a repo markdown file.

6. Attach inspectable generated artifacts.
When your task produces a user-inspectable deliverable file, follow the Paperclip skill's "Generated Artifacts and Work Products" workflow before final disposition. In this repo, prefer the self-contained skill helper at `skills/paperclip/scripts/paperclip-upload-artifact.sh` so the file is available through the Paperclip API, create/update an artifact work product when the file is the deliverable, link the uploaded artifact in the final issue comment, and then set status. Do not rely on local filesystem paths as the only access path. If an important file intentionally remains workspace-only, create/update a work product with `metadata.resourceRef.kind: "workspace_file"` and a workspace-relative path, then name that work product and path in the final comment. Treat browse/search as a fallback for recovering workspace files, not the preferred deliverable path. See `doc/AGENT-ARTIFACTS.md` for details and `.mp4`/`.webm` examples.

## 6. Database Change Workflow

When changing data model:

1. Edit `packages/db/src/schema/*.ts`
2. Ensure new tables are exported from `packages/db/src/schema/index.ts`
3. Generate migration:

```sh
pnpm db:generate
```

4. Validate compile:

```sh
pnpm -r typecheck
```

Notes:
- `packages/db/drizzle.config.ts` reads compiled schema from `dist/schema/*.js`
- `pnpm db:generate` compiles `packages/db` first

## 7. Verification Before Hand-off

Default local/agent test path:

```sh
pnpm test
```

This is the cheap default and only runs the Vitest suite. Browser suites stay opt-in:

```sh
pnpm test:e2e
pnpm test:release-smoke
```

Run the browser suites only when your change touches them or when you are explicitly verifying CI/release flows.

For normal issue work, run the smallest relevant verification first. Do not default to repo-wide typecheck/build/test on every heartbeat when a narrower check is enough to prove the change.

Run this full check before claiming repo work done in a PR-ready hand-off, or when the change scope is broad enough that targeted checks are not sufficient:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

If anything cannot be run, explicitly report what was not run and why.

## 8. API and Auth Expectations

- Base path: `/api`
- Board access is treated as full-control operator context
- Agent access uses bearer API keys (`agent_api_keys`), hashed at rest
- Agent keys must not access other companies

When adding endpoints:

- apply company access checks
- enforce actor permissions (board vs agent)
- write activity log entries for mutations
- return consistent HTTP errors (`400/401/403/404/409/422/500`)

## 9. GitHub Access From Agent Workspaces

Agent pods authenticate to GitHub as the `allyblockcast[bot]` GitHub App
installation. The token is mounted at `/paperclip/.secrets/github-token/token`
and injected by the `gh` wrapper (`scripts/gh-token-wrapper.sh`) on every
invocation. It is deliberately **not** exported into the shell environment, so
`$GH_TOKEN` is empty in your terminal even though `gh` is fully authenticated.

**Never treat `permissions.push: false` as proof you lack write access.** Every
GitHub repository payload — `GET /repos/{owner}/{repo}`, `search_repositories`,
even `/installation/repositories` — carries a `permissions` object describing a
*user's* role (`admin`/`maintain`/`push`/`pull`/`triage`). An App installation
token has no user role, so GitHub returns **all-false for every repo**,
including ones the installation can demonstrably write to. The field is
structurally meaningless for our credential; reading it as an access check
returns a false negative 100% of the time. `/installation/repositories` makes
this obvious: it only lists repos the installation *can* access, and still
reports `push: false` for all of them.

Probe the actual write path before concluding you lack access, and before
filing any access-escalation issue:

```bash
gh api /installation/repositories --paginate --jq '.repositories[].full_name' | grep <repo>
git push origin HEAD:refs/heads/probe/<ticket>   # delete the branch afterwards
```

If the repo is in the installation list, you have access — a failure is a
tooling bug, not a permissions gap. In particular, `git push` to a **private**
repo failing with `remote: Invalid username or token` means git had *no*
credential, not an insufficient one. Public repos hide this because they clone
anonymously. The image wires `credential.https://github.com.helper` to the `gh`
wrapper in `Dockerfile.runtime` to close that gap; do not "fix" a recurrence by
running `gh auth setup-git`, which writes a `gh.real` helper that cannot read
the token file. Widening an installation's repository selection is never the
right remedy for these symptoms.

### Repos outside the App installation (BLO-22243)

The App installation can only ever cover repos owned by the same account it's
installed on. A repo owned by a *different* account — e.g.
`allyblockcast/paperclip-adapter-claude-k8s`, a `User`-owned repo, not an
`Organization` one — is permanently out of `allyblockcast[bot]`'s reach. That
shows up as a bare `remote: Permission ... denied to allyblockcast[bot]` /
`403` on push, which reads like a missing grant but usually isn't one.

A second credential is mounted fleet-wide at
`/paperclip/.secrets/github-merge-token/token`: a classic PAT for the
`allyblockcast` **user** account (scopes `repo, write:packages,
delete:packages, admin:public_key`). It reaches 31 repos — 29 `Blockcast/*`
plus 2 `allyblockcast/*` — with push access on 11 of them, including repos
the App installation cannot see at all.

Do not point `gh`/`git` at this token by default. It is broader than the App
installation and already mounted in every pod, so wiring it in unconditionally
would silently widen every agent's effective write access with no new grant
having actually been made. Instead opt in for a single invocation via
`GH_SEAT_TOKEN_VALUE`, the narrow per-call override both `gh` and `git`
already honor:

```bash
# gh
GH_SEAT_TOKEN_VALUE="$(cat /paperclip/.secrets/github-merge-token/token)" \
  gh pr create --repo allyblockcast/paperclip-adapter-claude-k8s --title "..." --body "..."

# git push (same variable — the git credential helper reads it too)
GH_SEAT_TOKEN_VALUE="$(cat /paperclip/.secrets/github-merge-token/token)" \
  git push https://github.com/allyblockcast/paperclip-adapter-claude-k8s.git HEAD:refs/heads/<branch>
```

Confirm the target repo is actually in this token's reach before relying on
it — e.g. `GH_SEAT_TOKEN_VALUE="$(cat /paperclip/.secrets/github-merge-token/token)" gh api /user/repos --paginate --jq '.[].full_name'`
— rather than assuming every out-of-installation repo is covered. If it
isn't, that's a real access gap: escalate rather than widening this PAT's
use further.

### Commit attribution is write-path dependent, not agent dependent (BLO-21416)

Every agent pod authenticates as the same shared credential — the
`allyblockcast[bot]` GitHub App installation (id `290875700`). GitHub's REST
commit-creation endpoints (`PUT /repos/{owner}/{repo}/contents/{path}`, the
merge API, and the MCP `create_or_update_file`/`push_files` tools, which are
thin wrappers over the same endpoints) default `commit.author` to the
*authenticated* identity whenever the caller doesn't supply one — so **every
agent's commit made through that path is stamped `allyblockcast[bot]`**,
regardless of which agent actually wrote it. The `git` write path is not
subject to that server-side default, and since BLO-29050 it no longer depends
on a checkout's local config either: **every run's adapter process is launched
with `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL`
already set to the acting agent's identity** (`applyAgentGitIdentityToRuntimeConfig`
in `server/src/services/git-checkout-identity.ts`, wired at dispatch in
`heartbeat.ts`; landed `a54de973a`, 2026-08-23). Git gives those four variables
precedence over local, global, and system config, and child processes inherit
them — so a commit made from *any* directory carries your identity, including an
ad-hoc `git clone` you made yourself, with no `git config` run by you.

`policy` failing on a commit you made with `git` is therefore not proof of a
REST/MCP write, but the diagnostic is the **commit**, not the config: read
`git log -1 --pretty='%an <%ae>'`. A local `user.email` that disagrees is
cosmetic — it loses to the environment.

This is a controlled, reproduced finding (BLO-21416), not a hunch — do not
re-derive it or re-file it as a fresh misattribution report:

- **Use `git push` for every repo commit.** It is the only write path that
  *can* be correctly per-agent. Do not use the MCP `create_or_update_file` /
  `push_files` tools to land commits — they have no `author` field in their
  schema, so there is no way to override the App stamp through them, and using
  them silently erases your authorship.
- **Do not hand-set a per-checkout identity — it is provisioned for you, and
  your write would lose anyway.** The environment overlay above beats
  `git config --local`, `--global` and `--system`, so `git config user.email`
  reporting nothing (or someone else's address) is **not** a defect and needs no
  repair: verified 2026-09-05 on a fresh `git init` with no identity in any
  config file, and again with a conflicting local `user.email` set, both of
  which committed as the acting agent. If you genuinely need a *different*
  author for one commit, only a per-invocation environment override reaches it
  (`GIT_AUTHOR_EMAIL=… GIT_COMMITTER_EMAIL=… git commit …`); `-c user.email=…`
  will not. Earlier revisions of this file called this "a known, unfixed
  provisioning gap (BLO-23894)" and told you to run `git config` by hand — that
  was true of the 2026-08-10 sweep (71 checkouts: 11 App-stamped, 18 with no
  identity) and was fixed by BLO-29050.
- If you must create a commit via the raw API (no local checkout available),
  use `gh api` directly and pass an explicit author, e.g.:
  ```bash
  gh api repos/{owner}/{repo}/contents/{path} -X PUT \
    -f message="..." -f content="$(base64 -w0 file)" -f branch="..." \
    -f 'author[name]=<AgentName>' -f 'author[email]=<agentnamekey>@paperclip.blockcast.net'
  ```
  `gh api` is a call site you control, so the explicit `author` sticks —
  unlike the MCP tool, which has no equivalent field to set.
- **Do not read `commit.author.login == allyblockcast[bot]` as identifying a
  specific agent (or the reviewer `allyblockcast` user account, id
  `296676656` — a distinct principal from the App, id `290875700`).** It
  identifies the write path, not the author. It also does not identify
  `allyblockcast[bot]`-the-reviewer's own commits, if any — the App has no
  commits of its own; it is a shared write credential every agent inherits.
- **Merge and squash-merge commits are legitimately App-attributed** — GitHub
  itself creates those via the merge API on your behalf. This is out of
  scope; don't flag them.
- **The gate matches only the numeric-prefixed App email
  (`290875700+allyblockcast[bot]@users.noreply.github.com`), deliberately not
  the bare `allyblockcast[bot]@users.noreply.github.com`.** That bare form is
  the `graphify-reindex` bot's own legitimate `git push` identity, verified
  against real PRs (#789, #944) — widening the match would flag its
  commits. If your checkout's local `user.email` shows the bare form, that
  is still a misconfigured checkout (see above): fix the local config; do
  not ask the gate to catch it, it cannot distinguish the two cases by email
  alone.
- CI enforces this going forward on every `paperclip` PR
  (`scripts/check-commit-author-attribution.mjs`, wired into `pr.yml`); an
  on-demand cross-repo audit mode (`--audit-merged`) covers
  `Blockcast/trafficcontrol` and `Blockcast/paperclip` for retroactive checks.
- **Commits authored before 2026-08-09T01:38:20Z (`ATTRIBUTION_GATE_CUTOFF`)
  are grandfathered by an explicit SHA allowlist, not a date comparison
  (BLO-23894).** That timestamp is when the gate above landed on master
  (`e7162b906` / `3fa6e41d8`) — the first moment the rule was knowable — and
  it still bounds which commits are *eligible* for grandfathering, but the
  gate no longer trusts a commit's own `authorDate` to decide the question:
  `authorDate` is caller-controlled (`GIT_AUTHOR_DATE`, `git commit --date`)
  on the `git push` write path this gate also polices, so a pure date cutoff
  can be defeated by backdating a brand-new violation straight past it. The
  actual grandfather list is `GRANDFATHERED_OFFENSE_SHAS` in
  `scripts/check-commit-author-attribution.mjs` — a finite, enumerated set of
  the specific pre-cutoff commit shas this gate cannot ask anyone to fix (the
  App stamp already destroyed the acting agent's identity, so there is no
  correct author to rewrite it to, and guessing one would write a false
  attribution — the exact harm this gate exists to prevent). **If `policy`
  fails your PR on a commit that genuinely predates the cutoff (its
  `authorDate` is verifiably before it) and isn't clearing, that's either a
  gap in the allowlist or your commit got a new sha from a local `git
  rebase`** (file either against BLO-23894's owner, with the sha, to add it)
  — don't work around it: squashing relabels other contributors'
  correctly-attributed commits under one author, and force-pushing rewrites a
  human contributor's history and can orphan branches stacked on top. An
  ordinary GitHub "Update branch" (merge) leaves a grandfathered commit's sha
  untouched and does not trigger this. `--audit-merged` still reports
  pre-cutoff violations; treat those as historical record, not something to
  fix.

## 10. UI Expectations

- Keep routes and nav aligned with available API surface
- Use company selection context for company-scoped pages
- Surface failures clearly; do not silently ignore API errors

## 11. Pull Request Requirements

When creating a pull request (via `gh pr create` or any other method), you **must** read and fill in every section of [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md). Do not craft ad-hoc PR bodies — use the template as the structure for your PR description. Required sections:

- **Thinking Path** — trace reasoning from project context to this change (see `CONTRIBUTING.md` for examples)
- **What Changed** — bullet list of concrete changes
- **Verification** — how a reviewer can confirm it works
- **Risks** — what could go wrong
- **Model Used** — the AI model that produced or assisted with the change (provider, exact model ID, context window, capabilities). Write "None — human-authored" if no AI was used.
- **Checklist** — all items checked

## 12. Definition of Done

A change is done when all are true:

1. Behavior matches `doc/SPEC-implementation.md`
2. Typecheck, tests, and build pass
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change
5. PR description follows the [PR template](.github/PULL_REQUEST_TEMPLATE.md) with all sections filled in (including Model Used)

## 13. Fork-Specific: HenkDz/paperclip

This is a fork of `paperclipai/paperclip` with QoL patches and an **external-only** Hermes adapter story on branch `feat/externalize-hermes-adapter` ([tree](https://github.com/HenkDz/paperclip/tree/feat/externalize-hermes-adapter)).

### Branch Strategy

- `feat/externalize-hermes-adapter` → core has **no** `hermes-paperclip-adapter` dependency and **no** built-in `hermes_local` registration. Install Hermes via the Adapter Plugin manager (`@henkey/hermes-paperclip-adapter` or a `file:` path).
- Older fork branches may still document built-in Hermes; treat this file as authoritative for the externalize branch.
- If `Blockcast/master` falls more than 20 commits behind `paperclipai/master`, merge upstream before opening new cross-upstream PRs so reviewers do not see fork-drift noise as part of unrelated changes.

### Hermes (plugin only)

- Register through **Board → Adapter manager** (same as Droid). Type remains `hermes_local` once the package is loaded.
- UI uses generic **config-schema** + **ui-parser.js** from the package — no Hermes imports in `server/` or `ui/` source.
- Optional: `file:` entry in `~/.paperclip/adapter-plugins.json` for local dev of the adapter repo.

### Local Dev

- Fork runs on port 3101+ (auto-detects if 3100 is taken by upstream instance)
- `npx vite build` hangs on NTFS — use `node node_modules/vite/bin/vite.js build` instead
- Server startup from NTFS takes 30-60s — don't assume failure immediately
- Kill ALL paperclip processes before starting: `pkill -f "paperclip"; pkill -f "tsx.*index.ts"`
- Vite cache survives `rm -rf dist` — delete both: `rm -rf ui/dist ui/node_modules/.vite`

### Fork QoL Patches (not in upstream)

These are local modifications in the fork's UI. If re-copying source, these must be re-applied:

1. **stderr_group** — amber accordion for MCP init noise in `RunTranscriptView.tsx`
2. **tool_group** — accordion for consecutive non-terminal tools (write, read, search, browser)
3. **Dashboard excerpt** — `LatestRunCard` strips markdown, shows first 3 lines/280 chars

### Plugin System

PR #2218 (`feat/external-adapter-phase1`) adds external adapter support. See root `AGENTS.md` for full details.

- Adapters can be loaded as external plugins via `~/.paperclip/adapter-plugins.json`
- The plugin-loader should have ZERO hardcoded adapter imports — pure dynamic loading
- `createServerAdapter()` must include ALL optional fields (especially `detectModel`)
- Built-in UI adapters can shadow external plugin parsers — remove built-in when fully externalizing.
- Reference external adapters: Hermes (`@henkey/hermes-paperclip-adapter` or `file:`) and Droid (npm).

## Design system

`DESIGN.md` at the repo root is the source of truth for UI design decisions. The token-only rule applies to all `ui/` changes: every color, spacing, radius, type, shadow, and motion value in `ui/src/components/**` and `ui/src/pages/**` comes from the token layer in `ui/src/index.css` — no hex, raw px, arbitrary Tailwind bracket values, or raw `font-size`/`fontSize` declarations in components, outside the documented allowlist in `ui/src/index.css`. Run `pnpm check:token-gates` (`scripts/check-token-gates.mjs`) before committing UI changes — it fails on any violation not covered by that allowlist.
