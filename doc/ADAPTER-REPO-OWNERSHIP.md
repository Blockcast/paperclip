# k8s-Job adapter repo ownership

**Status: RESOLVED for every adapter this repo builds, as of 2026-10-10
(PEN-3916).** Neither `claude_k8s` nor `opencode_k8s` is cloned from
`kkroo/*` any more; both are vendored in-tree under `vendor/` and both
`ARG *_REF` pins are retired. **No human GitHub action is outstanding.**

**Original decision date: 2026-08-07.** Tracking issues: BLO-18174 (the
question), BLO-17980 (`claude_k8s` vendored 2026-08-06), PEN-3916
(`opencode_k8s` vendored 2026-10-10).

> **Read this before acting on anything below.** The transfer and mirror
> sections are retained as a RECORD of the options that were considered, and
> because the underlying repositories still exist and are still personally
> owned. They are **no longer asks**. Vendoring resolved the dependency without
> needing either, which is the point worth carrying forward: the fallback that
> required no specific individual turned out not to be the mirror, but to be
> taking the code in-tree.
>
> This file previously said the ownership question "now applies only to
> `paperclip-adapter-opencode-k8s`". That sentence is now spent.

## Why this file exists

Each k8s-Job adapter plugin renders every agent Job/Pod spec this fleet runs
for its adapter type — including the Job's PATH, which is a security control.
Both lived on a **personal account**, not the `Blockcast` org:
`github.com/kkroo/paperclip-adapter-claude-k8s` and
`github.com/kkroo/paperclip-adapter-opencode-k8s`.

That ownership had three operational consequences, originally verified
2026-08-01 against the claude repo and re-verified 2026-10-09 against the
opencode one with `git push --dry-run` (which writes nothing) — the upstream
repo, its existing `allyblockcast` fork, and `POST /repos/…/forks` all `403`:

1. **No agent can open a pull request against it.** The `allyblockcast` App
   installation token returns `403 Resource not accessible by integration` on
   `POST /pulls`. Reads work only because the repo is public.
2. **It has no automated review coverage.** Ally's review path needs the repo to
   be in the org App installation. The most recent merges went in without it.
3. **There is no agent-writable channel on the repo at all** — not even to ask
   for help. `POST /pulls` and `POST /issues/{n}/comments` both `403`, and
   GitHub Issues are disabled on the repo (`has_issues: false`). A stall here is
   invisible from inside the repo, which is how the current one went five days
   without a nudge.

Everything the fleet actually consumes is pinned by SHA, so none of this is
urgent in the "something is broken" sense. It is a governance and bus-factor
problem: changes to the substrate that executes every agent ship through one
person, unreviewed.

## Who can unblock it

| Path | Who is required |
| --- | --- |
| **Transfer** (preferred) | The `kkroo` account holder, **and** a `Blockcast` org owner to accept |
| **Mirror to org** (fallback) | **Any** `Blockcast` org member with repo-create rights. Does *not* need `kkroo` account rights |

The distinction is the entire point. Transfer depends on one specific
individual; the fallback depends on a role that several people hold.

## The ask (transfer)

1. Transfer `kkroo/paperclip-adapter-claude-k8s` to the `Blockcast` org.
2. Add the transferred repo to the existing `allyblockcast` GitHub App
   installation's repository list (it is in selected-repository mode).
3. Confirm the `allyblockcast` user's write grant covers the new location.

Then this repo gets a one-line follow-up repointing the references in
[Where this repo is referenced](#where-this-repo-is-referenced).

## Fallback: mirror into the org

Create `Blockcast/paperclip-adapter-claude-k8s` empty, then:

```sh
git clone --mirror https://github.com/kkroo/paperclip-adapter-claude-k8s.git
cd paperclip-adapter-claude-k8s.git
git push --mirror https://github.com/Blockcast/paperclip-adapter-claude-k8s.git
```

Measured 2026-08-01, so the trade is concrete rather than hypothetical:

| Dimension | Value |
| --- | --- |
| Repo size | 1.2 MB |
| Commits on `master` | 221 |
| Refs | ~30 branches, ~30 tags |
| Open PRs | 0 |
| Open issues | 0 (Issues disabled) |
| Forks / stars / watchers | 0 / 0 / 0 |
| Closed PRs | 28 |

**Preserved by the mirror:** all 221 commits, all branches, all tags. The repo
is standalone (`fork: false`), so there is no fork network to sever.

**Lost by the mirror:**

- The 28 **closed** PR pages — review threads and PR descriptions. The code and
  commit messages survive in git history; the discussion around them does not.
  Merge commits keep their `#N` text, but those links stop resolving.
- The transfer redirect. This makes updating the references below **mandatory
  and simultaneous**, not a follow-up.

The old personal-account repo should be archived afterwards so it cannot
silently diverge.

## Where this repo is referenced

**Resolved for claude_k8s as of 2026-08-06 (BLO-17980).** That adapter is no
longer cloned from `kkroo/paperclip-adapter-claude-k8s` at all — its source is
vendored in-tree at `vendor/paperclip-adapter-claude-k8s/` and
`ARG CLAUDE_K8S_REF` is retired. The single-owner dependency this document was
written to address is gone for claude_k8s; the ownership question below now
applies only to `paperclip-adapter-opencode-k8s`. See
`vendor/paperclip-adapter-claude-k8s/PROVENANCE.md`.

That vendoring also settled the stale-reference question flagged here: the
`Upstream:` URLs were checked against the GitHub API and
`farhoodlabs/paperclip-adapter-claude-k8s` (and its opencode sibling) return
**404**, while `kkroo/paperclip-adapter-claude-k8s` reports `fork: false` /
`parent: none` — it is not a GitHub fork of anything. `vendor/README.md` has
been corrected accordingly.

**Resolved for opencode_k8s as of 2026-10-10 (PEN-3916).** That adapter is no
longer cloned either: its source is vendored at
`vendor/paperclip-adapter-opencode-k8s/`, `ARG OPENCODE_K8S_REF` is retired, and
the `vendor` build stage now needs no GitHub credential at all — `gh_token`
(`PAPERCLIP_BOARD_TOKEN`) existed solely for that clone and was removed from
`docker.yml` with it. The guards built around the pin went with it too
(`scripts/check-opencode-k8s-pin-reachable.mjs`,
`scripts/opencode-k8s-runtime-cache-pin.test.js`, the hourly
`adapter-pin-drift-monitor.yml`); the tree properties they asserted are now
ordinary in-tree tests. See
`vendor/paperclip-adapter-opencode-k8s/PROVENANCE.md`.

That vendoring also discharged PEN-3732, whose PATH fix had nowhere to be sent:
it is now `PROVENANCE-CHANGES.d/pen-3732.md` in the vendored tree.

**Nothing in this repository references either `kkroo/*` repo as a build
input any more.** The remaining mentions are provenance and history.

`adapter-plugins.json` and `/opt/paperclip-bundled-adapters` are **not**
affected: they are local-dev only. Production packaging clones, builds and packs
the tarball, and the packed artifact's name comes from `package.json`, not the
repo URL — so it is independent of ownership.
