# Provenance — `paperclip-adapter-claude-k8s`

This directory is **vendored third-party source**, not original Blockcast code.
It was brought in-tree under board approval `bf83f96d-4009-4673-8e60-aeb9c1f98079`
(BLO-17980 / BLO-22506 / BLO-22514) so that the credential-injection fix in
`src/server/job-manifest.ts` is reviewable under our own CI, and so a
single-owner external repository is no longer on the critical path of our
control plane.

## Origin

| | |
|---|---|
| Repository vendored from | <https://github.com/kkroo/paperclip-adapter-claude-k8s> |
| Package | `paperclip-adapter-claude-k8s` |
| Version at vendor time | `0.2.5-kkroo.6` |
| Current version | `0.2.6-blockcast.11` — see [Versioning](#versioning) |
| Declared license | MIT, in `package.json` only — see the caveat below |

Before this change the image built this package by cloning that repository at a
pinned SHA inside the Dockerfile `vendor` stage. That clone is gone; the build
now compiles the source in this directory.

### The upstream chain is thinner than it looks — verified 2026-08-06

`package.json` points its `repository`, `bugs` and `homepage` fields at
`https://github.com/farhoodlabs/paperclip-adapter-claude-k8s`. Checked against
the GitHub API with our App token:

- `farhoodlabs/paperclip-adapter-claude-k8s` → **HTTP 404**. Either it does not
  exist or it is private and we cannot see it. (Its sibling
  `farhoodlabs/paperclip-adapter-opencode-k8s` also 404s.)
- `kkroo/paperclip-adapter-claude-k8s` → exists, but `fork: false` and
  `parent: none`. **It is not a GitHub fork of anything**, so there is no
  fork-network link back to any upstream.
- GitHub detects **no license** on `kkroo/paperclip-adapter-claude-k8s`
  (`license: none`), because the repository ships no `LICENSE` file.

So the `farhoodlabs` URLs are unverifiable package metadata, not an
established provenance chain. `kkroo/paperclip-adapter-claude-k8s` is the only
artifact we can actually see, and it is what we vendored. This section says so
plainly rather than presenting a tidy upstream→fork story that the API does not
support.

## Exact composition

The vendored tree is **not** a single upstream commit. The deployed pin and the
outstanding security fix had **diverged**, so vendoring either one alone would
have regressed the other. Composition:

```
52649f8b826aa0d488cd5c303afe0bf02fd4af5f   common ancestor
 └─ 3ad33702052f357ec2b31b7d3051e89ed1ed4875   <- the previously deployed pin
      (merge of PR #29 — BLO-18551, exclude exact current lifecycle job)
 └─ 35f1eb2a331c798a8a956efeafffe48751882526   <- security fix, PR #31
 └─ 6ddd4b079cba1357a9b62cafefba7dcae9f186db   <- security follow-up, PR #31
```

`3ad3370` was the value of `CLAUDE_K8S_REF` in our Dockerfile. `6ddd4b07` was
the head of `kkroo/paperclip-adapter-claude-k8s#31`. Neither is an ancestor of
the other. **Vendoring PR #31's tree as-is would have silently reverted the
deployed PR #29 fix.**

This directory therefore contains `3ad3370` with `35f1eb2` and `6ddd4b0`
cherry-picked on top, in that order. Both cherry-picks applied without conflict.

### Reproducing it

```sh
git clone https://github.com/kkroo/paperclip-adapter-claude-k8s.git
cd paperclip-adapter-claude-k8s
git fetch origin 'refs/pull/31/head:pr31'
git checkout -B vendor-base 3ad33702052f357ec2b31b7d3051e89ed1ed4875
git cherry-pick 35f1eb2a331c798a8a956efeafffe48751882526 \
                6ddd4b079cba1357a9b62cafefba7dcae9f186db
```

The result matches this directory exactly, except for the two deliberate
exclusions below. Verified by `diff -r` at vendor time.

### Deliberate exclusions

Upstream commits two things this repository does not accept:

- `coverage/` — 27 generated lcov-report files. `vendor/README.md` forbids
  committing build artifacts.
- `.DS_Store` — macOS filesystem noise.

Everything else was byte-for-byte upstream at vendor time. 36 files vendored;
see [Local modifications](#local-modifications) for the Blockcast patches
applied since.

### Integrity

**There is no recorded integrity hash, deliberately — removed under
[BLO-35109](https://paperclip.blockcast.net/BLO/issues/BLO-35109).** What
replaced it is the append-only log in
[PROVENANCE-CHANGES.md](./PROVENANCE-CHANGES.md): CI fails any change that
touches vendored source without appending a row there
(`scripts/check-vendored-provenance-log.mjs`, run from the `policy` job).

A single 64-hex manifest of the tree used to be recorded here and recomputed by
CI. It was removed for three reasons, in ascending order of importance:

1. **It did not attest what it appeared to.** The hash was recomputed from *our*
   tree, which has diverged from upstream — so "hash matches" never meant
   "upstream is unmodified", only "the tree is what the last editor recorded".
   The section that stood here said as much in its final paragraph.
2. **It was a false-positive generator, not a conflict detector.** Two PRs
   editing different lines of the same vendored file merge correctly, and the
   combined tree's hash matched *neither* recorded value. It failed on every
   combination of two changes, correct or not, so it could not tell a bad merge
   from two good ones.
3. **It was single-valued, so it made concurrent work serial.** Every pair of
   PRs touching this tree conflicted on that one line. `merge=union`
   (BLO-34872) cannot reach it: a union keeps both sides' lines, and CI's
   `grep -oE '^[0-9a-f]{64}$' … | head -1` would then have resolved the
   provenance verdict by sort order rather than by the tree — failing
   permissively on one of the two orderings.

The property the hash existed for — vendored source does not change without the
change being recorded — survives, as a *transition* invariant checked against
the merge base instead of a *state* invariant stored in the file. Nothing is
stored, so nothing can conflict, and the in-diff review surface is now the log
row itself rather than an opaque hash nobody could verify by reading.

`scripts/__tests__/provenance-union-merge.test.mjs` asserts that no 64-hex line
is reintroduced into either provenance file, so a future revival is caught
rather than quietly re-creating the conflict.

The listing comes from `git ls-files` rather than `find` so that `node_modules/`,
`dist/` and packed tarballs cannot perturb it.

CI enforces this: the `vendor_claude_k8s` job recomputes the hash and fails if
it does not match the value recorded above. Change any vendored file and you
must update this hash in the same PR.

## License caveat — read before redistributing

`package.json` declares `"license": "MIT"`. That declaration is the **entire**
basis of the grant:

- the repository ships no `LICENSE` file at any of the SHAs above;
- GitHub's licence detector reports `none` for the repository;
- the `farhoodlabs` repository named in `package.json` returns 404, so we cannot
  read a licence there either;
- no individual copyright holder is named anywhere in the source.

[LICENSE](./LICENSE) in this directory reproduces the standard MIT text. Its
copyright line names the project rather than a person, because **no person is
identified to name** — that is an honest placeholder, not a researched
attribution.

MIT is unambiguous about what it permits and this is sufficient for our internal
use. But before Blockcast redistributes this code externally, or relicenses
anything derived from it, someone should obtain a real `LICENSE` file with a
named copyright holder from the author. Flagging it here rather than papering
over it. This is the one part of this vendoring that a human may want to close
out; it is not a blocker for the security fix.

## Local modifications

Beyond the composition described above, this directory now carries Blockcast
patches. They are ordinary in-tree changes, reviewed under our own CI — which is
the point of vendoring — but they mean the tree is **no longer byte-for-byte
upstream**, so they are enumerated here rather than left implicit.

The per-patch log lives in [PROVENANCE-CHANGES.md](./PROVENANCE-CHANGES.md),
a separate file so that concurrent PRs appending to it do not conflict
(BLO-34872). It is excluded from the integrity hash below.

The two cherry-picked commits in the composition above remain upstream commits
authored against the fork, not Blockcast-local patches.

Future changes to this directory are ordinary in-tree changes to this
repository: edit, open a PR, let CI run. There is no longer an external fork to
push to first, and `CLAUDE_K8S_REF` no longer exists. **Any change here must
update the integrity hash in the same PR** — CI fails the `vendor_claude_k8s`
job otherwise, and prints the expected value.

### Versioning

Upstream stopped moving this number: `0.2.5-kkroo.6` is the value at both
`c5d1389f` and upstream `master` (`1fef67c`), and it is what was deployed. So
after the first Blockcast change that ships, the version alone could no longer
tell you which code was running — provenance had to be established by grepping
`dist/` for a token.

This directory therefore versions itself: **`0.2.6-blockcast.11`**, set in
`package.json` and `package-lock.json`. The `-blockcast.` prerelease channel
says plainly that this is our tree, not an upstream release.

The PATCH digit is bumped rather than only the prerelease tag, deliberately.
Semver compares `major.minor.patch` **before** prerelease identifiers, so
`0.2.6-blockcast.1` > `0.2.5-kkroo.6`. Had we picked `0.2.5-blockcast.1`, the
prerelease identifiers would have decided it — and `blockcast` sorts *below*
`kkroo` alphabetically, making the release read as a downgrade to anything
comparing versions.

Bump `-blockcast.N` **only when something outside this directory needs to tell
two builds of it apart** — which, as of
[BLO-35109](https://paperclip.blockcast.net/BLO/issues/BLO-35109), nothing does.
Do **not** bump it per-PR.

Measured 2026-09-21: the `-blockcast.N` version string appears in exactly five
places, all of them inside this directory (`package.json`, `package-lock.json`
×2, and twice in this file). Nothing outside the vendored tree reads it. The
image builds this package from source and packs it with a glob —
`mv paperclip-adapter-claude-k8s-*.tgz` — so the number never reaches the
Dockerfile, which says so itself: *"claude_k8s — edit
vendor/paperclip-adapter-claude-k8s/ and open a PR. Nothing to pin or bump."*

Bumping it per-PR was not free. It put a version line in five places into every
vendored PR's diff, which is three of the four hunks that used to make any two
concurrent PRs on this tree conflict — for a number no consumer reads.

### The inert upstream workflow

`.github/workflows/ci.yml` is kept verbatim as part of the upstream tree. **It
does not run.** GitHub Actions only reads workflows from the repository-root
`.github/workflows/`, and this one is nested. The job that actually verifies
this directory is `vendor-claude-k8s` in
[`.github/workflows/pr.yml`](../../.github/workflows/pr.yml).
