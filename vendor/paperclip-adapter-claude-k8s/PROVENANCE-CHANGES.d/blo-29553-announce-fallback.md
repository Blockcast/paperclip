# BLO-29553 follow-up: announce the pod-log redactor's fail-open, and execute the fragment in tests

Change: [BLO-29553](https://paperclip.blockcast.net/BLO/issues/BLO-29553), follow-up to `blo-29553.md`.

Files: `src/server/pod-log-redactor.ts`, `src/server/pod-log-redactor.test.ts`, `PROVENANCE-CHANGES.d/blo-29553.md`

Closes the two Suggestions from Ally's at-head review of [#2240](https://github.com/Blockcast/paperclip/pull/2240). They were deliberately not pushed at the time: that PR sat in the REBASE merge queue with a clean at-head attestation, and a push would have ejected it, voided the attestation that had just satisfied the review gate, and re-run 20 checks on a shared pool to land one `echo`.

**The fail-open now announces itself.** `buildPodLogRedactorSetupShell()` degrades to `cat` when `node` is missing or the script is not on disk — deliberately, so a lost install race cannot take every run in the fleet down through `set -o pipefail`. That degradation was **silent**, which is the wrong failure posture for this particular control: "redacted" and "fell open to `cat`" were indistinguishable after the fact, on the one guard whose entire purpose is that it held. A pod log could be read as scrubbed when nothing scrubbed it. The appended `|| echo … >&2` covers both silent paths and, as a side effect, makes the statement exit 0 rather than leaving a non-zero status mid-fragment.

The per-line fail-open inside the script stays silent by design: it is per-line and *inside* the filter, where a diagnostic would itself be a write into the stream being filtered.

**The fragment is now executed in tests rather than string-matched.** Every prior assertion about it — and there were several — was a `toContain` on the generated text. That cannot settle a precedence question, and this change introduces one: `A && B && { … } || C` fires `C` when **either** probe fails, and would fire it spuriously if the braced group ever returned non-zero, printing "not installed" beside a filter that *is* installed. The new tests run the real fragment under `/bin/sh` across all three branches (both available / node missing / script missing), asserting the filter variable, `rc=0`, and the presence or absence of the warning on stderr. The container command is `sh -c` (`job-manifest.ts`), so `/bin/sh` is the binding target; the behaviour was separately confirmed identical under `dash` and `bash`.

`$GUARD_DIR` is a tmpdir. Pre-creating the target short-circuits the `[ -f ] ||` install, which is what lets the node-missing case use an empty `PATH` without also breaking `base64` and `mv` — otherwise that case would conflate "node missing" with "install failed" and prove neither.

**Mutations, 7, one per run, baseline restored between each — all red.** Three are new here; four are from the #2240 round, **re-run rather than quoted**, so every row in `blo-29553.md`'s table is something one run actually measured.

| mutation | result |
|---|---|
| `\|\| echo … UNREDACTED` diagnostic dropped | 2 failed |
| `command -v node` probe dropped | 2 failed |
| braced group returns non-zero (spurious warning beside an installed filter) | 1 failed |
| no-op redactor (transform emits the raw line) | 1 failed |
| `flush` handler dropped | 1 failed |
| `flush` emits the tail UNREDACTED | 1 failed |
| single-var quoting reverted | 1 failed |

Each mutation **asserts its own anchor matched exactly once before the suite is read**. That is not ceremony: a substitution that silently fails to apply reports the baseline's green and is indistinguishable from a guard that does not bind — it produced one void "5/5 passed" reading on #2240. Here it earned its keep in the other direction too, flagging two false VOIDs, because `command -v node` also occurs in a docblock and a naive `grep` liveness check reported VOID on a mutation that had in fact applied. The lesson is to anchor on the exact code text and assert the count, not to grep for the token.

`blo-29553.md` is corrected alongside: the missing mutation rows, and the fail-open posture restated as **three** paths (per-line throw, script missing, node missing) rather than two, with which of them announce and why the third does not.

316 tests pass across both suites; `tsc --noEmit` reports 0 errors. All fixtures synthetic — no live credential was used or read, per this ticket's withdrawn original verifying signal.
