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

A manifest of `sha256(path)` over all 37 in-tree files, sorted by path under
`LC_ALL=C`, itself hashes to:

```
b74335fd51ba3a9d3d677aa7f7b4b8f8d120fed305051b9b38456c6263697832
```

Regenerate with:

```sh
cd vendor/paperclip-adapter-claude-k8s
git ls-files | grep -vxE 'LICENSE|PROVENANCE\.md' \
  | LC_ALL=C sort | xargs sha256sum | sha256sum
```

`LICENSE` and `PROVENANCE.md` are excluded because they are Blockcast additions,
not upstream files — the hash covers only what came from upstream. The listing
comes from `git ls-files` rather than `find` so that `node_modules/`, `dist/`
and packed tarballs cannot perturb it.

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

| commit | files | what |
|---|---|---|
| `cd1630512` | `src/server/env-guard.ts`, `src/server/env-guard.test.ts` | Anchored the `SAFE_ENV_INSPECTION_RE` safe-helper exception to a whole-command invocation. It was evaluated before the full-dump detector and matched the helper anywhere in the command, so a `<safe-helper> && <dump>` compound returned `allow` and executed the dump. Addresses an Ally review finding on Blockcast/paperclip#1092. |
| `cd1630512` | `src/server/k8s-client.ts`, `src/server/k8s-client.test.ts` (new) | Keyed the `getSelfPodInfo()` cache by (kubeconfig path, namespace, hostname). It memoized into one process-global slot while callers pass a per-request kubeconfig, leaking the first execution's image, scheduling, PVC, env and Secret references into later executions against a different cluster. Same review. |
| `8f4f7262a` | `src/server/env-guard.ts`, `src/server/env-guard.test.ts` | Treated `\r`/`\n` as command separators in both classifier copies. Anchoring the helper exception (above) closed the `&&`/`;`/`\|` compounds but not a literal newline: JS `$` without `m` is end-of-input and the argument tail's `\s` spanned newlines, so `paperclip-safe-env\nenv` was a whole-command match, and the dump detector did not treat `\n` as a boundary either. Follow-up on the same Ally review of Blockcast/paperclip#1092. |
| `551c461ef` | `src/server/env-guard.ts`, `src/server/env-guard.test.ts` | Two further dump forms in both classifier copies. (a) Flag-only dumps: `env`/`printenv` stop dumping only when given an *operand*, so requiring a boundary immediately after the utility name let `-0`, `--null` and `-u NAME` through; an option run is now consumed, with `-u`/`--unset` matched together with their argument. (b) Command substitution was never a boundary, so `echo "$(env)"`, `X=$(printenv)` and backtick forms were allowed with no flags at all. Third Ally review pass on Blockcast/paperclip#1092. |
| `551c461ef` | `src/server/job-manifest.ts`, `src/server/job-manifest.test.ts` | Made the init container's `data` mount conditional on a claim (an unconditional mount named an undeclared volume, which Kubernetes rejects for the whole Pod), and validated + shell-quoted `providers.anthropic.accounts` before interpolating it into the main container's `sh -c`. Same review pass. Both were revised again in `3e0244a78` below. |
| `435219ccf` | `src/server/env-guard.ts` | Comment-only correction. The header claimed behavioural parity with `server/src/agent-shell-guard.ts` "locked by `env-guard.test.ts`". Both halves were false — the test never imports that file and nothing imports it in production; it is dead code, then four fixed bypasses behind. Tracked for removal-or-resync as BLO-22840. |
| `3e0244a78` | `src/server/env-guard.ts`, `src/server/env-guard.test.ts` | Closed the unquoted-command-wrapper bypass class. `SHELL_WRAPPER_RE` unwraps only a *quoted* `-c` payload and whitespace was not a command boundary, so a dump passed as a bare argument to any wrapper (`sh -c env`, `eval env`, `xargs env`, `nohup env`, `timeout 5 env`, `su -c env`, ...) was allowed — 9 of 9 measured payloads, in the real spawned pod script. Split the boundary class: whitespace joins the *leading* class only, while the trailing terminator stays punctuation-only so operand-bearing forms (`env NAME=value cmd`, `printenv HOME`, `grep env file`) stay allowed. Fourth Ally review pass. |
| `3e0244a78` | `src/server/job-manifest.ts`, `src/server/job-manifest.test.ts` | Three manifest fixes from the same review. (a) Operator-configured mount paths (`workspaceMountPath`, `homeRoot`) reached the init container's `sh -c` unquoted via `browserHome`; now quoted at every site plus a new `assertSafeAbsolutePath` as an independent second defence. (b) A configured account pool with no valid entry fell back to ccrotate's *global* rotation — fail-open, widening credential scope on a config typo; absent and invalid configuration are now distinguished. (c) The `data` volume is now ALWAYS declared (PVC-backed, else `emptyDir`), because the conditional mount from `551c461ef` merely moved the no-PVC failure from admission to an EACCES `mkdir` as runAsUser:1000. |

The two cherry-picked commits in the composition above remain upstream commits
authored against the fork, not Blockcast-local patches.

Future changes to this directory are ordinary in-tree changes to this
repository: edit, open a PR, let CI run. There is no longer an external fork to
push to first, and `CLAUDE_K8S_REF` no longer exists. **Any change here must
update the integrity hash in the same PR** — CI fails the `vendor_claude_k8s`
job otherwise, and prints the expected value.

### The inert upstream workflow

`.github/workflows/ci.yml` is kept verbatim as part of the upstream tree. **It
does not run.** GitHub Actions only reads workflows from the repository-root
`.github/workflows/`, and this one is nested. The job that actually verifies
this directory is `vendor-claude-k8s` in
[`.github/workflows/pr.yml`](../../.github/workflows/pr.yml).
