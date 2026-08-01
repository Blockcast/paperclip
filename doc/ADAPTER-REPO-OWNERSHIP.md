# `paperclip-adapter-claude-k8s` repo ownership

**Status: open — waiting on one human GitHub action.**
**Decision date: 2026-08-07.** Tracking issue: BLO-18174.

## Why this file exists

The `claude_k8s` adapter plugin renders every agent Job/Pod spec this fleet
runs. It lives at `github.com/kkroo/paperclip-adapter-claude-k8s` — a **personal
account**, not the `Blockcast` org.

That ownership has three operational consequences, all re-verified 2026-08-01:

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

Both must change under either path — the mirror makes it same-change, the
transfer merely makes it non-urgent because GitHub redirects:

- `Dockerfile:399` — the vendor-stage `git clone`, pinned by
  `ARG CLAUDE_K8S_REF` (`Dockerfile:177`).
- `vendor/README.md` — the "Fork:" URL. Note the `Upstream:` URL recorded there
  does not currently resolve, and `kkroo/paperclip-adapter-claude-k8s` is not a
  GitHub fork of anything; that line is stale and should be corrected whenever
  this file is next touched.

`adapter-plugins.json` and `/opt/paperclip-bundled-adapters` are **not**
affected: they are local-dev only. Production packaging clones, builds and packs
the tarball, and the packed artifact's name comes from `package.json`, not the
repo URL — so it is independent of ownership.
