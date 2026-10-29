# PEN-5016 — `enableGitHubPublishBroker` enablement plan (PEN-3183 D1)

Date: 2026-10-29
Author: Devops (`11b9c48f-aee6-4ac4-8f4a-5ba60c73fb9c`)
Control semantics: Security Engineer (`7500672d-efe6-4037-a05f-61204a670894`)
Date authority: CTO (`29033747-e513-46d5-8a13-dcb5dac10017`) — this document proposes dates; it does
not set them, and it does not flip the gate.
Method: read-only. No cluster write, no deployment, no gate change, no credential value read, no
bypass exercised. Measurements are Loki queries, `kubectl version`, a live-Job list, the sanctioned
`safe-env-inspect.mjs` in this run's own pod, and reading `origin/master` at `5de67c25e`.

## 0. Why this document exists

On 2026-10-29 §7.2 **trigger 4** of `PEN-3183-git-egress-enforcement-boundary-decision.md` fired at a
count of **28** (PEN-4989; measured on PEN-4993). The CTO disposition on PEN-4989 (comment
`03d7f7d4`) ends the §7.1 residual acceptance as of that date and **refuses to re-grant it**. What
replaces an acceptance is an owned remediation with a date, and D1 — moving the credential out of the
agent's mount namespace — is the primary close, because `PATH`-ordering enforcement is structurally
defeated by `PATH` *construction* and no amount of sweeping changes that.

⚠ **Ending an acceptance removes nothing from the fleet.** The exposure on 2026-10-29 is exactly the
exposure on 2026-10-28. This plan is the owner and the timetable; it is not a fix, and nothing in it
should be read as one until a stage actually lands.

## 1. Verdict in one line

**The gate is not ready to be flipped, and the blockers are not the soak.** Three of them are
unmerged PRs already named as preconditions, one is a missing operator surface, and one is a
**defect found while writing this plan**: the gate can be turned off per-issue by the principal it
constrains (§3.2). Stage 1 should not start until §3 is closed.

## 2. What the gate actually does

Read at `vendor/paperclip-adapter-claude-k8s/src/server/job-manifest.ts:2624`,
`asBoolean(config.enableGitHubPublishBroker, false)`:

| | Gate off (today) | Gate on |
|---|---|---|
| GitHub Secret | mounted into the agent container | mounted into the `github-publish-broker` sidecar only (`:3086` drops it from the agent) |
| Agent publish path | `git`/`gh`/MCP authenticate locally | agent asks the broker over a unix socket; `PAPERCLIP_GITHUB_BROKER_SOCKET` is set |
| Broad data mount | renders, annotated `broad:<reason>` | **`buildJobManifest` throws** (`:3580`) — fail closed, not degrade |
| Pod shape | one container | `+1` native sidecar (initContainer, `restartPolicy: Always`), uid 1001, gid 1000, same image |

Two properties make staging possible, and both were verified in the source rather than assumed:

- **It is evaluated at Job render.** A flip affects *new* Jobs only; in-flight runs keep the shape
  they were rendered with. That bounds both rollout and rollback latency to the longest in-flight
  run, and it means no running agent is ever reconfigured underneath itself.
- **It is gated on there being a credential to move** — `brokerEnabled = enableGitHubPublishBroker
  && brokerSecretMounts.length > 0` (`:3560`). Enabling it where no GitHub Secret is mounted is a
  no-op rather than an agent that has lost its doors.

## 3. Preconditions — all of these gate stage 1

### 3.1 The three PRs that §7.3 already names (state read 2026-10-29)

