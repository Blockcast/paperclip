# PEN-4932 — project the run's prompt bundle into a per-Job Secret (stage 4b)

New `src/server/prompt-bundle-projection.ts` plus a call site in
`src/server/execute.ts`. The module builds a per-run Secret projection of the
prompt bundle — the agent instructions and the run's resolved skill trees — and
`execute.ts` **measures** it. Nothing consumes the projection yet.

## Why the content has to travel

`prepareClaudePromptBundle` writes the bundle through `SELF_POD_DATA_MOUNT_PATH`
and the Job pod reads it at `resolveDataMountPath(config)`. Its own comment
states the assumption: *"One volume, TWO mount points"*. That is true today and
**false the moment the agent claim is per-agent** — same relative path, different
volume. The server would write a complete bundle into its own volume and the pod
would get the seeded, empty directory: `--add-dir` naming an empty tree and
`--append-system-prompt-file` naming a file that does not exist, silently,
because nothing on the write side errors.

So the bytes travel instead of a path to them, on PEN-3329's precedent
(`shared-doc-overlay.ts`): the server reads them and the adapter stages them as a
per-Job Secret volume. A value delivered that way is mount-shape-independent,
which is precisely the property a per-agent claim takes away.

## What is projected: the run's entries, not the company tree

`skills/<companyId>` is the obvious unit and the wrong one. A `local_path`
locator need not be under the managed root at all — `company-skills.ts` branches
on exactly that — so a Secret built from the company tree would carry catalog and
managed-`local_path` skills and silently omit project-scan ones. That is the
dangling link this channel exists to prevent, and indistinguishable from the bug.
Projecting the entries `prepareClaudePromptBundle` is actually handed covers
every `sourceType` by construction.

## Measurement only, deliberately

The pod still reads the bundle off the shared volume and will until
`dataClaimName` is swapped. `buildPromptBundleSecretProjection` **refuses** over
budget rather than truncating — correct once the Secret IS the delivery path, a
pure regression today, since it would abort a run over a budget that buys that
run nothing. So every outcome is logged and stepped over. What it buys ahead of
the swap is the one thing §4.2 could not get otherwise: the fleet distribution of
projected Secret size against the 50 % escalation trigger, measured on real
traffic rather than guessed at under an outage.

## The budget is decoded bytes, not base64

`ValidateSecret` sums `len(value)` over `secret.Data` (`map[string][]byte`)
against `MaxSecretSize = 1 MiB`, and `Convert_v1_Secret_To_core_Secret` folds
`StringData` in as `[]byte(v)` **before** validation. Keys are validated but not
counted. §4.2's sample was recorded as "16.8 % of the cap"; that figure is
base64-inflated (176,397 / 130,390 = 1.353), and the same sample is **12.4 %** of
the budget actually enforced. Safe for the guard, *not* for the trigger: a 50 %
threshold on base64 bytes fires at an effective 37.5 % of real capacity. Both are
now computed on one `totalValueBytes`, so they cannot disagree about what is
being measured.

## Three properties corrected in review, each a way to under-deliver silently

**The image-path exclusion is not a path-prefix test.** An earlier head excluded
any entry whose source was not under `SELF_POD_DATA_MOUNT_PATH` and called that
"the same discriminator `prompt-cache.ts` already applies". It is not.
`prompt-cache.ts:509-519` records that the prefix test is correct *for an image
path only*: a catalog-backed source is a `PAPERCLIP_HOME` path (an env var
defaulting to `~/.paperclip`) and the server mount is a hardcoded `/paperclip` —
two variables that coincide today, not one. Where they diverge the prefix test
classifies **every catalog skill** as image-bundled and drops it with no signal.
`skillSourceNeedsProjection` now keys on `catalogBackedSkillKeys` OR the mount
prefix, and only the remainder is an image path.

**Files travel as bytes.** Reading every file as `"utf-8"` substitutes U+FFFD for
each invalid byte, so a PNG, a font or a Latin-1 file in a skill tree would be
delivered corrupted *and* measured at 3 bytes per invalid byte — wrong for exactly
the trees this measurement most needs to size. Files are read as `Buffer`s and
classified with `new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })`;
valid UTF-8 goes to `stringData`, the rest base64 to `data`. `ignoreBOM` is
load-bearing in the other direction — the default strips a leading U+FEFF, which
would silently drop three bytes. The projection is deliberately **two maps** so
that a consumer wiring only `stringData` is a type error: `createOrAdoptRunSecret`
takes a single record and writes it to `stringData`, correct for the shared-doc
Secret it was built for, and reaching for that signature by analogy here would
drop the whole binary channel.

**Skipped symlinks are counted.** The walk steps over links rather than following
them, so one cannot escape the tree; `skippedSymlinkCount` and
`skippedNonRegularCount` make that trade observable instead of a claim.
⛔ `hashPathContents` (`prompt-cache.ts:196-205`) *resolves* links and hashes the
target, so a symlinked file the pod receives today would be absent once the Secret
becomes the delivery path. Harmless while this is measurement-only; recorded in
§4.2 as a hard constraint on the swap PR, which must resolve within-tree targets
or refuse rather than merely report the number.

## Sizing is cached, refusals included

`buildPromptBundleSecretProjection` re-reads every desired skill file, and
`prepareClaudePromptBundle` has already hashed the same trees — so an uncached
call costs a second full content read of the skill farm per run on the
Job-creation critical path, on the CephFS mount whose stalls are this issue's
subject, purely for a log line. The measurement is cached on `bundleKey` plus the
three inputs the filter reads that the key does not cover (source paths, server
mount, catalog set). Only the numbers are retained, never the projected bytes,
and the map is bounded at 256 entries.

The over-budget and too-many-files **refusals are cached too** — they are
deterministic for a given key, and caching only successes would leave exactly the
largest bundles, the ones this exists to find, re-reading the farm forever. A
transient I/O fault is rethrown *unremembered*: caching one would suppress the
measurement for the life of the process on the strength of a blip. The cached
refusal carries structured fields rather than the error's message, because the
message names the run that first hit it and replaying that would put one run's id
beside another's in the same line.

`name`, not `instanceof`, discriminates those two errors. A prototype check
compares class identity per module instance, and this module's graph is partially
mocked — measured: a `PromptBundleTooManyFilesError` was misrouted into the
over-budget branch under the full suite while passing in isolation. `name` is
narrowed to a literal on each class so the discriminant is in the type system too.

## Tests

`src/server/prompt-bundle-projection.test.ts` (new) — layout and recursion,
positional keys against the non-injective `/`→`__` collision, determinism across
input order, decoded-vs-base64 measurement, image-path exclusion, catalog-backed
projection outside the mount, over-budget and file-count refusals, binary
round-trip, BOM preservation, and symlink counting. `src/server/execute.test.ts`
gains `promptBundleSizingKey` coverage (each input the key exists to capture,
order-insensitivity, a NUL-in-field non-collision) and a `describeProjectionRefusal`
case asserting no run identity survives into a cached refusal, with a positive
control that the previously-cached message did carry one.

Each was verified to fail against the pre-fix behaviour by mutation rather than
merely to pass. Full adapter suite 28 files / 1789 tests green.

## Not in this change

The swap itself: provisioning the per-agent claim and pointing `dataClaimName` at
it, and making the pod read the bundle from the Secret. The refusal becomes
load-bearing in that change, not this one. The issue's acceptance criterion — two
agent pods on one node reporting distinct volume IDs — is **not** met here.
