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
| Current version | `0.2.6-blockcast.4` — see [Versioning](#versioning) |
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

A manifest of `sha256(path)` over all 40 in-tree files, sorted by path under
`LC_ALL=C`, itself hashes to:

```
8ffdafdb6782e5b060d6af57ac542b3f26530a125f862b06c15fa6d0e5febf06
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
| `b80b69218` | `src/server/env-guard.ts` | Converged shell unwrapping with `server/src/agent-shell-guard.ts`, adopting its `SHELL_COMMAND_PREFIX_RE` + `readShellCommandArgument` (a human closed the same unquoted-wrapper bypass there in `993bf304c`). Belt-and-braces with the boundary widening in `3e0244a78`: unwrapping is more precise for `sh -c`, the boundary rule is the only thing that reaches non-shell wrappers. Also corrected this file's header claim that the sibling copy was merely "four bypasses behind" — the divergence runs both ways. |
| `85f99a85b` | `src/server/job-manifest.ts`, `src/server/job-manifest.test.ts`, `src/server/execute.test.ts` | Pinned `ANTHROPIC_CUSTOM_HEADERS` into a new `ALWAYS_SECRET_ENV_NAMES` set. `SENSITIVE_ENV_NAME_RE` matches none of its tokens, so the var shipped as a literal `env[].value` despite carrying arbitrary forwarded header lines — including, in principle, an `Authorization:` line set through `adapterConfig.env` or the Penstock session stamp. Routing and both fail-closed guards key off `isSensitiveEnvName()`, so the pin covers all three. BLO-21858, from the BLO-21593 independent review of upstream PR #31 (probe 6). |
| `e1b28276f` | `src/server/env-guard.ts`, `src/server/env-guard.test.ts` | Replaced the boundary-regex classifier with a shell-aware normalizer, in both copies. Five prior rounds each closed one boundary bypass; the fifth Ally review found three more (`env >&2`, `e''nv`, `env -S '-u PATH'`). Re-measured against the real spawned pod script the class was wider than reported: 10 of 12 probe payloads classified `allow` while `/bin/sh` emitted a marker variable, including `e"n"v`, `\env`, `'env'`, `env>&2`, `env 2>&1` and `env -S '-0'`. The cause is structural, not a missing character class — a regex matches command *text*, but the shell executes the command after quote removal, escape processing, redirection stripping and GNU `env -S` re-splitting, so the matched string is not the token that runs. The command is now lexed as a shell would and the resulting words are classified, so spelling variants collapse to one word. The hand-maintained second case list for the embedded copy — the mechanism by which the two copies drifted — is replaced by a differential that drives the whole corpus through both. Fifth Ally review pass on Blockcast/paperclip#1092. |
| `e1b28276f` | `src/server/job-manifest.ts`, `src/server/job-manifest.test.ts` | Two fail-closed fixes from the same review. (a) A configured account pool of the wrong *shape* (`accounts: "a@example.test"` rather than a list) was collapsed into the same `null` used for "absent" by `Array.isArray(...) ? ... : null`, so it read as unconfigured and selected unrestricted *global* ccrotate rotation — the same credential-scope widening `3e0244a78` fixed for the all-invalid case, still reachable by the likeliest possible typo. Presence is now tested separately from validity at both `providers.anthropic` and `.accounts` (`parseObject` returns `{}` for any non-object, so both levels shared the defect), an explicitly empty pool counts as configured-but-unusable, and diagnostics report the offending TYPE only — never the value, which sits next to credential material. (b) `workspaceMountPath` could equal a mount this builder already emits (`/tmp/prompt`, `/runtime-cache`, an inherited secret mount); those are shape-valid so `assertSafeAbsolutePath` passed them, and the duplicate mountPath yields a Pod Kubernetes rejects outright. Rejected at construction with a message naming the conflict, plus a per-container invariant assertion that backstops mounts appended later (`/var/run`, `prompt-secret`, `mcp-config-secret`) and the init container's independently-built list. Nested paths stay legal. |
| [#1368](https://github.com/Blockcast/paperclip/pull/1368) | `src/server/k8s-client.ts`, `src/server/k8s-client.test.ts`, `src/server/job-manifest.ts`, `src/server/job-manifest.test.ts` | Carried the source volume's `items:` key selector through propagation. `getSelfPodInfo()` captured only `secretName`/`mountPath`/`defaultMode`, and the mount site rebuilt the volume without a selector, so a source mount projecting ONE key out of a multi-key Secret was re-expanded into EVERY key of that Secret on the agent Job pod. Measured live: `paperclip-api` projects `gbrain-plugin-service-key` alone out of `authbot-mcp-consumer-service-keys`, while agent pods received all 7 keys — agents held more key material than the container the mount was copied from. `optional: true` stays hardcoded at the mount site by design, so a Secret absent in the agent namespace still cannot hard-fail the Job. Refs [BLO-18927](https://paperclip.blockcast.net/BLO/issues/BLO-18927) AC-3; does **not** close [BLO-22514](https://paperclip.blockcast.net/BLO/issues/BLO-22514), which needs the allowlist. |
| [#1377](https://github.com/Blockcast/paperclip/pull/1377) | `src/server/inherit-allowlist.ts` (new), `src/server/inherit-allowlist.test.ts` (new), `src/server/k8s-client.ts`, `src/server/k8s-client.test.ts`, `src/server/job-manifest.ts`, `src/server/job-manifest.test.ts`, `src/server/env-guard.ts` | Allowlisted what agent Job pods inherit from the paperclip server pod. `getSelfPodInfo()` snapshotted the server's ENTIRE env — every literal, every `valueFrom` including `secretKeyRef`, every `envFrom` and every mounted secret volume — with no filter, and `job-manifest.ts` replayed all of it onto every agent Job, so each agent container held `PAPERCLIP_AGENT_JWT_SECRET` (mint an API key for ANY agent), `DATABASE_URL` (bypass the API and all of `authorization.ts`) and `GITHUB_APP_PRIVATE_KEY`. Filtered at `getSelfPodInfo()` rather than at the four replay sites, so a future replay site cannot reintroduce the leak by forgetting to filter, plus a fail-closed `findServerOnlyEnvVarsInPodSpec` backstop in `buildJobManifest` because `SelfPodInfo` is a plain object callers can construct unfiltered. Keep-set derived from actual by-name reads plus an agent-pod consumer sweep — not pattern-matched — and both directions unit-tested, since a filter that dropped everything would pass a deny-only suite while breaking every run in the fleet. Measured against the live server env: 54 vars in, 24 inherited, 30 dropped, 0 control-plane credentials remaining. `env-guard.ts` is comment-only: records the BLO-22514 decision to keep that hook fail-OPEN. Closes [BLO-22514](https://paperclip.blockcast.net/BLO/issues/BLO-22514). |
| [#1411](https://github.com/Blockcast/paperclip/pull/1411) | `src/server/inherit-allowlist.ts`, `src/server/inherit-allowlist.test.ts`, `src/server/k8s-client.test.ts` | Removed `paperclip-github-merge-token` (the `@allyblockcast` USER seat, id 296676656) from `AGENT_SECRET_VOLUME_ALLOWLIST`, so it no longer propagates from the server pod into agent Job pods. That seat's approvals SATISFY required review on repos whose ruleset names the Ally team (onprem-k8s, penstock-llm-proxy-core), so propagating it made "can clear branch protection" a fleet-wide capability — measured live at **108 agent Job pods** mounting it — rather than one service's. It was also unusable from an agent by construction, i.e. exposure with no function: the `gh` wrapper resolves `PAPERCLIP_GITHUB_TOKEN_FILE` (pinned to the App token at `/paperclip/.secrets/github-token/token`, never the seat path), `GH_TOKEN`/`gh auth`/`--with-token` overrides are no-ops because that wrapper re-reads the file per invocation, and shipped skills are forbidden from naming the seat path by `CREDENTIAL_SELECTOR_PATTERNS` in `packages/skills-catalog/src/shipped-catalog.test.ts`. Measured across 240 PRs in onprem-k8s, penstock-llm-proxy-core, paperclip and multicast: the seat authored 0 and pushed 0 (authorship is 100% the App) and merged 11, a path the App already covers. The CONTROL PLANE keeps the mount via `deploy/helm/paperclip/values.blockcast.yaml`, where the dedicated reviewer service that legitimately uses this identity runs — only the agent-Job propagation is removed. Two `k8s-client` tests used the seat as their example of a KEPT volume and were re-pointed at the App token; the base fixture now mounts both, deliberately keeping the seat so the allowlist is exercised against a realistic server pod rather than one curated to contain only inheritable volumes. Companion to the org-side half of [BLO-24056](https://paperclip.blockcast.net/BLO/issues/BLO-24056) (seat dropped to `read` on all 11 in-scope repos). |
| [BLO-25403](https://paperclip.blockcast.net/BLO/issues/BLO-25403) | `src/server/job-manifest.ts`, `src/server/job-manifest.test.ts`, `src/server/config-schema.ts`, `src/server/execute.ts`, `src/server/execute.test.ts`, `src/server/execute-environment.test.ts` | Ported upstream `94c97d01d408155a5c173c43ab42304f688e7ce3` (merged as [kkroo#32](https://github.com/kkroo/paperclip-adapter-claude-k8s/pull/32) `c5d1389f`) — the BLO-21812 fix, which the 2026-08-06 vendoring **stranded**: it was authored against a branch that was not part of the `3ad3370`+`35f1eb2`+`6ddd4b0` composition, so it never entered the build path and `CLAUDE_K8S_REF` was retired out from under it. A new `resolveServiceAccountName()` resolves per-agent config → `PAPERCLIP_DEFAULT_SERVICE_ACCOUNT_NAME` (fleet default) → **throw**, replacing `asString(config.serviceAccountName, "") \|\| undefined`, which omitted the key and let Kubernetes admission silently assign the namespace's bare `default` SA — an identity with no cluster-scoped read, and a full misdiagnosed incident ([BLO-21499](https://paperclip.blockcast.net/BLO/issues/BLO-21499)). The resolved SA is echoed on `JobBuildResult`, into the run log and into invocation metadata so identity is attributable without a cluster read. Ported by hand rather than cherry-picked: 4 of 6 files applied clean, but `execute.ts` and the `buildJobManifest` return had drifted under `551c461ef`/`3e0244a78`/`e1b28276f` (`envSecret`, `mcpConfigSecret`), so those two hunks were reapplied against current code. No RBAC object is created or modified. Two cases beyond upstream's pin the load-bearing `.trim()` on both resolution branches — `serviceAccountName` is a `type: "text"` field, so a whitespace-only value is reachable from the UI form and a bare `\|\|` would emit it as a Job SA name the API server rejects (Ally review suggestion on [#1409](https://github.com/Blockcast/paperclip/pull/1409)). |
| [BLO-29804](https://paperclip.blockcast.net/BLO/issues/BLO-29804) | `src/server/job-manifest.ts`, `src/server/job-manifest.test.ts` | Made the env classification declarative and gated it in CI. `SENSITIVE_ENV_NAME_RE` is fail-closed against over-matching but fail-**open** against a credential-carrying variable whose name matches none of its six patterns — the `ANTHROPIC_CUSTOM_HEADERS` row above is the proof, and pinning names one at a time only fixes the instances someone notices. A new exported `ENV_NAME_CLASSIFICATION` table declares every env name this file can emit as `SECRET` or `SAFE_LITERAL` with a stated reason, and `ALWAYS_SECRET_ENV_NAMES` is now *derived* from it, so declaring a name `SECRET` there is what pins it and the table is the single source of truth. The forcing function is a test suite over the full 2×2×2×2 permutation of isolation / DinD / `adapterConfig.env` / `mcpServers`: an emitted name absent from the table reddens the lane **naming the variable**, so a new env var fails CI in the pull request that introduces it instead of inheriting a default. Coverage alone is not enough, so two further assertions exist — one requires classification and `isSensitiveEnvName` to agree on every *emitted* name, closing the hole where a prefix family (`PAPERCLIP_WORKSPACE_`) would silently absolve a future `PAPERCLIP_WORKSPACE_AUTH_TOKEN` as `SAFE_LITERAL` while the routing correctly Secret-backs it; the other asserts the Secret-backed name set for a fixed context is identical to the pre-change set, so the classification cannot silently move a var between literal and `secretKeyRef`. **No runtime behaviour change** — `isSensitiveEnvName()` keeps its semantics (regex ∪ pinned), all three `SECRET` entries already matched the regex or were already pinned, and the diff is classification plus tests. The three operator-supplied channels (`adapterConfig.env`, `selfPod.inheritedEnv`, `selfPod.inheritedEnvValueFrom`) are deliberately out of the table because their names are data rather than code; the second is separately governed by `AGENT_ENV_ALLOWLIST` in `inherit-allowlist.ts`. Records the decision on [BLO-21858](https://paperclip.blockcast.net/BLO/issues/BLO-21858) remedy (2): inverting to "Secret-backed unless declared safe-literal" is **declined** on measured cost/benefit — 8 `secretKeyRef` vars against 37–41 literals per live `ac-*` pod, so inversion moves ~40 operationally load-bearing fields (`HOME`, `TMPDIR`, `PAPERCLIP_RUN_ID`, the isolation roots) into an opaque Secret and stops `GET Pod` being a triage tool, on a code path that templates every agent Job with no staging tier. Full reasoning and the counter-argument on [BLO-29804](https://paperclip.blockcast.net/BLO/issues/BLO-29804). |
| [#1525](https://github.com/Blockcast/paperclip/pull/1525) | `src/server/parse.ts`, `src/server/parse.test.ts`, `src/server/execute.ts` | Made `skill_not_found` reachable and stopped model prose reaching it ([BLO-7991](https://paperclip.blockcast.net/BLO/issues/BLO-7991) AC3). `isClaudeSkillNotFoundStartupFailure` scans the RAW transcript for `Skill "<name>" not found`, so any run whose transcript merely QUOTED that phrase — model prose, a tool result, this very issue's own body — was classified as a startup skill death. That code is in `NON_RETRYABLE_CONTINUATION_ERROR_CODES` and excluded from the zero-token reset, so a misclassification is **permanent** retry suppression, not a visible error. Guarded on the same surface the scan reads (a parsed signal cannot bound what a raw regex sees), then widened once more when a pre-assistant `user` event — which carries `tool_result` text and has no branch in `parseClaudeStreamJson` at all — proved to slip past an `assistant`-only check. Recorded here retroactively: #1525 updated the integrity hash but added no row and did not bump `-blockcast.N`, which the two rules at the foot of this section require. |
| [BLO-31794](https://paperclip.blockcast.net/BLO/issues/BLO-31794) | `src/server/parse.ts`, `src/server/parse.test.ts` | Inverted that guard from a **blocklist** of stream-json event types to an **allowlist** of harness-authored ones, so an unrecognised type fails closed. The row above widened the same predicate twice for one reason: `parseClaudeStreamJson` branches on exactly three types (`system`+`init`, `assistant`, `result`) and ignores every other one, so each newly-appearing event shape slipped a role-blocklist by default. The hazard was one config edit from live rather than hypothetical — `job-manifest.ts:1256` appends `config.extraArgs` to the CLI argv verbatim (`:1125`, from an agent's `adapterConfig`), so `--include-partial-messages` on any single agent re-opens the guard with no code change, no diff and no review. Measured on the CLI this adapter runs (v2.1.210): that flag emits 9 `stream_event`s for a two-word prompt, each wrapping model prose in `event.delta.text_delta`, and `stream_event` was enumerated by no previous version of the guard. The allowlist is `{system, rate_limit_event}` with a stated membership criterion (payload must be entirely harness-authored scalars); `result` is deliberately excluded because a *truncated* one can reach the scan carrying the model's final message. Scoped per line and reading only the first `"type"` per line, so a nested type cannot veto its own line — measured as defence-in-depth rather than a live fix, since a real 1717-byte `init` line carries exactly ONE `"type"` (its `mcp_servers` entries are `{name, status}`, `output_style` a bare string). Detection is unchanged: the four existing guard cases pass unmodified, plus new cases for a production-shaped `init` line, `system:status` (which v2.1.210 emits pre-turn under `--include-partial-messages`), and `rate_limit_event` (the FAR-32 repro in `execute.test.ts`). Verified as a negative control — the new `stream_event` case FAILS against the previous blocklist while all 12 detection-preserving cases pass, so it discriminates the fix rather than merely passing alongside it. **Ally review follow-up on [#1650](https://github.com/Blockcast/paperclip/pull/1650):** the allowlist reaches the `system` *subtype* rather than admitting the type wholesale, because `system` is a multiplexer and admitting it whole reproduced this same defect one level down. Measured against the v2.1.210 binary, `system` carries at least `init`, `status`, `compact_boundary`, `hook_started`, `hook_response` and `mcp_status`; only the first two are admitted. `hook_response` is why this is a live hole rather than future-proofing — the binary builds it as `{type:"system",subtype:"hook_response",…,output,stdout,stderr}`, embedding a hook process's raw stdout, which is operator-configured. It is not merely reachable via `--settings`/`extraArgs`: **Paperclip provisions hooks itself**, and real pod logs on this instance carry a `SessionStart` `hook_response` whose `output` is an operator status message, and another whose `stdout` is an nginx 503 HTML page. (`hook_error`, listed in the review, appears in no v2.1.210 string table and is not a subtype at this version.) A `system` line with no readable subtype fails closed. **Second review round — the subtype gate as first shipped silently disabled detection in production, and this row previously claimed otherwise.** Because Paperclip provisions a `SessionStart` hook, `hook_started`/`hook_response` open the transcript *before* `init` on the large majority of real runs — measured on this instance's pod logs at **6510 of 8036** `init`-carrying logs (81%), with the hook line preceding `init` in **399/399** of a sample carrying both. A whole-transcript "every line must be harness-authored" veto therefore returned `false` on all of them, and the suite stayed green only because its sole positive fixture was a synthetic two-line shape no production run has — precisely the "fix the false positive by disabling detection entirely" failure mode this issue's own acceptance criteria warn about. The predicate now **attributes the phrase to its line** instead of demanding a globally clean transcript: the trigger phrase counts only when it sits on a line the harness authored (an allowlisted event, or a bare non-event line, which in stream-json mode is the CLI speaking outside the protocol — 0 of 6893 sampled production lines are bare). Every false positive in this family is the phrase *inside* an event payload, so attribution is the more faithful invariant and unknown types still fail closed. Detection now genuinely survives the production preamble, pinned by four new cases (full preamble; each hook line alone; an untrusted event *after* the death), and the negative-control discipline is unchanged — the production-preamble case FAILS against the whole-transcript veto. One deliberate narrowing is recorded in the source: the phrase regex's `\s+` can span a newline, so a phrase straddling two lines would no longer match; the CLI emits it on one line, and the direction is the safe one. Also note this row's own earlier "measured as defence-in-depth rather than a live fix" framing applied to *nested types on an init line*, which remains accurate; it did not license the detection-loss claim. The phrase test still runs before the per-line walk as a pre-filter — the walk re-tests each line and is what decides — skipping an eager `split` of the entire pod log on the common phrase-absent failure. |
| [#1669](https://github.com/Blockcast/paperclip/pull/1669) | `src/server/prompt-cache.ts`, `src/server/prompt-cache.test.ts`, `src/server/execute.ts`, `src/server/execute.test.ts`, `src/server/execute-environment.test.ts` | Classified the OTHER path into BLO-7991's pathology, which the row above cannot see. [BLO-32055](https://paperclip.blockcast.net/BLO/issues/BLO-32055): a live run died with a bare Node `ENOENT ... open '<...>/__runtime__/<slug>/SKILL.md'` and was reported as the anonymous `adapter_failed` — an agent-pool/adapter fault for what is a skill configuration fault, invisible to skill-health sweeps. The reader was not a skill loader but `hashPathContents`, which walks each declared skill's tree to derive the prompt-bundle **cache key**; its `readFile` was unguarded. That walk runs inside `prepareClaudePromptBundle`, i.e. BEFORE the CLI is spawned, so `stdoutExcerpt` and `stderrExcerpt` were both null and there was no `parsed`, no result event and no transcript — every classifier in `parse.ts` reads a Claude-CLI-authored surface, so all of them are **structurally** blind to it. Not a too-narrow regex and not a regression of #1525: a second real path into the same user-visible failure, on a layer #1525 never inspects. The file's absence is transient — `company-skills.ts materializeRuntimeSkillFiles` refreshes by `fs.rm(recursive)` -> `mkdir` -> per-file `writeFile`, so the sweep publishes a window where the directory exists and `SKILL.md` does not; measured live, the file appeared **43m36s** after the run died on it. Routing this to `skill_not_found` would therefore have been the WRONG fix — that code is in `NON_RETRYABLE_CONTINUATION_ERROR_CODES`, so it converts a self-healing condition into permanent retry suppression, the same over-suppression hazard as the two rows above. Split instead on the source of truth (which skill owns the path, never message text, so the BLO-31794 false-positive class cannot reach this branch): a catalog-backed key yields a new transient `skill_materialization_pending` and a non-catalog-backed one keeps the permanent `skill_not_found`. The new code joins `TRANSIENT_INFRA_CONTINUATION_ERROR_CODES` — **the set that already contained `adapter_failed`** — so retryability is preserved exactly rather than widened. The discriminator is load-bearing rather than cosmetic because `readPaperclipRuntimeSkillEntries` silently switches source: it returns the server-injected catalog entries OR, when config carries none, the adapter's own bundled on-disk skills, a read-only image path where a missing file is a packaging fault no retry can fix. Hashing is still fatal and the error re-thrown rather than swallowed — a half-written tree hashed into a key would mint a bundle whose skills are silently incomplete, which is BLO-7991's original harm traded for a failure nobody sees. **Ally review follow-up:** `readCatalogBackedSkillKeys` is now a literal transcription of the key-deriving half of `normalizeConfiguredPaperclipRuntimeSkills` (`server-utils.ts:2598`) rather than an approximation, which was wrong in both directions — `asString` falls back on an EMPTY string and not merely on a non-string, so `{key:"", name:"x"}` normalizes upstream to key `x` while a `typeof key === "string"` test resolved it to `""` and dropped the entry, marking a catalog-backed skill un-backed (permanent suppression, the one direction this change exists to avoid); and upstream DISCARDS any entry missing `runtimeName` or `source`, which the hand-rolled version contributed anyway, letting a source-less entry colliding with a bundled key mark an image-path fault retryable. Deriving from the same primitives closes both. Each new test is verified as a negative control — the empty-key case fails against the hand-rolled predicate, and the three `execute.ts` cases fail against an inverted ternary or a dropped `instanceof` guard, pinning the seam this change exists to produce (both halves were covered before; the join was not). Two test files convert `./prompt-cache.js` from a whole-module mock to an `importOriginal` partial: the old form replaced the module with a single export, so ADDING any export here broke 23 unrelated tests — a trap worth knowing before adding the next one. **Does not fix the underlying race**: porting `materializePaperclipSkillCopy`'s tmp-dir + rename + lock pattern into `materializeRuntimeSkillFiles` is the RCA fix and is deliberately out of scope here. |
| [BLO-31665](https://paperclip.blockcast.net/BLO/issues/BLO-31665) | `src/server/execute.ts`, `src/server/execute.test.ts`, `src/server/secret-adopt.test.ts` (new) | Made an `AlreadyExists` 409 on a run-scoped Secret non-fatal. `execute.ts` creates three Secrets before the Job (prompt, env, mcp-config) and treated **any** throw from the create as fatal, returning `k8s_{prompt,env,mcp_config}_secret_create_failed` and killing the run — so a benign leftover from an earlier attempt of the *same* run stranded the agent. Adopting is safe because the name encodes the run: each Secret is `${jobName}-{prompt,env,mcp}` with `jobName = ac-<agentSlug>-<runSlug>-<shortHash(agentId:runId)>` (`:1151`), so a full-name collision is a collision with this same `(agentId, runId)` and the contents are re-derived from the same config. A new `createOrAdoptRunSecret()` reads the colliding object and `replaceNamespacedSecret`s it. **This is a second, parallel implementation of the operation [#1562](https://github.com/Blockcast/paperclip/pull/1562) fixed** in `packages/plugins/sandbox-providers/kubernetes/src/secret-manager.ts`; that PR never touched this call site, which is why the 409 kept hard-failing runs after it shipped (measured again 2026-09-05T17:03:47Z, run `591c1384`, with the fix live on both tiers). One deliberate divergence from that sibling, plus one measured non-difference. (a) The identity gate fails closed on *positive contradiction* only — a Secret whose `paperclip.io/run-id` or `app.kubernetes.io/managed-by` label **disagrees** with this run is never overwritten, but one **missing** them is adopted. A verbatim port of the sibling's gate would have been inert here regardless, since it requires `paperclip.io/managed-by: paperclip-k8s-plugin` while this adapter writes `app.kubernetes.io/managed-by: paperclip` — a different key *and* value, so it would reject every Secret this adapter writes. (b) `isK8s409` mirrors `isK8s404`'s shape, including its `HTTP-Code:` message probe — but that probe is **redundant, not load-bearing**, and an earlier version of this row claimed otherwise. Measured against the installed `@kubernetes/client-node` 1.4.0 by constructing a real `ApiException`: it is built as `super("HTTP-Code: " + code + ...)` and then sets **only** `this.code` — `statusCode` and `response` are both `undefined`. So the sibling's `code`/`statusCode` predicate **does** fire correctly on the production error, and the concern that it would silently miss it is **withdrawn**. Two consequences worth keeping: `code` is the reliable structured signal, and the pre-existing `isK8s404` does **not** check it, so that predicate works today purely on its message regex; and the tests here construct the genuine `ApiException` rather than a hand-rolled stand-in, so they are evidence about the real error shape rather than about an assumption. A create-409 followed by a read-404 (the adapter's own cleanup reaper racing a retry) now retakes the newly-free name instead of resurfacing the stale 409, which is what the sibling does. Each new `execute()` test is verified as a negative control: all three FAIL against the pre-change file with `k8s_prompt_secret_create_failed`, so they discriminate the fix rather than merely passing alongside it. **Does not address** the orphaned-Secret leak also described on that issue — that is [#1459](https://github.com/Blockcast/paperclip/pull/1459) (BLO-21857), which edits this same file and will need a rebase against whichever of the two lands second. The issue's "stale error is never cleared" defect was **falsified** while working this: a company-wide census of all 15 agents found zero holding a 409 `errorReason`, and all three originally-named agents had heartbeated within ~20 minutes — the field is overwritten by the next run's outcome, not sticky. |
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

This directory therefore versions itself: **`0.2.6-blockcast.4`**, set in
`package.json` and `package-lock.json`. The `-blockcast.` prerelease channel
says plainly that this is our tree, not an upstream release.

The PATCH digit is bumped rather than only the prerelease tag, deliberately.
Semver compares `major.minor.patch` **before** prerelease identifiers, so
`0.2.6-blockcast.1` > `0.2.5-kkroo.6`. Had we picked `0.2.5-blockcast.1`, the
prerelease identifiers would have decided it — and `blockcast` sorts *below*
`kkroo` alphabetically, making the release read as a downgrade to anything
comparing versions.

Bump `-blockcast.N` for subsequent changes to this directory.

### The inert upstream workflow

`.github/workflows/ci.yml` is kept verbatim as part of the upstream tree. **It
does not run.** GitHub Actions only reads workflows from the repository-root
`.github/workflows/`, and this one is nested. The job that actually verifies
this directory is `vendor-claude-k8s` in
[`.github/workflows/pr.yml`](../../.github/workflows/pr.yml).
