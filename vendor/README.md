# vendor/

Two different things live here:

1. **Vendored source** committed into this repo and built from the tree
   (currently: `paperclip-adapter-claude-k8s/`).
2. **Fork pins** — packages still cloned at a pinned SHA by the Dockerfile's
   `vendor` build stage (currently: `paperclip-adapter-opencode-k8s`).

No build artifacts (`.tgz`, `dist/`, `node_modules/`, `coverage/`) are committed
either way; `COPY --from=vendor` ships only the resulting `.tgz` into the final
image.

## Vendored source

### paperclip-adapter-claude-k8s  →  `./paperclip-adapter-claude-k8s/`

Brought in-tree 2026-08-06 under board approval `bf83f96d` (BLO-17980 /
BLO-22506 / BLO-22514). It templates every agent Job pod, and a critical
credential-injection finding sat unfixable in a repository outside our GitHub
App installation — we could neither open a PR against it nor run it through our
own CI. `ARG CLAUDE_K8S_REF` is retired.

- Upstream / fork history, exact composition SHAs, license caveat, and an
  integrity manifest: [`paperclip-adapter-claude-k8s/PROVENANCE.md`](./paperclip-adapter-claude-k8s/PROVENANCE.md)
- Verified in CI by the `vendor_claude_k8s` job in `.github/workflows/pr.yml`,
  which is on the required `verify` path. It is deliberately outside the pnpm
  workspace and the root tsconfig references, so that job is the *only* thing
  that compiles or tests it.

**To change it:** edit the source and open an ordinary PR. There is no fork to
push to and nothing to pin. If you change any vendored file you must also update
the integrity hash in `PROVENANCE.md` — CI fails otherwise.

## Fork pins

Pinned by commit SHA in the Dockerfile's `ARG *_REF` lines.

### paperclip-adapter-opencode-k8s

- Repository: <https://github.com/kkroo/paperclip-adapter-opencode-k8s>
- Its `package.json` names `farhoodlabs/paperclip-adapter-opencode-k8s` as
  upstream, but that URL returns **404** to our token and the kkroo repo is not
  a GitHub fork of it (verified 2026-08-06, same as its claude sibling). Treat
  the kkroo repo as the only verifiable source. Earlier revisions of this file
  described a clean upstream→fork relationship; it does not check out.
- What's carried over: parent-pod scheduling inheritance matching the
  claude adapter. Older adapter preflights still check `command -v ccrotate`,
  but Paperclip no longer installs a local `ccrotate` binary in the production
  image; provider routing is owned by ccrotate-serve/state.

### How to refresh a fork pin

1. Cut the change against the relevant kkroo fork on github (push directly
   or via PR + merge).
2. Bump the corresponding `*_REF` ARG in the Dockerfile to the new commit
   SHA. Pinning by SHA (not branch name) keeps image builds reproducible.
3. Build the image. The `vendor` stage clones the fork at the pinned SHA,
   runs the package's build, and packs the result.

## Historical note

Before the claude adapter was vendored, this file recorded what our fork carried
over upstream for it: run-isolated job workspace bootstrap, the `tailPodLogFile`
stable-size drain loop, the unknown-session `clearSession` handler, and
`nodeSelector`/`tolerations` inheritance from the parent Paperclip pod. All of
that is now ordinary in-tree source under `paperclip-adapter-claude-k8s/`, and
the Dockerfile keeps the full bump-by-bump changelog above the retired
`CLAUDE_K8S_REF` marker.
