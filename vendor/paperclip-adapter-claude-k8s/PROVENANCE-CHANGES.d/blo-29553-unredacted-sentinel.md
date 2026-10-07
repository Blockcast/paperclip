# BLO-29553 follow-up: a durable sentinel beside an unredacted pod log

Change: [BLO-29553](https://paperclip.blockcast.net/BLO/issues/BLO-29553), follow-up to `blo-29553-announce-fallback.md` in the same PR ([#2268](https://github.com/Blockcast/paperclip/pull/2268)).

Files: `src/server/pod-log-redactor.ts`, `src/server/pod-log-redactor.test.ts`, `src/server/job-manifest.ts`, `src/server/job-manifest.test.ts`

Addresses Ally's Important finding at head `1642bed6`. The fail-open announcement went only to container stderr. The pipeline has no `2>&1` into `tee <podLogPath>`, and the Job is reaped at `ttlSecondsAfterFinished` (default 300), so five minutes after the run the unredacted pod log persisted and the only evidence that it was unredacted was gone.

**The fall-open branch now also writes an empty `<podLogPath>.unredacted` sentinel** beside the pod log. It outlives the pod and travels with an orphaned log. The stderr line stays for live triage. Nothing is written into the log itself, which the server parses as one JSON object per line. `buildPodLogRedactorSetupShell()` therefore takes the pod log path. `cleanupJob` unlinks the pod log on normal completion but not the sentinel. That is deliberate: `execute.ts` tails the same unredacted stream into the derived run-log store, so the sentinel's claim about the run stays true after the pod log is gone.

**The redactor setup moved after `preparePodLog`** in `job-manifest.ts`. The sentinel needs the pod log's directory, and `preparePodLog` (`mkdir -p … || exit $?`) used to run after the redactor setup. On an agent's first run, or a new isolation key, the directory did not exist yet.

**The write is `true >`, not `: >`.** `:` is a special builtin, and under dash (`/bin/sh` here) a redirection error on a special builtin exits the shell. A `: >` sentinel with a missing directory would have taken the whole run down, even inside `{ … } 2>/dev/null || :`. Measured on dash 0.5.12 and bash. `|| :` keeps the statement's status 0 if the write fails.

Tests: the `/bin/sh`-executed table now asserts the sentinel is absent on the success branch and present on both fall-open branches. The sentinel path contains a space and a quote, so its quoting is exercised. A new case runs with the pod-log directory missing, under `set -e`. Without `set -e` the fragment's trailing `export` masks the write's status. `job-manifest.test.ts` pins `mkdir -p` before the sentinel write.

**Mutations, 6, anchor asserted to match exactly once, baseline restored between each. All red.**

| mutation | result |
|---|---|
| sentinel write dropped | 3 failed |
| `true >` replaced by `: >` | 2 failed |
| redactor setup moved back before `preparePodLog` | 1 failed |
| sentinel written unconditionally (also on success) | 2 failed |
| sentinel path left unquoted | 5 failed |
| `\|\| :` dropped after the write | 1 failed |

`tsc --noEmit` reports 0 errors and the full suite passes (1027 tests, 17 files). The shell tests also pass with `/bin/bash` in place of `/bin/sh`. All fixtures are synthetic.
