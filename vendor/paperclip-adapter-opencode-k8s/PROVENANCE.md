# Provenance — `paperclip-adapter-opencode-k8s`

This directory is **vendored third-party source**, not original Blockcast code.
It was brought in-tree under [PEN-3916](https://paperclip.blockcast.net/PEN/issues/PEN-3916),
mirroring what BLO-17980 did for the `claude_k8s` sibling on 2026-08-06, so that
the adapter rendering every `opencode_k8s` Job spec — including its PATH, which
is a security control — is reviewable under our own CI rather than shipping
through a personal account no agent seat can push to.

## Origin

| | |
|---|---|
| Repository vendored from | <https://github.com/kkroo/paperclip-adapter-opencode-k8s> |
| Package | `paperclip-adapter-opencode-k8s` |
| Vendored at commit | `133f4c1a65085a6c141aab5aa8818afe51e2689c` |
| Version at vendor time | `0.2.7` |
| Current version | `0.2.8-blockcast.1` — see [Versioning](#versioning) |
| Declared license | MIT, in `package.json` only — see the caveat below |

Before this change the image built this package by cloning that repository at a
pinned SHA inside the Dockerfile `vendor` stage (`ARG OPENCODE_K8S_REF`). That
clone is gone, the ARG is retired, and the build now compiles the source in this
directory.

### Why this was vendored — the decision, and the measurement behind it

The adapter renders every `opencode_k8s` Job spec. A change to a security
control in that code path could be made **by one person only**, and nothing in
this repository reviewed it. Measured 2026-10-09 with `git push --dry-run`
(which writes nothing):

| target | result |
|---|---|
| `kkroo/paperclip-adapter-opencode-k8s` | `403` — `Permission to … denied to allyblockcast[bot]` |
| `allyblockcast/paperclip-adapter-opencode-k8s` (existing fork) | `403` — same |
| `POST /repos/…/forks` (new fork under `Blockcast`) | `403 Resource not accessible by integration` |

PEN-3916 asked whether upstream velocity made the fork cost a worse trade here
than it was for `claude_k8s`. It does not, and the measurement runs the other
way from the framing. Commits on `kkroo/paperclip-adapter-opencode-k8s` `master`:

| month | commits |
|---|---|
| 2026-04 | 98 |
| 2026-05 | 39 |
| 2026-06 | 26 |
| 2026-07 | 25 |
| 2026-08 | 12 |
| 2026-09 | 1 |
| 2026-10 | 3 (all on 10-07) |

Velocity has fallen ~30x from April. The three 2026-10-07 merges cited as
evidence that "upstream keeps moving" are a **burst, not a rate**: 3 of only 11
commits in the 64 days since the `claude_k8s` precedent, arriving in one day
after a 27-day gap, which itself followed a 33-day gap.

The control that settles it — `claude_k8s` was vendored 2026-08-06 and its
upstream has kept moving since, so the precedent is a live test of the fork
cost rather than a case where upstream went quiet. All four rows below were
measured 2026-10-10 over the identical window, 2026-08-06 → 2026-10-09:

| | count |
|---|---|
| upstream commits, `kkroo/paperclip-adapter-opencode-k8s` | 11 |
| upstream commits, `kkroo/paperclip-adapter-claude-k8s` (the forked control) | 9 |
| `PROVENANCE-CHANGES.d/` entries added to the vendored claude tree | 27 |
| commits touching vendored claude **source** (`.../src`) | 119 |

So the fork cost opencode would take is close to the one `claude_k8s` has been
paying for two months — and over that window our own reviewed change volume
against the forked tree was **3x upstream's by recorded change and ~13x by
commit**. The tree that is actually moving is ours; "can we review our own
changes to it" dominates "how often must we port theirs".

> **Two measurement hazards, both recorded because each produced a wrong number
> first.**
>
> 1. **Wrong remote.** The clone at `/paperclip/paperclip-adapter-claude-k8s`
>    has `origin` pointed at the `allyblockcast` **fork**, which has not
>    advanced past 2026-07-29. Measured there, claude upstream reads `0`
>    commits since vendoring — a clean, plausible, wrong number that would have
>    overstated the case for vendoring. The figures above are from `kkroo/*`
>    directly, positive-controlled (45 commits since 2026-07-01 on the same
>    call).
> 2. **Mixed date conventions.** PEN-3916's decision comment reported these as
>    "9 and 9 — an *identical* rate". That is **withdrawn**: it compared
>    opencode by git *author* date against claude by *commit* date. Re-measured
>    with one call and one convention for both (`GET /repos/{r}/commits` with
>    `since`/`until`, i.e. commit date), it is 11 and 9. The direction of the
>    argument is unchanged and the local-change ratio is larger than first
>    stated, but "identical" was an artifact of the inconsistency, not a
>    finding. `git log --since` on this repo still reports 11 for opencode and
>    9 by author date, which is where the discrepancy came from.

Low velocity does not shrink the exposure; it makes each unreviewed change a
larger fraction of the total. All 9 of those upstream commits changed
Job-rendering code — including `#64`, which rewrote how the opencode binary is
bootstrapped onto the data PVC — and none were reviewed here.

### The upstream chain is thinner than it looks — verified 2026-10-10

Checked against the GitHub API with our App token:

- `kkroo/paperclip-adapter-opencode-k8s` → exists, public, but `fork: false`
  and `parent: none`. **It is not a GitHub fork of anything**, so there is no
  fork-network link back to any upstream.
- GitHub detects **no license** (`license: none`); the repository ships no
  `LICENSE` file (`contents/LICENSE` → **404**).
- `farhoodlabs/paperclip-adapter-opencode-k8s` → **HTTP 404**.

**One difference from the claude sibling, and it cuts the other way.** That
package's `package.json` at least *named* a `farhoodlabs` upstream in its
`repository`, `bugs` and `homepage` fields (all unresolvable). This one declares
**none of those fields at all** — so there is not even an unverifiable URL to
chase. `kkroo/paperclip-adapter-opencode-k8s` is the only artifact we can see,
and it is what we vendored. Do not restate the claude PROVENANCE's
`farhoodlabs`-URL wording here; it is not true of this package.

## Exact composition

Unlike `claude_k8s`, which had to be composed from a base plus two cherry-picks
because its deployed pin and its security fix had diverged, this is **a single
unmodified upstream snapshot**. The deployed pin *is* `master` HEAD exactly:

```
$ git rev-list --count 133f4c1a65085a6c141aab5aa8818afe51e2689c..master
0
```

There is no composition to get wrong.

### Reproducing it

```sh
git clone https://github.com/kkroo/paperclip-adapter-opencode-k8s.git
cd paperclip-adapter-opencode-k8s
git archive 133f4c1a65085a6c141aab5aa8818afe51e2689c | tar -x -C <this directory>
```

44 files. Then apply the one Blockcast patch recorded under
[Local modifications](#local-modifications).

### Deliberate exclusions

**None.** The claude vendoring had to drop a committed `coverage/` tree and a
`.DS_Store`; this repository commits neither, so the snapshot above is the
upstream tree in full.

### Integrity

**There is no recorded integrity hash, deliberately** — the same position
BLO-35109 reached for the claude sibling, adopted here from the start rather
than installed and later withdrawn. A single stored 64-hex manifest is
single-valued by construction, so every pair of concurrent PRs touching this
tree conflicts on one line; it cannot tell a bad merge from two good ones; and
it never attested upstream-ness anyway, since it was recomputed from our own
(diverging) tree.

What enforces the property instead — vendored source does not change without
the change being recorded — is the per-change log in
[PROVENANCE-CHANGES.d/](./PROVENANCE-CHANGES.d/).
`scripts/check-vendored-provenance-log.mjs`, run from the `policy` job, fails
any PR that touches vendored source without adding a file there. It is a
*transition* invariant checked against the merge base, so nothing is stored and
nothing can conflict.

`scripts/__tests__/provenance-union-merge.test.mjs` asserts that no 64-hex line
is reintroduced into the provenance files, so a future revival is caught.

## License caveat — read before redistributing

`package.json` declares `"license": "MIT"`. That declaration is the **entire**
basis of the grant:

- the repository ships no `LICENSE` file at the SHA above;
- GitHub's licence detector reports `none` for the repository;
- the `package.json` names no upstream repository at all, so there is nowhere
  else to read a licence from;
- no individual copyright holder is named anywhere in the source.

[LICENSE](./LICENSE) in this directory reproduces the standard MIT text. Its
copyright line names the project rather than a person, because **no person is
identified to name** — that is an honest placeholder, not a researched
attribution.

MIT is unambiguous about what it permits and this is sufficient for our internal
use. But before Blockcast redistributes this code externally, or relicenses
anything derived from it, someone should obtain a real `LICENSE` file with a
named copyright holder from the author. Flagging it here rather than papering
over it; it is not a blocker for the security fix. This is the same open item
the claude sibling carries, and closing one does not close the other.

## Local modifications

Beyond the snapshot above, this directory carries Blockcast patches. They are
ordinary in-tree changes, reviewed under our own CI — which is the point of
vendoring — but they mean the tree is **no longer byte-for-byte upstream**, so
they are enumerated here rather than left implicit.

The per-patch log lives in [PROVENANCE-CHANGES.d/](./PROVENANCE-CHANGES.d/), one
file per change so that concurrent PRs recording their own do not conflict
(BLO-34872). There is no frozen predecessor table here — this directory started
with the per-change design, so unlike the claude sibling there is no
`PROVENANCE-CHANGES.md` and nothing to avoid appending to.

Future changes are ordinary in-tree changes to this repository: edit, open a PR,
let CI run. There is no external fork to push to first, and `OPENCODE_K8S_REF`
no longer exists.

### Porting from upstream after this point

Upstream keeps moving, and picking up one of its commits is now a **deliberate
port rather than a pin bump**. That is the accepted cost recorded above, not an
oversight. The claude sibling demonstrates the workflow is real rather than
hypothetical: `PROVENANCE-CHANGES.d/claude-code-runtime-pin.md` records upstream
#34 plus #33's catalog rows ported onto an already-diverged vendored tree, under
ordinary review.

To port an upstream commit, cherry-pick or re-apply it against this tree, run
the adapter's own suite, and add a `PROVENANCE-CHANGES.d/` entry naming the
upstream SHA.

### Versioning

Upstream is at `0.2.7`. This directory versions itself **`0.2.8-blockcast.1`**,
set in `package.json` and `package-lock.json`. The `-blockcast.` prerelease
channel says plainly that this is our tree, not an upstream release, so the
version alone tells you which code is running without grepping `dist/`.

The PATCH digit is bumped rather than only the prerelease tag, for the same
reason the claude sibling does it: semver compares `major.minor.patch` **before**
prerelease identifiers, so `0.2.7-blockcast.1` would sort *below* plain `0.2.7`
and read as a pre-release of the upstream version it is actually ahead of.

CI asserts this number against the Origin table above (`vendor_opencode_k8s`
job, `Verify vendored version is recorded consistently`), because the pair is
hand-maintained in two places and drifted on the claude sibling for three heads
(PEN-3223).
