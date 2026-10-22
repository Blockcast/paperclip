# PEN-4518 follow-up — the adapter-utils vitest alias is monorepo-only

Tracking: [PEN-4518](https://paperclip.blockcast.net/PEN/issues/PEN-4518) (the change this corrects) · [PEN-4515](https://paperclip.blockcast.net/PEN/issues/PEN-4515) (the row blocked by the red `main` it caused)

Recorded here rather than in `PROVENANCE-CHANGES.md`: that file is frozen (BLO-34872) because concurrent appends to it conflict on GitHub's server-side merge and get ejected from the merge queue.

## What broke

PEN-4518 §3 added the `@paperclipai/adapter-utils` resolve alias to opencode-k8s's `vitest.config.ts`, so that `src/server/job-manifest.test.ts` would stop collecting 0 tests from that directory. It did fix that. It also **reddened the image build on every commit from `a7cd822d` onward** — `master` had no publishable image for 24 minutes and counting when this was found, which blocks every deploy, not only the one this author was waiting on.

The alias replacement is `../../packages/adapter-utils/src/*.ts`, resolved against `import.meta.url`. That path exists in a monorepo checkout. It does **not** exist in the image build, where the Dockerfile copies the adapter directory *alone* to `/vendor/opencode-k8s-src` and installs `@paperclipai/adapter-utils` from a packed tarball into local `node_modules`.

So the alias rewrote a bare specifier that node could have resolved perfectly well into an absolute path to a missing file:

```
FAIL  src/server/execute.test.ts [ src/server/execute.test.ts ]
Error: Cannot find package '@paperclipai/adapter-utils' imported from /vendor/opencode-k8s-src/src/server/execute.ts
```

**A helper that makes a working import fail.** The error names the package, so it reads as a missing dependency — the one thing it is not; the tarball installs fine and `node_modules/@paperclipai/adapter-utils` is present at version `0.3.1`.

## Why the sibling did not catch it

claude-k8s has carried the identical alias for longer and its image build is green, which is the detail that makes this hard to see. The two Dockerfile steps are not symmetric:

| adapter | image build step | alias exercised there? |
|---|---|---|
| claude-k8s | `npm ci && npm install <tgz> && npm run build` | **no** — runs no tests |
| opencode-k8s | `npm ci && npm install <tgz> && npm test -- env-guard-plugin.test.ts execute.test.ts && npm run build` | **yes** |

`tsc` resolves `@paperclipai/adapter-utils` through `node_modules`, never through the vitest alias, so `npm run build` cannot see this. Only a vitest run outside the monorepo can — and only opencode-k8s does one. The claude-k8s copy is the same latent defect with nothing currently exercising it.

## The fix

Apply the alias only when the monorepo source is actually present:

```ts
const hasMonorepoAdapterUtils = existsSync(adapterUtilsSrc("index.ts"));
const adapterUtilsAlias = hasMonorepoAdapterUtils ? [ /* ... */ ] : [];
```

In a checkout the alias applies and `job-manifest.test.ts` keeps collecting; standalone it falls through to ordinary node resolution against the installed tarball, which is what the image already provides. Applied to **both** adapters — the claude-k8s copy is latent today, and the two configs are kept in mirror (PEN-3732 is the row that exists because that drifted).

Fixing the config rather than deleting the `npm test` from the Dockerfile step: that step is the only thing in CI that runs an adapter suite the way the image builds it, and it is what caught this.

## The absent branch is now reachable from a test

The condition's false branch only occurs *outside* a monorepo checkout — which is precisely where none of our suites run, so nothing could assert it. `buildAdapterUtilsAlias` therefore moves to `src/server/adapter-utils-alias.ts` taking `exists` and `resolveSrc` as injected parameters, and `src/server/adapter-utils-alias.test.ts` drives both branches directly. Four tests in each adapter, pinning: no alias at all when the source is absent (the regression), that the probe is made against the very module the alias points at, and that the bare pattern stays anchored so it cannot swallow a subpath import.

Mutation-checked rather than assumed green — three mutants, all killed, restored file passes:

| mutant | result |
|---|---|
| guard removed (**the PEN-4518 regression itself**) | 2 of 4 fail |
| bare `find` pattern unanchored | 1 fails |
| probes `package.json` instead of the `index.ts` it aliases to | 1 fails |

Note what this test can and cannot do. It covers the **decision**; it does not re-run the image build, and the new suite does not execute in the image (that Dockerfile step names two files explicitly). The thing that actually caught this regression — and would catch another — is opencode-k8s's `npm test` step inside the image build. The unit test makes the absent branch *assertable in review* rather than only observable from a red build an hour later.

## Verification — both branches exercised, with a failing control first

The pre-fix state **is** the mutation test for the guard (unconditional alias), and it was reproduced outside Docker before anything was changed, by copying the adapter to a directory with no `../../packages` above it, building `adapter-utils.tgz` by the Dockerfile's own recipe, and installing it:

| run | before | after |
|---|---|---|
| isolated (image-like), the two Dockerfile test files | **1 failed \| 1 passed · 90 tests** — identical to CI, same error text | **2 passed · 222 tests** |
| in-repo, `job-manifest.test.ts` (the suite the alias exists for) | 142 passed | **142 passed** |

Both arms of the condition are therefore exercised by a real run: it evaluates false in the isolated tree (the tests could not otherwise pass — a stale alias there fails exactly as above) and true in the checkout (0 tests would collect otherwise).

Full CI recipe, `npm ci --include=dev && npx --no-install tsc --noEmit && vitest run`, in both vendor directories:

- `paperclip-adapter-opencode-k8s`: **21 files / 715 tests**, `tsc` clean.
- `paperclip-adapter-claude-k8s`: **24 files / 1671 tests**, `tsc` clean.

The isolated image-like run was repeated after the helper was extracted, confirming the config's new `./src/server/adapter-utils-alias.js` import also resolves standalone: 2 passed / 222 tests.
