# vendor/

**Everything here is vendored source** committed into this repo and built from
the tree. As of PEN-3916 (2026-10-10) there are no fork pins left:

- `paperclip-adapter-claude-k8s/`   — vendored 2026-08-06 (BLO-17980)
- `paperclip-adapter-opencode-k8s/` — vendored 2026-10-10 (PEN-3916)

No build artifacts (`.tgz`, `dist/`, `node_modules/`, `coverage/`) are committed;
`COPY --from=vendor` ships only the resulting `.tgz` into the final image.

## Why both are here

Each of these packages templates every agent Job/Pod spec for its adapter —
**including the Job's PATH, which is a security control** (PEN-2527 / PEN-3152 /
PEN-3156 route all GitHub egress through wrapper binaries, and PEN-3713 makes
them win by putting the root-owned image directory first on PATH).

Both used to be cloned at a pinned SHA from a **personal** GitHub account
outside our App installation, which meant a change to that code path could be
made by one person and nothing here reviewed it. For `claude_k8s` a critical
credential-injection finding sat unfixable for days; for `opencode_k8s` the
PEN-3732 PATH mirror could not be sent anywhere at all, and was parked as a
patch file on an unmergeable PR until this vendoring carried it in.

Measured 2026-10-09 with `git push --dry-run`, which writes nothing: the
upstream repo, its existing `allyblockcast` fork, and `POST /repos/…/forks` all
return `403` to an agent seat.

### What vendoring costs, stated plainly

It forks the code. Upstream keeps moving, and picking up one of its commits is
now a deliberate port rather than a pin bump. That trade was weighed with
numbers rather than assumed — see each tree's `PROVENANCE.md` — and the short
version is that over the 64 days after the claude vendoring, our own reviewed
changes to the vendored tree outnumbered upstream's commits roughly 3:1.

## Working on a vendored adapter

**To change one:** edit the source and open an ordinary PR. There is no fork to
push to and nothing to pin.

Two things you must also do:

1. **Add a provenance entry.** One new file per change:
   `<adapter>/PROVENANCE-CHANGES.d/<issue-or-pr>.md`, free-form prose saying
   what changed and why. `scripts/check-vendored-provenance-log.mjs` (the
   `policy` job) fails any PR that touches vendored source without one, for
   either tree. One file per change, never a shared table — see
   `paperclip-adapter-claude-k8s/PROVENANCE-CHANGES.d/README.md` for the
   measurement behind that.
2. **Bump the version if you are shipping it**, in `package.json`,
   `package-lock.json` *and* the `Current version` row of `PROVENANCE.md`. CI
   compares the last two (PEN-3223); they have drifted before.

There is **no integrity hash** in either tree, deliberately (BLO-35109). It was
single-valued, so every pair of concurrent PRs conflicted on it, and it could
not tell a bad merge from two good ones.
`scripts/__tests__/provenance-union-merge.test.mjs` asserts one is not
reintroduced.

### CI

Each tree has its own job in `.github/workflows/pr.yml`, both on the required
`verify` path:

| tree | job |
|---|---|
| `paperclip-adapter-claude-k8s/` | `vendor_claude_k8s` |
| `paperclip-adapter-opencode-k8s/` | `vendor_opencode_k8s` |

Both packages are deliberately **outside** the pnpm workspace and the root
tsconfig project references, so those jobs are the *only* things that compile or
test them. Do not remove a job without moving its coverage somewhere real — the
tree would be dead-lettered, which is strictly worse than the fork pin it
replaced.

Note the `npm config omit=dev` hazard both jobs guard against: on some runner
images (and on agent sandboxes) that config is set, `npm ci --include=dev` does
**not** override it, and the job turns into a no-op that still reports green.
`NPM_CONFIG_OMIT=` is what overrides it, and `vendor_opencode_k8s` additionally
asserts `tsc` and `vitest` are present before using them.

## Historical note

Earlier revisions of this file documented a "Fork pins" workflow —
`ARG CLAUDE_K8S_REF` / `ARG OPENCODE_K8S_REF`, how to bump them, and a hazard
about pinning a PR branch head that is about to be squash-merged (BLO-33204:
`git clone` fetches only ref-reachable objects, so the squash orphaned the
pinned SHA and every cache-missing build died with `fatal: unable to read tree`
while cache-hitting builds kept passing).

Both ARGs are retired and that whole class is now unrepresentable, so the
guards built for it are gone too: `scripts/check-opencode-k8s-pin-reachable.mjs`,
`scripts/opencode-k8s-runtime-cache-pin.test.js`, their tests, and the hourly
`adapter-pin-drift-monitor.yml`. The Dockerfile keeps each adapter's
bump-by-bump changelog above its retired `*_REF` marker as history.

The two *tree* properties the opencode pin guard checked did not go away with
it; they became ordinary in-tree review:

- no PUT-verb Secret call site (BLO-34510) →
  `paperclip-adapter-opencode-k8s/src/server/rbac-secret-verbs.test.ts`
- the GitHub-egress wrapper PATH (PEN-3732) → five behavioural cases in that
  adapter's own `job-manifest.test.ts`, plus the structural chart check in
  `deploy/helm/paperclip/tests/agent-egress-path.test.mjs`

That is a strengthening, not a like-for-like move: the retired probe grepped a
cloned tree for a *mention* of the wrapper directory, which attests presence and
not ordering. The replacement asserts the ordering itself.

The ownership question these pins raised is now fully resolved for both
adapters; `doc/ADAPTER-REPO-OWNERSHIP.md` records the outcome.