| PR | What it is | State | Why it gates |
|---|---|---|---|
| [#3097](https://github.com/Blockcast/paperclip/pull/3097) `27459d1e4` | the §5 starvation assertion | **OPEN**, `CLEAN` | §7.3 *"The §5 starvation assertion is still outstanding, and it gates discharge"* calls it **"a rollout precondition for PEN-4933, not a follow-up"**. Until a test asserts that a bare `/usr/bin/git push` from uid 1000 in a brokered pod fails to authenticate, enabling the broker closes §7.1's *mount* route and leaves its *helper* route unproven — the narrower of the two, but the one §4 found cheaper for an attacker. |
| [#3089](https://github.com/Blockcast/paperclip/pull/3089) `d4f8aa383` | refuse to render the broker when an env-delivered credential would land on the agent | **OPEN** | §7.4 decided this refusal **stays**. It is not on `master`: enabling the gate at this head would render the broker *and* leave an env credential in the agent container for any seat-bound agent — the boundary would silently not hold, reporting success. |
| [#3098](https://github.com/Blockcast/paperclip/pull/3098) `d2158387c` | the §8 measurement, trigger-4 firing, count 28 | **OPEN**, `BEHIND` | Not a technical blocker for the broker, but it is the change that puts the fired count into §7.1. Until it lands, §7.1 must not be cited (PEN-4989's own framing). |

**Ordering consequence, stated because it is easy to get backwards:** #3089 must land *before* the
first flip, not alongside it. A brokered pod that also holds `GH_TOKEN` is strictly worse than an
unbrokered one — it carries the cost of the boundary and none of the benefit, and it looks enabled.

### 3.2 ⛔ The gate is flippable per-issue by the principal it constrains

**This is a defect, found while writing this plan, and it is not recorded anywhere in §7.** It does
not affect the fleet today, because the gate is off everywhere and the overlay can only set it to the
value it already has. **It becomes live the moment stage 1 sets the gate `true` at agent scope.**

The chain, read at `5de67c25e`:

1. `parseIssueAssigneeAdapterOverrides` (`server/src/services/heartbeat.ts:7959`) parses
   `issue.assigneeAdapterOverrides.adapterConfig` with `parseObject` and **no key allowlist** —
   arbitrary keys pass.
2. `mergeModelProfileAdapterConfig` (`:6726`) is a **shallow spread** with `issueAdapterConfig`
   **last**, so an issue override beats agent config for any top-level key.
3. The merged object becomes `executionRunConfig` (`:34003`) and reaches the adapter as `ctx.config`
   — the same object `buildJobManifest` reads the gate from.
4. The only provenance guard, `withAgentScopedEnvProvenance` (`:2783`), re-asserts agent values for
   `AGENT_SCOPE_ONLY_ENV_KEYS` — three keys, **inside `env`**. It does nothing for top-level
   `adapterConfig` keys.

So `assigneeAdapterOverrides.adapterConfig.enableGitHubPublishBroker = false` on an issue assigned to
the agent yields a pod with the credential back in the agent container. The overlay applies only when
`issueContext.assigneeAgentId === agent.id` (`:33467`) — which is not a mitigation, since an agent can
file an issue assigned to itself, and `paperclipCreateIssue` exposes `assigneeAdapterOverrides`
directly.

The code already knows this class of problem. The comment at `:2766` says it in as many words:

> `issueAdapterConfig` is `issue.assigneeAdapterOverrides.adapterConfig`.
> `parseIssueAssigneeAdapterOverrides` accepts arbitrary keys, and any actor able to create or patch
> the issue can set them. It is overlaid last.

`AGENT_SCOPE_ONLY_ENV_KEYS` is the fix that was applied to exactly this hazard for `GH_SEAT_TOKEN_VALUE`
and the two sccache keys (BLO-18927). The broker gate is the same hazard one level up, and is not
covered.

⚠ **Why this matters more than an ordinary config bug.** A security boundary a principal can decline
per-run is not a boundary; it is a default. It would also be invisible in exactly the way that costs
time: the soak would read green, because the agent that opted out still publishes fine.

**Required before stage 1 — Security to choose, not Devops.** Either pin the gate to agent
provenance the way the env keys are pinned (an `AGENT_SCOPE_ONLY_CONFIG_KEYS` sibling re-asserting
the base value post-merge), or refuse to render when an issue override supplies the key at all. This
plan does not implement either: §8 of the decision record reserves the shape of the boundary to
Security, and this is the boundary.

### 3.3 The gate has no operator surface

`enableGitHubPublishBroker` is **absent from `getConfigSchema()`**
(`vendor/paperclip-adapter-claude-k8s/src/server/config-schema.ts`). The only in-repo occurrences are
`job-manifest.ts`, its tests, the PROVENANCE entry, the wrapper README and the decision doc. `asBoolean`
reads whatever key is present in the merged config, so the flag *works* — but there is no UI field,
which means every stage below is an `adapterConfig` patch rather than a toggle, and a reviewer
cannot see the gate's state in the agent form.

Not a blocker on its own; it **is** a blocker for the rollback requirement in §6, which needs the
state to be legible to whoever is deciding at 3am. Add the schema field in the same PR as §3.2.

### 3.4 The env-credential pre-flight cannot be completed from an agent seat

§7.4's count ("none of 11 agents binds `GH_SEAT_TOKEN_VALUE` at agent scope") is bounded to *agent*
scope in *one* company, because `/environments/:id` is board-only. **Independently reproduced from the
DevOps seat on 2026-10-29: `GET /api/environments/7d00ce14-…` → `403 Board access required`.** So the
bound is a property of the agent seat, not of the Security seat.

Two readings, reproduced in this run's own pod (`safe-env-inspect.mjs`, image
`sha-e74d17b-k8s-vendored`), which agree with §7.4's Security-pod reading:

| | this pod |
|---|---|
| `GH_TOKEN` / `GITHUB_TOKEN` / `GITHUB_PERSONAL_ACCESS_TOKEN` / `GH_SEAT_TOKEN_VALUE` | **absent** (all four) |
| `PAPERCLIP_GITHUB_TOKEN_FILE` | present — the mounted-Secret route |
| `PAPERCLIP_GITHUB_BROKER_SOCKET` | absent — gate off, as expected |

`Devops.adapterConfig.env` carries no GitHub credential name either.

**Gate item:** a board/human read of project- and environment-scope `env` for the stage population,
confirming no GitHub credential name is bound at any scope. Until #3089 lands this is the only thing
standing between "broker enabled" and "broker enabled while the agent still holds a token", and no
agent can perform it.

## 4. The broad-data-mount interaction — measured, not assumed

This is the precondition most likely to be discovered at rollout time, because the failure is a
**refusal to build**: the Job does not render at all and the agent cannot run. PEN-5016 asks for it to
be a query now rather than a discovery then.

**Method.** The §7.2 trigger-2 detector (PEN-4988, not yet merged) watches the server warn rather than
the Job annotation, because agent Jobs carry `ttlSecondsAfterFinished: 300` and a poll of live Jobs
samples. Same reasoning applies here, so this uses the same query:

```
{namespace="paperclip",container="paperclip"} |= "claude_k8s.data_mount_broad_rw"
```

**Result over 14 days to 2026-10-29T13:33Z:**

| | |
|---|---|
| total broad renders | **1776** |
| first / last | 2026-10-15T13:40:30Z / **2026-10-20T01:47:28Z** |
| reason legs | `isolation_disabled` **1776**, `no_claim` 0, `foreign_claim` 0 |
| distinct agents | 8 |
| **renders in the last 9 days** | **0** |

**Liveness control, because silence is byte-identical to clear.** The producer is alive: the
`container="paperclip"` stream's newest entry at query time was 2026-10-29T13:34:38Z, seconds old. And
renders are certainly still happening — 23 agent Jobs were live during the query, including the one
this run executes in. So the zero is "the warn site was evaluated and did not fire", not "nobody
looked".

**What changed on 2026-10-20 is named in the source, not inferred.** `BLO-47526` gave a `shared`
runtime descriptor agent-scoped persistent roots so that `narrowWritableSurface` holds
(`job-manifest.ts:758-767`); before it, a shared run returned `enabled:false` and kept the whole PVC
mounted rw. `isolation_disabled` being the *only* leg that ever fired, and its stopping dead at that
change, is consistent with that and with nothing else.

⚠ **The surviving broad path, which the zero does not cover.** `resolveJobIsolation` falls through to
`SHARED_JOB_ISOLATION` (`enabled: false`, `:709`) when a run arrives with **no runtime isolation
descriptor** and `config.isolationMode` is not `isolated`/`isolate` (`:832-834`). The comment at
`:2931` names it: *"only a config-only run with no descriptor and no `isolationMode` still reaches this
fallback."* The measured zero is therefore a property of **the server supplying a descriptor on every
render**, not of configuration. A run path that stops supplying one renders broad — and once the gate
is on, that stops being a quiet annotation and becomes a hard build failure for that agent.

**Stage gate:** trigger-2 clear (zero broad renders) over a window that overlaps the whole preceding
stage, re-read immediately before each stage widens. Not "clear once".

## 5. Blast radius

### 5.1 What the change adds to every pod in the stage

- **One native sidecar**, same image (`imagePullPolicy` inherited) — so **no new image to pull** and
  no registry/Harbor exposure. The wrapper and scanner it re-enters are byte-identical to the
  agent's, which is what keeps door parity true by construction (§7.3).
- **`+50m` CPU / `+128Mi` memory requests**, limits `1` CPU / `512Mi`
  (`buildGitHubPublishBrokerSidecar`). At the 23 concurrent agent Jobs observed, fleet-wide that is
  **≈ +1.15 CPU and +2.9 GiB of requests** — scheduling pressure, not a cliff, but it lands on nodes
  already carrying the pressure tracked in PEN-3988 and PEN-4634. Worth a node-capacity check before
  stage 3, not before stage 1.
- ⚠ **It would be the first native sidecar in a production agent Job.** All **23 of 23** live agent
  Jobs are single-container `claude`; `enableDocker` defaults off and BLO-40401 records its only
  in-repo `true` as a test fixture. So the `initContainer` + `restartPolicy: Always` shape is
  **unexercised in this cluster's agent Jobs**, even though the code shape is shared with DinD. The
  shape itself is supported — cluster server version **v1.35.3**, read live; native sidecars are GA
  since 1.29. The risk is not the feature, it is that nothing here has run on it: a sidecar that
  fails to terminate turns every agent Job into one that never completes.
  **Stage 1 must check Job *completion*, not just agent success.**

### 5.2 What breaks if the broker is wrong, by door

§4.1 of the decision record is explicit that routing one door relocates the bypass to the other two,
so all three need coverage at every stage. They fail differently:

| Door | Failure mode if the broker is wrong | Observable |
|---|---|---|
| `git push` | push fails; the agent cannot publish. **Loud** — the agent reports it, and a run with no PR is visible on the issue. | agent run log; the PR simply does not exist |
| `gh` | broader than push: `gh pr create`, `gh api`, comment posting. Refusals are per-verb (`auth`/`alias`/`extension`/`extensions` refused), so a *mis-scoped* denylist shows up as a working push and a broken `gh api`. | broker container stderr |
| GitHub MCP server | **the quiet one.** An MCP tool failure surfaces as a tool error inside a run, not as a failed publish, so it can look like an ordinary agent mistake. | broker container stderr; MCP tool errors in run logs |

**The detection asymmetry is the thing to plan around.** `git` fails loudly and `gh`/MCP can fail
quietly, so a soak that watches only "did PRs get opened" would pass a broker that has broken
`gh api`. Each stage must exercise all three explicitly.

### 5.3 Observability, and its one real gap

The broker writes refusals and child stderr to **its own container's stderr**
(`github-publish-broker.ts:271,329,419`; `github-publish-broker-runtime.ts:39,55`), which reaches Loki
as `container="github-publish-broker"`. There is **no metric** — no counter of brokered publishes,
refusals, or errors.

With `ttlSecondsAfterFinished: 300`, **Loki is the only durable record** of what the broker did; the
pod is gone five minutes after the run. This is the same completeness argument PEN-4988 makes for
trigger 2, and it has the same consequence: soak evidence must be collected from Loki inside the
window, not reconstructed from the cluster afterwards.

**Minimum soak instrumentation, which does not exist yet and is in scope for stage 0:** a saved query
over `{namespace="paperclip",container="github-publish-broker"}` separating (a) startup failures,
(b) policy refusals, (c) child non-zero exits. Without it stage 1 is unfalsifiable — a silent broker
and a broker nobody asked to publish look identical.

## 6. Rollback — who decides, and on what evidence

⚠ §7.3 is explicit, and this is the sentence that shapes this section:

> **Switching it back off after enablement re-opens §7.1 and is a Security decision, not an incident
> one.**

Stated plainly: **the first bad night makes this call by default unless it is written down now.** It
is written down here.

**Decision owner: Security (`7500672d`). Not the on-call engineer, not Devops, not the agent that
noticed.** The reason is not ceremony — switching the gate off restores an acceptance that was ended
by measurement on 2026-10-29 and that the CTO explicitly refused to re-grant. Nobody else can re-grant
it either, least of all implicitly at 3am.

**What on-call may do without Security**, because none of it re-opens §7.1:

| Lever | Re-opens §7.1? | Who |
|---|---|---|
| Narrow the stage — revert the *most recent* widening, leaving earlier stages enabled | no | on-call |
| Pause the affected agent (`status: paused`) | no — agent stops, credential does not move back | on-call |
| Restart / re-run an individual Job | no | on-call |
| **Set the gate `false` for an already-enabled population** | **yes** | **Security only** |

**Evidence required for a Security rollback decision**, so the call is made on measurement rather
than on the volume of the complaint:

1. The failure reproduced on **at least two agents**, with the broker-container log lines. One agent
   is as likely to be that agent's workspace as the broker.
2. A statement of which door failed (`git` / `gh` / MCP) — §5.2's asymmetry means "publishing is
   broken" is not yet a diagnosis.
3. Confirmation that the failure is not the two refusals that are **working as designed**: the broad
   data-mount refusal (§4) and, once #3089 lands, the env-credential refusal (§3.1). Both present as
   "the agent cannot run", and neither is a broker defect. **Rolling back on either would be rolling
   back a control that correctly refused.**
4. Whether narrowing the stage (row 1 above) already restored service — if it did, that is the
   remedy, and the gate stays on for the stages that are healthy.

**Rollback latency is bounded and should be stated to whoever is deciding:** the gate is read at Job
render, so switching it off takes effect for the next Job and in-flight runs keep the broker. Nothing
needs draining; nothing is reconfigured underneath a running agent.

## 7. Soak shape

Dates are **proposed**; the CTO owns them. Each stage's exit criteria must hold for its whole
duration, not at a single instant. Day counts assume stage 0 completes; every stage boundary is a
re-read of §4's trigger-2 query, not a one-time clearance.

**Stage 0 — preconditions (not a soak).** Proposed target **2026-11-05**.
Exit: #3097 merged; #3089 merged; §3.2 closed by Security's chosen remedy; schema field added (§3.3);
board-level env-scope read returned clean (§3.4); the §5.3 broker log queries saved. **No gate is set
in stage 0.**

**Stage 1 — one agent, one company.** Proposed **2026-11-06 → 2026-11-10** (≥ 3 working days).
Population: a single `claude_k8s` agent that publishes often enough to exercise all three doors
within the window. **Devops (`11b9c48f`) volunteers as stage 1**: this seat opens PRs daily, uses
`gh` and the GitHub MCP server in the same runs, and its failure is visible to its own owner rather
than to a tenant.
Observe: (a) **Job completion**, not just run success — the native-sidecar risk of §5.1; (b) a real
`git push` reaching GitHub; (c) a real `gh` call *other than* push; (d) a GitHub MCP tool call; (e)
zero unexplained broker-container errors; (f) trigger-2 still zero.
Exit: all six, across ≥ 3 days and ≥ 10 runs.

**Stage 2 — one company, all agents.** Proposed **2026-11-11 → 2026-11-18** (≥ 5 working days).
Population: all `claude_k8s` agents in `b1d3f3d3` (Penstock) — 8 of the agents in §4's broad-render
history sit here, so it is the population whose isolation legs are actually known.
Observe: stage 1's list, plus node capacity against the `+50m/+128Mi` per pod of §5.1, plus any agent
whose runs stopped completing.
Exit: as stage 1, plus no scheduling regression attributable to the sidecar.

**Stage 3 — fleet.** Proposed **2026-11-19 → 2026-11-26**.
Population: the second company (2 observed) and anything added since. A node-capacity check is a
precondition here, not an observation.
Exit: as stage 2, held for a full week.

**Then, and only then, §7.1 is discharged** — and per §7.3 item 1 the acceptance is discharged when
the gate is on **and** the §5 starvation assertion is satisfied, which is why #3097 is in stage 0 and
not stage 3.

## 8. The successor residual, carried forward

PEN-5016 requires this explicitly, because the failure mode is silent: an acceptance that ends can
quietly take its successor with it. **It does not.**

§7.3's *"A successor residual replaces the old one, and it is smaller but real"* survives
enablement intact. The broker runs against a repository whose `.git/config` the agent owns, and the
closed-vector list in `github-publish-broker-policy.ts` is — in that section's own words — *"a list of
vectors closed, **not** a proof that no other git config key can reach an exec during a push"*. It must
not be written up as one anywhere, including in this plan.

Carried forward, unchanged in substance, with the review date §7.3 assigns it:

| Residual | Review date |
|---|---|
| The broker's closed-vector list is a list, not a proof | **2027-01-31** |
| The check-then-use gap on file arguments (admission `realpath`s; `gh` re-resolves at open; the agent owns the shared `/tmp` in between) | **2027-01-31** |
| Read-confinement only — an argument naming a not-yet-existing path outside the roots is admitted | **2027-01-31** |
| `diff.<driver>.textconv` and repository `core.hooksPath` are closed **elsewhere** (`--no-textconv` in the shim; the runtime's injected `core.hooksPath`) and are **not** stated in the broker's own policy list — a change to either file silently re-opens an exec route | **2027-01-31**, and on any change to those two files |

⚠ **This successor residual is strictly smaller than §7.1's and must not be described as equivalent.**
Under §7.1 the agent simply holds the token. Under D1 it must win a race or find an unenumerated
config key. That is a real improvement and it is still not "the broker cannot be made to run
attacker-chosen code".

**The standing blind spot is unchanged and is the CTO's**, per the PEN-4989 disposition: no
cluster-wide exec telemetry is deployed, trigger 4 has a measurement and not a detector, and the CTO
declined to reverse that — a fleet tracer being a large new capability acquired for a control D1
retires. Enabling the broker does not close it; it makes it matter less.

## 9. What this plan does not do

- **It does not flip the gate.** PEN-5016 produces the plan; the CTO sets the date against it.
- **It does not implement §3.2's fix.** The shape of that boundary is reserved to Security by §8.
- **It does not touch §8's forbidden list**, and nothing in it approaches that list: no relaxation of
  `allowPrivilegeEscalation`, dropped capabilities or `runAsNonRoot`; no integrity check between
  wrapper, hook and scanner; no change to the credential path; no env-delivered credential routed
  through the broker (§7.4 refused that, and this plan keeps the refusal as a stage-0 precondition).
- **It does not re-grant any acceptance.** §7.1 ended on 2026-10-29 and stays ended.

## 10. Bounds on the measurements above

Stated so a later reader does not inherit them as stronger than they are:

- The 14-day Loki window is bounded by retention. "Zero broad renders in 9 days" is a statement about
  renders Loki retained in that window, liveness-controlled as described, and nothing about any
  earlier period.
- Those are **renders**, not running pods. They agree today because one variable (`broadDataMountReason`)
  decides both the warn and the annotation a few lines apart, which is also why they are not
  independent evidence.
- PEN-4988's detector is **not merged**, so nothing watches trigger 2 continuously yet. The zero above
  was obtained by running its query by hand.
- The live-Job figures (23 Jobs, 12 agents, 2 companies, 23/23 single-container, one image tag) are a
  single instant on 2026-10-29. Concurrency moves; the single-container finding is the load-bearing
  one and is the least likely to be an artefact of the instant.
- The env-credential reading covers **one pod of one agent** at agent scope, and agrees with §7.4's
  reading in a different agent's pod. Project and environment scope are unreadable from any agent
  seat (§3.4) — which is why §3.4 is a gate item and not a conclusion.
