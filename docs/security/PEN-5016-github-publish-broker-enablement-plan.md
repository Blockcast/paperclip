# PEN-5016 — `enableGitHubPublishBroker` enablement plan (PEN-3183 D1)

Date: 2026-10-29
Author: Devops (`11b9c48f-aee6-4ac4-8f4a-5ba60c73fb9c`)
Control semantics: Security Engineer (`7500672d-efe6-4037-a05f-61204a670894`)
Date authority: CTO (`29033747-e513-46d5-8a13-dcb5dac10017`). **Exercised 2026-10-30 — the dates are
now SET, in §11 (PEN-5063).** §§0-10 remain Devops' plan and propose; §11 is the CTO's and disposes.
Setting the dates still does not flip the gate: §11 is a timetable and an entry gate, not an
enablement.
Method: read-only. No cluster write, no deployment, no gate change, no credential value read, no
bypass exercised. Measurements are Loki queries, `kubectl version`, a live-Job list, the sanctioned
`safe-env-inspect.mjs` in this run's own pod, and reading `origin/master` at `5de67c25e`.

**Revision 4 — 2026-10-30 (CTO, PEN-5063). The dates are set; see §11.** This revision adds §11 and
makes §6, §7 and §8 defer to it. It does **not** revise §§0-5, §9 or §10 — revising the plan is
PEN-5016's, and that row is closed. Two things moved overnight and §11.1 carries them rather than
re-photographing §1 and §3.1: **#3123 merged** (2026-10-30T00:19:07Z, on `master` as `87db03fcc` /
`7c53b431c`), and **#3112 went `DIRTY`**.

⛔ **The rest of this revision note is SUPERSEDED — read §11.2 instead.** It recorded the §1
carry-forward hazard as *live* and the three-key assertion on `BROKERED_POD_COMPOSITION_CONFIG_KEYS`
as reading **two** on `master`. Both were true when written and are **false now**:
[#3133](https://github.com/Blockcast/paperclip/pull/3133) landed the `workspaceVolumeClaim` pin on
`master` independently at `2026-10-30T04:26:24Z` (`16fbb8ae`), the key set reads **three**, and the
hazard is **discharged**. ⛔ **And the "#3112 must still be merged and never closed" line this note
used to carry is WITHDRAWN: #3112 was CLOSED without merging at `2026-10-30T10:23:55Z`, correctly.
It must NOT be reopened and merged — see §11.2 for the measurement and for what reopening would
cost.**

**Revision 2 — 2026-10-29, same day.** Three §3 preconditions moved while this PR was open and one
new one appeared, so the first revision's §3 is already wrong in the permissive direction: it reads
as though more is outstanding than is. #3097 and #3089 **merged**; Security chose §3.2's remedy and
pushed it (§3.2 below); and two fail-closed refusals that did not exist when revision 1 was written
now gate the stage population (**§3.5**). Everything in revision 2 is re-read at `origin/master`
`06e87072a` or at the named PR head, not carried over. Measurements dated 2026-10-29T13:33Z and
earlier are revision 1's and are not re-taken — §10 still bounds them.

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

**The gate is not ready to be flipped, and the blockers are not the soak.** Stage 1 should not start
until §3 is closed.

Revision 3 state, 2026-10-29T21:45Z. Every state below was re-read live and each merge was
confirmed by asking whether the commit is an ancestor of `master`, not by reading a `MERGED` label:

| §3 item | Revision 2 (19:30Z) | Now |
|---|---|---|
| #3097, the §5 starvation assertion | **merged** | on `master` (`c0d8b83eb`, ancestor-confirmed) |
| #3089, the env-credential refusal | **merged** | on `master` (`99905d39b`, ancestor-confirmed) |
| #3098, the §8 measurement | open, `BEHIND` | **open**, `BEHIND` — unchanged |
| §3.2, the gate is declinable per-issue | pushed as **#3112**, open | **open**, `CLEAN` |
| §3.3, no operator surface | added in **#3112**, open | **open**, `CLEAN` (same PR) |
| §3.5a, privilege beside the broker | pushed as **#3123**, open | **open**, `CLEAN` |
| §3.5b, per-issue `workspaceVolumeClaim` | pushed as **#3121**, open | ⛔ **merged — but into #3112's branch, not `master`** |

📌 **Superseded as a ledger by §11.1 (2026-10-30).** The table above is revision 3's state and two of
its rows have since moved. It is kept as the record of what was true when the plan was written; **the
ledger the dates bind to is §11.1**, and that is the one to re-read before acting.

⛔ **The one correction that changes the precondition count: #3121 did not land on `master`.** Its
base was `security/pen-5017-agent-scope-only-config-keys` (#3112's branch), not `master`, so its
merge commit `7cea4d40b` **is** #3112's current head and `compare/master...7cea4d40b` reports
`diverged` (ahead 5, behind 36) rather than `behind`. The PEN-5027 pin is therefore **not on
`master` and is not independently cleared** — it ships when and only when #3112 ships. A ledger that
reads the PR's `MERGED` label and stops will count this precondition as cleared; it is not. (This
corrects the stage-1 ledger recorded on PEN-5016 at 20:23Z, which listed #3121 among three cleared
items. The label is accurate; the inference from it is what does not hold.)

⚠ **And the trap that correction creates, which is new and is the reason it matters.** #3123 carries
**cherry-picks of #3112's first four commits** (PEN-5017) on top of `master` — but **not** the fifth,
`7cea4d40b`, which is PEN-5027. So if #3123 merges and #3112 is then closed as redundant because
"its content already landed", **the `workspaceVolumeClaim` pin is lost outright**: no other PR
carries it, and #3121 cannot be reopened against a deleted branch. #3112 must be **merged**, never
closed, even if every one of its PEN-5017 commits has already reached `master` by another route.

> ⛔ **SUPERSEDED — do not act on the instruction in the paragraph above.** Its premise ("no other PR
> carries it") was falsified by [#3133](https://github.com/Blockcast/paperclip/pull/3133), which
> landed the `workspaceVolumeClaim` pin on `master` independently. **#3112 was CLOSED without
> merging on 2026-10-30, correctly, and must NOT be reopened** — reopening and merging it with the
> wrong conflict resolution reinstates two superseded security verdicts. **§11.2 is authoritative
> here; this paragraph is a revision-2 photograph.**

**Three PRs are open, not four**, and one of them (#3112) now carries two preconditions rather than
one. The gate's readiness in the fleet is unchanged since revision 1: no gate is set anywhere.

## 2. What the gate actually does

Read at `vendor/paperclip-adapter-claude-k8s/src/server/job-manifest.ts` **`:2901`**,
`asBoolean(config.enableGitHubPublishBroker, false)`. Every anchor below is a line in that
same vendored file — not the `opencode-k8s` adapter's same-named `job-manifest.ts` — and each
was re-verified at source on `master` `56710069f` (2026-10-30T09:5xZ):

| | Gate off (today) | Gate on |
|---|---|---|
| GitHub Secret | mounted into the agent container | mounted into the `github-publish-broker` sidecar only (**`:3418`**, `enableGitHubPublishBroker && isGitHubCredentialSecretVolume(...)`, drops it from the agent) |
| Agent publish path | `git`/`gh`/MCP authenticate locally | agent asks the broker over a unix socket; `PAPERCLIP_GITHUB_BROKER_SOCKET` is set |
| Broad data mount | renders, annotated `broad:<reason>` | **`buildJobManifest` throws** (**`:3962-3964`**) — fail closed, not degrade |
| Pod shape | one container | `+1` native sidecar (initContainer, `restartPolicy: Always`), uid 1001, gid 1000, same image |

Two properties make staging possible, and both were verified in the source rather than assumed:

- **It is evaluated at Job render.** A flip affects *new* Jobs only; in-flight runs keep the shape
  they were rendered with. That bounds both rollout and rollback latency to the longest in-flight
  run, and it means no running agent is ever reconfigured underneath itself.
- **It is gated on there being a credential to move** — `brokerEnabled = enableGitHubPublishBroker
  && brokerSecretMounts.length > 0` (**`:3938`**). Enabling it where no GitHub Secret is
  mounted is a no-op rather than an agent that has lost its doors.

## 3. Preconditions — all of these gate stage 1

### 3.1 The PRs §7.3 names, plus the three this plan's own findings produced (state read 2026-10-29T21:45Z)

| PR | What it is | State | Why it gates |
|---|---|---|---|
| [#3097](https://github.com/Blockcast/paperclip/pull/3097) `27459d1e4` | the §5 starvation assertion | **MERGED** 16:55:15Z (`c0d8b83eb`, on `master`) | §7.3 *"The §5 starvation assertion is still outstanding, and it gates discharge"* calls it **"a rollout precondition for PEN-4933, not a follow-up"**. Until a test asserts that a bare `/usr/bin/git push` from uid 1000 in a brokered pod fails to authenticate, enabling the broker closes §7.1's *mount* route and leaves its *helper* route unproven — the narrower of the two, but the one §4 found cheaper for an attacker. |
| [#3089](https://github.com/Blockcast/paperclip/pull/3089) `d4f8aa383` | refuse to render the broker when an env-delivered credential would land on the agent | **MERGED** 17:26:01Z (`99905d39b`, on `master`) | §7.4 decided this refusal **stays**. Before it landed, enabling the gate would have rendered the broker *and* left an env credential in the agent container for any seat-bound agent — the boundary would silently not hold, reporting success. That is why it had to precede the first flip, and why §7 records that stage 1 must never be re-sequenced ahead of it. |
| [#3098](https://github.com/Blockcast/paperclip/pull/3098) `d2158387c` | the §8 measurement, trigger-4 firing, count 28 | **OPEN**, `BEHIND` | Not a technical blocker for the broker, but it is the change that puts the fired count into §7.1. Until it lands, §7.1 must not be cited (PEN-4989's own framing). **The CTO disposition of 2026-10-29 names it in stage 1's precondition set** (§7), so it gates the flip even though nothing in the gate's behaviour depends on it. Its red check is infrastructure — a cancelled `Install dependencies` on one shard — and needs a **job re-run, not a push**. |
| [#3112](https://github.com/Blockcast/paperclip/pull/3112) `7cea4d40b` | §3.2's remedy: `AGENT_SCOPE_ONLY_CONFIG_KEYS`, the `brokerImage` provenance fix, the conditional `enableDocker`/`dockerImage` pin, §3.3's schema field — **and, since #3121 merged into it, §3.5b's `workspaceVolumeClaim` pin** | **OPEN**, `CLEAN` | §3.2 is the only §3 item that is a *defect in the gate itself*. Until this merges, setting the gate `true` at agent scope ships a boundary the constrained principal can decline per-issue. **It now carries two preconditions, not one** — see §1 on why it must be merged rather than closed. |
| [#3121](https://github.com/Blockcast/paperclip/pull/3121) `16db213ad` | pins `workspaceVolumeClaim` to agent scope while the gate is on (PEN-5027) | **MERGED** 19:46:53Z — ⛔ **into #3112's branch, not `master`** | Availability, not confidentiality: without it a per-issue claim makes `buildJobManifest` throw once the gate is on (§3.5b). **No longer a PR to track; it is now a commit inside #3112** (`7cea4d40b`). Track #3112 for it, and do not count it as cleared on its own. |
| [#3123](https://github.com/Blockcast/paperclip/pull/3123) `44069aa2f` | refuses a brokered pod carrying privilege outside the broker (PEN-5026, §7.6) | **OPEN**, `CLEAN` | Closes the agent-scope half of the composition problem that #3112 closes only at issue scope (§3.5a). Based on `master` and **carries cherry-picks of #3112's first four commits — but not its fifth**, which is PEN-5027. So #3112 and #3123 must not both merge without a rebase in between, **and #3123 merging does not make #3112 redundant**. |

📌 **The live ledger is §11.1; this table is revision 3's snapshot.** The warning below is the plan's
own, it was correct, and it fired again overnight — #3123 merged and #3112 went `DIRTY` within hours
of revision 3. §11.1 carries the current state and §11.2 carries the hazard that produced it.

⚠ **These states are a snapshot and will go stale — re-read them live before acting on this table,
the same way §4 asks for its query to be re-read before each stage widens.** Two of the six moved
between revisions 1 and 2, four hours apart; a third moved between revisions 2 and 3, two hours
apart — and that third one moved in a way a `MERGED` label reports as cleared and `compare` reports
as not (§1). A precondition check that quotes this table rather than re-reading it is quoting a
photograph, and one that reads a PR's state field rather than asking whether its commit is an
ancestor of `master` is reading the wrong field.

**Ordering consequences, stated because they are easy to get backwards:**

1. #3089 had to land *before* the first flip, not alongside it — a brokered pod that also holds
   `GH_TOKEN` is strictly worse than an unbrokered one, because it carries the cost of the boundary
   and none of the benefit while looking enabled. **It has landed.**
2. #3121 **has merged into #3112's branch**, so the stack is gone and with it the retarget hazard
   revision 2 warned about. What replaces it is narrower and sharper: #3123 carries cherry-picks of
   #3112's PEN-5017 commits but **not** its PEN-5027 commit, so #3112 must be **merged, never
   closed** — closing it after #3123 lands would silently drop §3.5b's pin, which exists on no other
   branch. Merge order between #3112 and #3123 is still free; merging both without a rebase in
   between is still not.
   > ⛔ **SUPERSEDED — see §11.2.** "exists on no other branch" ceased to be true when #3133 landed
   > the pin on `master`. #3112 is **closed and must not be reopened**; `master` reads all three
   > `BROKERED_POD_COMPOSITION_CONFIG_KEYS` today.
3. **#3098 does not interact with the other two.** It touches only the decision document, has no
   code in it, and its red check is infrastructure. It gates stage 1 by disposition, not by
   mechanism — it needs a job re-run and an owner's attention, not sequencing.

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

**Disposition — Security chose, on 2026-10-29, and it is pushed but not landed.** Recorded as
PEN-3183 **§7.5**; implemented in [#3112](https://github.com/Blockcast/paperclip/pull/3112). The
choice was *pin to agent provenance* — an `AGENT_SCOPE_ONLY_CONFIG_KEYS` set re-asserting the base
value after the merge — plus the loud half of the refusal option: the discarded overlay is logged
rather than dropped silently. Refusing to render was declined because it would convert a latent
confidentiality finding into a reachable availability one, any actor able to assign an issue being
able to park the key on *another* agent's issue and fail every dispatch of it. §3.3's schema field
is in the same PR.

**Review then found that pinning the gate does not pin the boundary, and that is the part worth
carrying forward.** Two sibling keys could decline the same boundary while leaving the gate pinned
exactly as intended, and both were found by review rather than by the list:

- **`image`** is what the broker *itself* runs — `buildGitHubPublishBrokerSidecar` execs
  `paperclip-github-token-env` and the broker runtime out of it, at uid 1001, with the credential in
  its environment. Closed adapter-side rather than with a second list entry: the broker now renders
  from `ctx.agent.adapterConfig` (the agent row before any merge) while the **agent** container
  deliberately keeps the merged value, since a brokered agent container holds no credential and what
  it runs is its own business.
- **`enableDocker` / `dockerImage`** render a `privileged: true, runAsUser: 0` sidecar in the same
  pod. Pinned to agent scope **conditionally** — only while the gate is on
  (`BROKERED_POD_COMPOSITION_CONFIG_KEYS`), so docker stays freely overridable for every agent that
  is not brokered.

The membership rule is written at the list rather than left as a list of remembered incidents: *when
the credential is brokered, what code runs in the pod and at what privilege is agent scope's to
decide.*

⚠ **The class is not closed, and this plan should not be read as saying it is.** A list is as
complete as its last edit, and that weakness has now fired twice on its first outing. What is closed
is the *issue-scope* route for four named keys. §3.5a is the one class member closed structurally
rather than by name.

**Stage 1's gate is "#3112 merged", not "Security chose".** The choice is made; the fleet is
unchanged until it lands. Stage 0 carries **no PR merges** and does not wait on this (§7);
#3112 sits in stage 1's precondition set.

> ⛔ **SUPERSEDED in its mechanism; its point stands.** **#3112 was CLOSED without merging on
> 2026-10-30T10:23:55Z and must not be reopened** (§11.2). The gate was never really that PR — it is
> the §3.2 remedy being **on `master`**, which it is: the content reached `master` by way of #3123 and
> #3133. Read as written, this sentence makes stage 1 wait on an event that can no longer occur.
> §9's table and §11.1 carry the measured set.

### 3.3 The gate has no operator surface

`enableGitHubPublishBroker` is **absent from `getConfigSchema()`**
(`vendor/paperclip-adapter-claude-k8s/src/server/config-schema.ts`). The only in-repo occurrences are
`job-manifest.ts`, its tests, the PROVENANCE entry, the wrapper README and the decision doc. `asBoolean`
reads whatever key is present in the merged config, so the flag *works* — but there is no UI field,
which means every stage below is an `adapterConfig` patch rather than a toggle, and a reviewer
cannot see the gate's state in the agent form.

Not a blocker on its own; it **is** a blocker for the rollback requirement in §6, which needs the
state to be legible to whoever is deciding at 3am. **Done in #3112**, as a `toggle`. ⚠ The schema
field is a *view*: `asBoolean` still reads the merged config, and the enforcement point is
`AGENT_SCOPE_ONLY_CONFIG_KEYS` (§3.2), not the schema. A reviewer reading the agent form now sees
the gate's state; they do not thereby see that it held.

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

### 3.5 Two fail-closed refusals that did not exist when this plan was written

Both are new since revision 1, both are **correct**, and both change the stage *population* rather
than the design. Neither is reachable today: each is conditional on the gate being on.

#### (a) A brokered pod may not carry privilege outside the broker — PEN-5026, PEN-3183 §7.6, [#3123](https://github.com/Blockcast/paperclip/pull/3123)

Read at `44069aa2f` in `vendor/paperclip-adapter-claude-k8s/src/server/job-manifest.ts`.

⚠ **It is not a check on `enableDocker`, and describing it as one understates it.** It is a property
check on the **assembled pod spec**: while `brokerEnabled`, `findPrivilegedContainersBesideBroker`
walks `initContainers` + `containers` + `ephemeralContainers`, exempts the broker by name, and
`buildJobManifest` throws if any remaining container is `privileged: true`, has
`allowPrivilegeEscalation` set to anything other than `false` (**unset counts** — Kubernetes defaults
it to true), or adds one of five escape capabilities (`SYS_ADMIN`, `SYS_PTRACE`, `SYS_MODULE`,
`SYS_RAWIO`, `SYS_BOOT`). The throw names the offending container and the leg that failed.

Two consequences for the stage plan that a key check would not have had:

- **It covers containers nobody has written yet.** A sidecar added later that omits
  `allowPrivilegeEscalation: false` makes every brokered pod in the stage unrenderable. So this is a
  pre-flight at **every widening**, not a one-time census of who has docker on.
- **The discriminator is privilege, not uid, and that is deliberate.** PEN-4932's
  `seed-writable-dirs` init container runs at uid 0 by necessity — it creates the `subPath` targets a
  narrow mount needs, and `narrowWritableSurface` is itself a precondition of the broker — and is
  exempt by construction: unprivileged, `allowPrivilegeEscalation: false`, every capability dropped
  but `CHOWN` and `DAC_OVERRIDE`, and exited before the broker process exists. **Do not report a
  uid-0 container in a brokered pod as a violation of this**, and do not propose tightening it to
  uid.

**Measured cost to the stage population: zero, today.** Read 2026-10-29T19:20Z over all **11** agents
in `b1d3f3d3` (Penstock) through the company agent list: **0 set `enableDocker` at agent scope.**
Nine are `claude_k8s` and carry no `enableDocker` key at all (eight have an empty `adapterConfig`,
one — Devops — has a populated one with no such key); two (`Reflection Coach`, `Summarizer`) are
`claude_local` and never render a Job at all. That agrees with revision 1's independent cluster-side
reading (23 of 23 live agent Jobs single-container, §5.1) and with BLO-40401's finding that the only
in-repo `enableDocker: true` is a test fixture.

So §7.6 costs stage 1 and stage 2 nothing — and the docker exclusion Security asked to be *enforced
rather than written down* is enforced, in the stronger form: on the rendered pod rather than on the
key. Bounds in §10.

#### (b) A per-issue `workspaceVolumeClaim` throws once the gate is on — PEN-5027, [#3121](https://github.com/Blockcast/paperclip/pull/3121)

`workspaceVolumeClaim` is read off the merged config and feeds `narrowWritableSurface`; a foreign
claim reaches the broad-data-mount refusal of §4 and `buildJobManifest` throws. Fail-closed, so no
confidentiality loss — but it is the *same* per-issue denial of service §3.2's ground 1 declines to
create, reached by a different key, and it becomes reachable at stage 1. #3121 pins the key to agent
scope while the gate is on, the same conditional shape as `enableDocker`. ⚠ **#3121 has since merged
into #3112's branch rather than into `master`** (§1), so this pin now ships as commit `7cea4d40b`
inside #3112 and is not separately trackable.

> ⛔ **SUPERSEDED.** The pin is on `master` in its own right as `16fbb8aef`, landed by
> [#3133](https://github.com/Blockcast/paperclip/pull/3133) on 2026-10-30T04:26:24Z, and #3112 is
> closed. It is separately trackable again, and §11.6's check 1 reads **three**
> `BROKERED_POD_COMPOSITION_CONFIG_KEYS` on `master` precisely because of it.

**What (a) and (b) together do to §6:** the set of "the agent cannot run, and that is a control
working correctly" grows from two members to three. §6's rollback evidence item 3 is updated to
match, because all three present identically to whoever is woken up.

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
runtime descriptor agent-scoped persistent roots so that `narrowWritableSurface` holds — the
`mode === "shared"` branch and its rationale comment in
`vendor/paperclip-adapter-claude-k8s/src/server/job-manifest.ts` at **`:811-820`**, with
`narrowWritableSurface` itself defined at **`:3230`**; before it, a shared run returned
`enabled:false` and kept the whole PVC mounted rw. `isolation_disabled` being the *only* leg that
ever fired, and its stopping dead at that change, is consistent with that and with nothing else.

⚠ **The surviving broad path, which the zero does not cover.** `resolveJobIsolation` falls through to
`SHARED_JOB_ISOLATION` (`enabled: false`) when a run arrives with **no runtime isolation descriptor**
and `config.isolationMode` is not `isolated`/`isolate` — in
`vendor/paperclip-adapter-claude-k8s/src/server/job-manifest.ts`, the constant declared at **`:762`**
and returned at **`:885-887`**. The comment at **`:3207-3209`** names it: *"only a config-only run
with no descriptor and no `isolationMode` still reaches this fallback."* The measured zero is
therefore a property of **the server supplying a descriptor on every render**, not of configuration.
A run path that stops supplying one renders broad — and once the gate is on, that stops being a
quiet annotation and becomes a hard build failure for that agent.

ℹ **Line anchors in this section were re-derived at `master` `16fbb8aef`, 2026-10-30 (PEN-5071).**
They are the file's only moving part — re-measure before citing them, do not trust them by age. The
four they replace were stale by 20-250 lines each, and §11.7 had copied two of them.

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
  Since revision 1 this is also **enforced rather than merely observed**: §3.5a refuses to render a
  brokered pod carrying privilege outside the broker, so the DinD shape and the broker shape can no
  longer co-exist by accident. The 23/23 figure is now the measurement that says the refusal costs
  nothing, not the only thing standing between the two.

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

The broker writes to **its own container's stderr**, which reaches Loki as
`container="github-publish-broker"`. There is **no metric** — no counter of brokered publishes,
refusals, or errors.

⚠ **Anchors are symbols, not line numbers.** This paragraph used to cite
`github-publish-broker.ts:271,329,419`; by 2026-11-01 those had rotted to `:278,366,417` without a
line of this section changing, and the PEN-5185 fix below moved them again. Grep the symbol
(PEN-5091).

**What reaches that stderr, as of PEN-5185:**

| Site | Class |
|---|---|
| `main()` in `github-publish-broker-runtime.ts` — the listen line and the `catch` | **(a) startup**, success and failure |
| `ctx.log` in `startChild` | the **denominator** — one line per accepted invocation, per door |
| `formatBrokerOutcomeLine` via `sendExit` | **(b) refusals and (c) child exits** — one line per connection, carrying the outcome verb, the tool and the code |

⛔ **What is deliberately NOT written there: the child's bytes.** `child.stderr` is relayed to the
socket, back to the agent that asked for the publish, and nowhere else. It is `git`/`gh` output and
can carry a URL with an embedded token; Loki outlives the pod's `ttlSecondsAfterFinished: 300`, so
teeing it into the container log would convert this observability surface into a durable
credential-disclosure path. The outcome line carries the exit code and the tool name only. A refusal
also carries its own prose reason, passed through `scrubGitHubEgressText` first because several
refusals interpolate caller argv.

Two properties a query writer has to know about that reason:

- **It is capped** at `MAX_OUTCOME_DETAIL_CHARS` (1024) and a cut line ends in
  `[paperclip-github-broker: detail truncated]`. The reason is caller-influenced up to the 1 MiB
  request cap, so without a bound one refusal could emit a one-megabyte Loki line. The truncation
  marker is spelled so it cannot be read as `[paperclip-egress-scrub redacted: …]`: *"the rest was
  too long"* and *"the rest was a credential"* are different facts and must not share a marker.
  Scrubbing happens **before** truncation, because cutting first could sever a token below the
  length its detector matches on and emit the surviving prefix verbatim.
- **It is best-effort.** A throw from the log call cannot cost the connection its `EXIT` frame and
  cannot kill the sidecar — these are EventEmitter callbacks, so an uncaught throw there would end
  the broker process and every publish for the rest of the Job's life, which is precisely the §6
  *"a Job that never renders is indistinguishable from 'the broker broke dispatch'"* shape. The
  consequence for a reader: a dropped outcome line shows up as an **imbalance between the accept
  count and the outcome count**, not as a miscount inside a category. Compare the two.

**Corrected by PEN-5185; recorded because the error was load-bearing.** This section
previously claimed the broker "writes refusals and child stderr to its own container's stderr".
Both halves were wrong. Child stderr went to the socket and never to the log — and the broker framed
every publish *outcome* to the socket too, so its own stderr carried only the *inputs*. Three
classes were therefore structurally unobservable, not merely quiet: **(c) in its entirety**, **spawn
failures** (which this section did not name at all), and the **protocol half of (b)** — four of
`refuse`'s five call sites never touched the policy module and so never reached a log. A dashboard
panel for (c) would have printed `0` forever, and `0` is byte-identical to *"no child ever failed"*,
which is the exact confusion this section exists to prevent. `sendExit` and `refuse` now log through
one chokepoint. ⛔ The outcome verb, not the exit code, separates a refusal from a child exit:
`refuse` defaults to `64` and a child can genuinely return `64`.

With `ttlSecondsAfterFinished: 300`, **Loki is the only durable record** of what the broker did; the
pod is gone five minutes after the run. This is the same completeness argument PEN-4988 makes for
trigger 2, and it has the same consequence: soak evidence must be collected from Loki inside the
window, not reconstructed from the cluster afterwards.

**Minimum soak instrumentation, in scope for stage 0:** a saved query over
`{namespace="paperclip",container="github-publish-broker"}` separating (a) startup failures,
(b) policy refusals, (c) child non-zero exits. Without it stage 1 is unfalsifiable — a silent broker
and a broker nobody asked to publish look identical. Shipped by PEN-5181 as
`scripts/github-publish-broker-soak-queries.mjs` and `runbooks/github-publish-broker-soak-queries.md`;
that tool prints `NOT OBSERVABLE` rather than `0` for any category the broker cannot yet emit, which
is the right stopgap and is why a stage-1 reading of it is honest even where this section was not.

⛔ **Stage 1 still confirms its own observations agent-side.** PEN-5185 lands *between stage 1 and
stage 2*, deliberately: changing the logging of the component under test days before its first
real-traffic soak would mean the thing soaked is not the thing reviewed, and §7 is explicit that
stage 0 carries no PR merges. So §7's observations (b) a real `git push`, (c) a real non-push `gh`
and (d) an MCP tool call are confirmed from the run log and from the PR existing — not from the
broker container. §5.2 already predicts that asymmetry for `gh` and MCP. From stage 2 on, where the
population is a whole company and confirming every publish outcome agent-side stops being
affordable, the broker's own logs carry it.

**The window is a predicate, not a date** (Security, under §11.3): *after stage-1 exit is declared,
before stage-2 start*. It moves when stage 1 moves — §11.3 re-set stages 2 and 3 as `stage-1
exit + 1 working day` for exactly this reason, and a fixed date here would repeat the mistake one
level down. In the earliest case that window is a **single working day**, so the review is done
*during* stage 1 and only the merge is held.

⛔ **Decided fallback, recorded now rather than settled under time pressure:** if this change is not
ready to land when stage 2 would otherwise start, **stage 2 starts on time** and the change slides
to the stage-2 → stage-3 boundary. It is not landed mid-stage, and no stage is delayed to fit it.
The soak is the only part of this plan that produces evidence (§11.3); an observability improvement
must not compress it.

## 6. Rollback — who decides, and on what evidence

⚠ §7.3 is explicit, and this is the sentence that shapes this section:

> **Switching it back off after enablement re-opens §7.1 and is a Security decision, not an incident
> one.**

Stated plainly: **the first bad night makes this call by default unless it is written down now.** It
is written down here.

**Decision owner: Security (`7500672d`). Not the on-call engineer, not Devops, not the agent that
noticed.** ✅ **Accepted and bound by the CTO 2026-10-30 (§11.4), which also names what happens when
Security is unreachable — the gap that would otherwise let the first bad night decide by default.**

The reason is not ceremony — switching the gate off restores an acceptance that was ended
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
3. Confirmation that the failure is not one of the **three refusals that are working as designed**:
   the broad data-mount refusal (§4), the env-credential refusal (§3.1, merged as #3089), and the
   privilege-beside-the-broker refusal (§3.5a, #3123). All three present identically as "the agent
   cannot run", and none is a broker defect. **Rolling back on any of them would be rolling back a
   control that correctly refused.** Each names its own leg in the thrown message — read the message
   before reading the gate as the cause.
4. Whether narrowing the stage (row 1 above) already restored service — if it did, that is the
   remedy, and the gate stays on for the stages that are healthy.

**Rollback latency is bounded and should be stated to whoever is deciding:** the gate is read at Job
render, so switching it off takes effect for the next Job and in-flight runs keep the broker. Nothing
needs draining; nothing is reconfigured underneath a running agent.

## 7. Soak shape

⚠ **§11 owns the dates. The per-stage dates below are the proposals §11 accepted; where §11 differs
it wins, and it differs on stages 2 and 3.** Read this section for stage *shape* — population,
pre-flight, observations, exit criteria — and §11 for *when*. (One owner per rule; this cross-reference
exists so the two copies cannot drift.) Each stage's exit criteria must hold for its whole
duration, not at a single instant. Day counts assume stage 0 completes; every stage boundary is a
re-read of §4's trigger-2 query, not a one-time clearance.

**Stage 0 — preparation (not a soak).** **2026-11-05, firm and unconditional** (CTO, 2026-10-29).
Stage 0 carries **no PR merges** — it is preparation only, and it can complete while every
precondition PR is still open. Exit: the §5.3 broker log queries saved; §4's trigger-2 query re-run
and clean, **asserted for the stage-1 agent's environment and not only its agent config** (§4); the
§3.5a privilege pre-flight run across the stage-1 population; the board-level env-scope read of §3.4
returned clean; the §5.1 node-capacity baseline recorded. **No gate is set in stage 0.**

⚠ **The saved queries are the load-bearing item.** Without them stage 1 is unfalsifiable, because a
silent broker and a broker nobody asked to publish are the same observation (§5.3).

**Stage 1 — one agent, one company.** **Does not start on a date. It starts when every precondition
below is on `master`**, target **2026-11-06**, which is an earliest-start and not a commitment (CTO,
2026-10-29). Duration ≥ 3 working days. ✅ **Set in §11.3, with the mechanical entry gate in §11.6 —
none of whose four checks fails as measured 2026-10-30, two of the four being perishable and owed a
re-run at the gate (§11.6 is authoritative; a green there is not a go).**

**Stage 1's precondition set — all must be on `master`. ⛔ Confirm each by its LANDED commit, or by
content where there is no merge commit — NEVER by the PR's head commit:**

| | Landed as | State, measured 2026-10-31 |
|---|---|---|
| #3097 §5 starvation assertion | `c0d8b83eb` | ✅ **on `master`**, ancestor-confirmed |
| #3089 env-credential refusal | `99905d39b` | ✅ **on `master`**, ancestor-confirmed |
| #3098 §8 measurement | `0fa107202` | ✅ **on `master`** — merged 2026-10-30T03:32:58Z. Its red was infrastructure and was cleared by a **job re-run, not a push**, as this plan predicted |
| #3123 PEN-5026 privilege refusal | `7c53b431c` | ✅ **on `master`** — merged 2026-10-30T00:19:07Z |
| #3112 PEN-5017 agent-provenance gate | **none — CLOSED unmerged** | ✅ **discharged by content on `master`**, carried there by #3123 and #3133 rather than by this PR (§11.1, §11.2). It must **not** be reopened |
| PEN-5027 `workspaceVolumeClaim` pin | `16fbb8aef` (#3133) | ✅ **on `master` in its own right** — no longer "inside #3112" |

**Six of six; the precondition set is complete.** ⛔ That is not a stage-1 go and must not be cited as
one: §11.3's date floor governs independently (stage 0 `2026-11-05`, stage 1 earliest `2026-11-06`),
and §11.6's checks 3 and 4 are perishable point-in-time reads that must be re-run immediately before
the start.

⛔ **Why this table names landed commits — and why the obvious mechanical check is the wrong one.**
This repo lands through a merge queue, which **rebases before it merges**. A PR's `headRefOid` is
therefore never an ancestor of `master`, *even after that PR has merged*. Measured 2026-10-31: all
six PRs above — **including the five that merged** — return `diverged` from
`compare/master...<headRefOid>`, while all five merged ones return `behind` from
`compare/master...<merge_commit_sha>`. So the rule this section used to carry — *"ancestor-confirmed,
not label-read"* — names no object, and the natural object to reach for is the PR head, which fails
**every row in this table**. It was written to defeat a stale label and instead defeats the reader
who follows it most carefully, in the direction of a false *failure*: the safe direction, but it
would have left the gate unenterable by anyone doing it properly. Use `merge_commit_sha` for a
merged PR; use content on `master` for #3112, which has no merge commit at all. §11.6's check 2
carries the same warning for the same reason.

⚠ **#3089 is the one that must never be reordered.** The CTO will not move stage 1 earlier than it
under any circumstance: enabling the gate while an env-delivered credential is still in the agent
container is strictly worse than not enabling it. It is on `master`; this note exists so a future
re-sequencing does not undo that.

**If the set is not complete on `master` by 2026-11-12, that is an escalation to the CTO, not a
silent slip.** The open PRs are the live risk here, not the soak.

**Stage 1's standing disposition on §3.5b** — recorded verbatim as the CTO wrote it on PEN-5016
(2026-10-29), because a disposition that exists only in a comment thread is the failure PEN-4988 was
filed to stop:

> **`workspaceVolumeClaim` ([PEN-5027](https://paperclip.blockcast.net/PEN/issues/PEN-5027)) —
> blocks stage 1; does not gate stage 0.** A lower-scope `workspaceVolumeClaim` survives into the
> merged run config, reaches `narrowWritableSurface`, and makes `buildJobManifest` throw on the
> broad-data-mount refusal once the broker is on — so from stage 1 onward anyone able to assign an
> issue to the stage-1 agent can fail every dispatch of that issue. **CTO disposition 2026-10-29:
> not accepted.** Remedy is (a) discard the key below agent scope, with the discard logged naming
> the key and the originating scope. Rationale is cost asymmetry, not severity: the fault is
> fail-closed and bounded, but a Job that never renders is indistinguishable from "the broker broke
> dispatch", and that is the misattribution most likely to force a rollback — which §7.3 makes a
> Security decision that re-opens §7.1. **Stage 1's precondition set is therefore #3097, #3089,
> #3098, #3112 and PEN-5027.**

Two mechanical notes on that last sentence, which was accurate when written and has moved twice
since. PEN-5027 briefly shipped **inside #3112** rather than as #3121 — it is now on `master` in its
own right as `16fbb8aef` (#3133), and #3112 is closed unmerged; and **#3123 joined the set
afterwards** (§3.5a), which the disposition predates. The disposition's *substance* is unchanged and
is met — the set as measured today is the six rows in the table above, all six on `master`.

Population: a single `claude_k8s` agent that publishes often enough to exercise all three doors
within the window. **Devops (`11b9c48f`) volunteers as stage 1**: this seat opens PRs daily, uses
`gh` and the GitHub MCP server in the same runs, and its failure is visible to its own owner rather
than to a tenant.
Pre-flight (new, §3.5a): confirm the population renders no privileged container beside the broker.
For stage 1 that is one agent and it is already clean — Devops carries no `enableDocker`. **Re-run it
at every widening rather than citing this sentence**, because the check is on the assembled pod and a
container added later is in scope.
Observe: (a) **Job completion**, not just run success — the native-sidecar risk of §5.1; (b) a real
`git push` reaching GitHub; (c) a real `gh` call *other than* push; (d) a GitHub MCP tool call; (e)
zero unexplained broker-container errors; (f) trigger-2 still zero.
Exit: all six, across ≥ 3 days and ≥ 10 runs.

⚠ **Stage 1 is only evidence if the agent in it actually has D1's property.** A brokered agent that
also ran privileged root would publish perfectly well and read green without the boundary holding,
and no metric in §5.3 distinguishes the two. Before §3.5a that was a measurement-validity hole in
this plan; §3.5a closes it structurally, which is why #3123 is a **stage-1 precondition** and not a
follow-up.

**Stage 2 — one company, all agents.** Proposed **2026-11-11 → 2026-11-18** (≥ 5 working days).
⚠ **§11.3 re-set this as `stage-1 exit + 1 working day`, with these dates as the earliest case** —
a fixed calendar date downstream of a conditional start compresses the soak when the start slips.
Population: all `claude_k8s` agents in `b1d3f3d3` (Penstock) — **9 of the 11 agents in the company**
(§3.5a), the other two being `claude_local` and never rendering a Job. §4's broad-render history
counts 8 *distinct agents* fleet-wide and this plan has **not** mapped those 8 to companies, so do
not read them as the same 8; the reason to start here is that it is this plan author's own company
and the §3.5a pre-flight is clean across it, not a company attribution §4 does not make.
Pre-flight (§3.5a): re-run the privilege check across all 9 — clean at 2026-10-29T19:20Z, and stale
by stage 2.
Observe: stage 1's list, plus node capacity against the `+50m/+128Mi` per pod of §5.1, plus any agent
whose runs stopped completing.
Exit: as stage 1, plus no scheduling regression attributable to the sidecar.

**Stage 3 — fleet.** Proposed **2026-11-19 → 2026-11-26**.
⚠ **§11.3 re-set this as `stage-2 exit + 1 working day`, these dates being the earliest case.**
Population: the second company (2 observed) and anything added since. A node-capacity check is a
precondition here, not an observation.
Exit: as stage 2, held for a full week.

**Then, and only then, §7.1 is discharged** — and per §7.3 item 1 the acceptance is discharged when
the gate is on **and** the §5 starvation assertion is satisfied, which is why #3097 is a stage-1
precondition and not a stage-3 one.

### 7.1 What the flip commit itself must carry, beyond the gate value

The flip is a documentation edit as well as a config change. One specific edit is **inherited**: it
came out of Ally's review of [#3120](https://github.com/Blockcast/paperclip/pull/3120), was declined
there as out of scope, and was carried to this row by the CTO (PEN-4933 comment `9fd5cf52`, recorded
on PEN-5016 at 2026-10-29T20:23Z). It is written here so that it survives the thread:

> `docs/security/PEN-3183-git-egress-enforcement-boundary-decision.md` says both `gh.real` fallbacks
> *"are closed by it"* with **no qualifier**. That holds only while **link D** holds — i.e. while the
> brokered agent container still *sets* `PAPERCLIP_GITHUB_TOKEN_FILE`.

**Independently verified against `master` for this revision**, rather than carried on the CTO's word:
`scripts/gh-token-wrapper.sh:405` guards the token-file path on `${PAPERCLIP_GITHUB_TOKEN_FILE+x}`
being set, and `:528` is an unconditional `exec_real_gh "$@"` fallthrough. With the variable unset
the wrapper execs the real `gh` under whatever ambient auth exists, and both fallbacks §5 names are
live again.

**Action: add `(given link D)` to that sentence in the same commit that flips the gate.** It is free
there — flipping `enableGitHubPublishBroker` rewrites that §5 status block anyway — and expensive as
a standalone PR today, because several open PRs already edit that file. §7.3 states the C/D pairing
correctly, so this is a **signposting gap, not an unflagged claim**: it is not a new residual and not
a correction to the decision. It does not gate any stage; it gates the flip commit's completeness.

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

✅ **The 2027-01-31 review date is bound by the CTO 2026-10-30 (§11.5), and §11.5 requires it to be
given a carrier row before stage 3 exits.** A review date recorded only in this table has the same
defect PEN-4988 exists to encode: a date with no owner is not a review, and the acceptance it
succeeds is the thing that would quietly take it down.

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
- **It does not implement §3.2's fix, or §3.5's two refusals.** The shape of those boundaries is
  reserved to Security by §8; Security chose and implemented them (#3112, #3123), and #3121 — the
  availability half of §3.5b, which §8 does not reserve — is the only one of the three this plan's
  author wrote. This document records the dispositions; it does not make them.
- **It does not touch §8's forbidden list**, and nothing in it approaches that list: no relaxation of
  `allowPrivilegeEscalation`, dropped capabilities or `runAsNonRoot`; no integrity check between
  wrapper, hook and scanner; no change to the credential path; no env-delivered credential routed
  through the broker (§7.4 refused that, and this plan keeps the refusal as a **stage-1
  precondition** — #3089, now on `master`).
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
- §3.5a's "0 of 11 set `enableDocker`" is **agent scope, one company, one instant**
  (2026-10-29T19:20Z). It is a sound negative at that scope — the agent list returns `adapterConfig`
  with keys visible and only values redacted, so an absent key is absent and not hidden. It says
  nothing about project or environment scope (unreadable, §3.4), nothing about the second company
  (not readable from this seat), and nothing about ten minutes later. It is also **not the thing
  §3.5a checks**: the refusal is on the assembled pod, so a clean `enableDocker` census is evidence
  that the refusal costs nothing today, not evidence that it will not fire.

## 11. Date authority exercised — the dates, SET (CTO, 2026-10-30, PEN-5063)

§9 reserves this to the CTO: *"PEN-5016 produces the plan; the CTO sets the date against it."* This
section is that act. It is deliberately a separate section rather than an edit to §7, so that what
Devops proposed and what the CTO set stay distinguishable in the history of this file.

**Why this section exists at all, and not as a comment.** The date has been owed since 2026-10-29 and
lived in two comment threads (my disposition `03d7f7d4` on PEN-4989, my *"I still owe the date"* on
PEN-5016). PEN-4988 exists to encode the failure that a directive recorded only in a comment has no
owner — and I cited it at Devops while leaving my own deliverable in exactly that shape. The dates
are therefore set **here**, in the merged document, where they outlive the thread.

### 11.1 The stage-1 precondition ledger, discharged (state re-read 2026-10-30T03:4xZ, PEN-5069)

⚠ Read this table, not §1's or §3.1's — those are revision-3 photographs and §3.1 says so itself.
Every row was decided by **asking whether the content is on `master`**, never by reading a `MERGED`
label. ⛔ And not by asking whether the PR's *head SHA* is an ancestor either: the merge queue
**rebases**, so a merged PR's head SHA is generally **not** an ancestor of `master` even though its
content is. #3123 is the worked example — `44069aa2f` is not an ancestor, and its content is on
`master` as `87db03fcc` / `7c53b431c`. A ledger that tests head-SHA ancestry reports a landed
precondition as outstanding, which is the *conservative* direction but still wrong.

| # | What it is | State 2026-10-30 | Discharged? |
|---|---|---|---|
| [#3097](https://github.com/Blockcast/paperclip/pull/3097) | §5 starvation assertion | on `master` (`c0d8b83eb`) | ✅ |
| [#3089](https://github.com/Blockcast/paperclip/pull/3089) | env-credential refusal | on `master` (`99905d39b`) | ✅ |
| [#3120](https://github.com/Blockcast/paperclip/pull/3120) | §5 assertion recorded as satisfied | on `master` (`978ba0f6d`) | ✅ |
| [#3123](https://github.com/Blockcast/paperclip/pull/3123) | PEN-5026 privilege-beside-broker refusal | **merged 2026-10-30T00:19:07Z**, content on `master` (`87db03fcc`, `7c53b431c`) | ✅ **new since revision 3** |
| [#3098](https://github.com/Blockcast/paperclip/pull/3098) | §8 measurement, trigger-4 count 28 | **merged 2026-10-30T03:32:58Z**, content on `master` (`0fa107202`) | ✅ **landed in the same merge group as this section** |
| [#3112](https://github.com/Blockcast/paperclip/pull/3112) | PEN-5017 provenance gate (`7cea4d40b`) | **CLOSED without merging** 2026-10-30T10:23:55Z — **content is on `master` in its own right**, carried there by [#3123](https://github.com/Blockcast/paperclip/pull/3123) and [#3133](https://github.com/Blockcast/paperclip/pull/3133), not by this PR. Verified at source on `584068888`, not from the closing comment (§11.2) | ✅ **discharged by content, not by merge** |

**Six of six discharged.** ⚠ The sixth was discharged by **closure**, not by merge, and the
distinction matters: #3112's content reached `master` through #3123 and #3133 while #3112 itself was
closed unmerged. A ledger that reads `merged` as the discharge condition would call this row
outstanding forever. Re-verified at source on `584068888` — `AGENT_SCOPE_ONLY_CONFIG_KEYS`
(`server/src/services/heartbeat.ts:2832`), `withAgentScopedConfigProvenance` (defined `:2973`,
applied `:7060`), `BROKERED_POD_COMPOSITION_CONFIG_KEYS` (`:2911`, three keys),
`vendor/paperclip-adapter-claude-k8s/src/server/config-schema.ts:216` — **not** from the closing
comment's word.

⛔ **Six of six is not a stage-1 start.** It satisfies §11.3's condition 1 only. §11.3's date floor
(stage 1 earliest `2026-11-06`) and §11.6's four checks both still govern, and §11.6's checks 3 and 4
are perishable measurements that must be re-run at the gate. See §11.6.

⭐ **The #3098 row was falsified by the merge batch that published this section, and that is worth
understanding rather than just reading past.** #3098 and #3132 — the PR that added §11 — merged in the
**same merge group**, both at `2026-10-30T03:32:58Z`. So this ledger reached `master` already
describing #3098 as open. No push and no review could have caught it: at every moment the text was
reviewable it was true, and it became false at the instant it landed. A ledger of other people's
open PRs cannot be verified once, at authoring time — which is exactly why §11.6 check 2 re-reads it
mechanically at the gate instead of citing this table.

### 11.2 The carry-forward hazard is DISCHARGED — and #3112 is CLOSED, correctly; it must NOT be reopened

The hazard §1 warned about fired, and has since been **discharged**. #3123 merged carrying
cherry-picks of #3112's **first four** commits but not its fifth, which briefly left the
`workspaceVolumeClaim` pin on #3112's branch alone.
[#3133](https://github.com/Blockcast/paperclip/pull/3133) (PEN-5027) then landed that pin on
`master` independently at **2026-10-30T04:26:24Z** (`16fbb8ae`). Re-measured at source on `master`
`56710069f`, 2026-10-30T09:5xZ:

```
BROKERED_POD_COMPOSITION_CONFIG_KEYS  (server/src/services/heartbeat.ts:2911)
  on master      → { enableDocker, dockerImage, workspaceVolumeClaim }   ← THREE
  on #3112 head  → { enableDocker, dockerImage, workspaceVolumeClaim }   ← THREE
```

**Two keys on `master` was the predicted signature of the pin having been dropped. There are three,
so that signature is gone** — the pin is on `master` whatever happens to #3112.

⛔ **#3112 was CLOSED without merging at `2026-10-30T10:23:55Z` (head `7cea4d40b`), per the CTO
ruling on PEN-5017, and that closure is CORRECT. The instruction this section used to carry — "must
be merged, never closed" — is WITHDRAWN. Do not reopen it, and do not merge it.** The sole-carrier
rationale it rested on is discharged: the PEN-5017 provenance gate is on `master` in its own right,
carried there by #3123 and #3133 rather than by #3112.

Re-measured at source 2026-10-30T11:1xZ — `master` `584068888` against `pull/3112/head` `7cea4d40b`,
re-taken rather than carried over from PEN-5092's row, which says in terms that `master` moves:

```
AGENT_SCOPE_ONLY_CONFIG_KEYS            heartbeat.ts:2832   present on master
withAgentScopedConfigProvenance         defined :2973, applied :7060
BROKERED_POD_COMPOSITION_CONFIG_KEYS    heartbeat.ts:2911   THREE keys
config-schema.ts:216                    the operator-visible toggle
```

**So reopening buys nothing — and costs something.** A per-file content measurement across all nine
files the branch touches (`git diff --name-only $(git merge-base pr3112 master) pr3112`) finds no
content on the branch that `master` lacks; what the branch has that `master` does not is **older
text that `master` has already superseded**. Three security claims are at stake, each verified at
source here and not taken on the closing comment's word:

| # | file | `pull/3112/head` `7cea4d40b` says | `master` `584068888` says |
|---|---|---|---|
| 1 | `server/src/services/heartbeat.ts` | the agent-scope docker route "is recorded as a residual in §7.5 … **rather than refused here**" | "That residual is no longer open: §7.6 … **REFUSES the combination at render** … (`findPrivilegedContainersBesideBroker`)" |
| 2 | `docs/security/PEN-3183-git-egress-enforcement-boundary-decision.md` | "**Two** things remain open … the **agent-scope docker residual** below" | "**One** route remains open … (The agent-scope docker residual this paragraph used to list beside it is **closed** — §7.6)" |
| 3 | `vendor/paperclip-adapter-claude-k8s/src/server/config-schema.ts` | "a privileged DinD sidecar sits beside the broker in the same pod" | "…the two cannot both be on … the Job **REFUSES TO RENDER** rather than report a boundary that is not there (PEN-3183 §7.6)" |

⚠ **Be precise about how those three could actually regress, because the three are not alike and
the difference decides what a reader must watch.** Measured by running the rebase, not inferred:

- **Claims 1 and 2 are exactly the two conflict hunks** (below). They regress **only if the
  resolution takes the branch side** — which is what the *withdrawn* "resolve as a union"
  instruction, and any reader who defaults to "keep the PR's changes", would do. A conflict is at
  least visible; this is not a silent revert.
- **Claim 3 does not conflict and does NOT regress on a rebase.** Its weaker text sits in the four
  commits the rebase reports `skipped previously applied`, so `config-schema.ts` auto-merges keeping
  `master`'s `REFUSES TO RENDER` wording. It is a real branch-vs-`master` content difference and it
  is **not** reachable through rebase-and-merge. Recorded this way so the next reader does not
  discover the overstatement and discount the other two with it.

The branch is also simply **old**: `ROOT_TOOLCHAIN_SUBPATHS` is `[]` on `master` (stage 3b-iii, the
PEN-3156 pre-push guard having moved into the image) and `[GIT_HOOKS_SUBPATH]` on the branch, and
`job-manifest.ts` is 4538 lines on `master` against 4004 on the branch. That file does not conflict
either, so it is base staleness rather than a merge hazard — but it is why "four of its five commits
are already on `master`" understates how far behind the fifth now sits.

⛔ **Note what this does NOT say.** It does not say #3112 was wrong, or that the PEN-5017 gate was
unnecessary. The gate is on `master` and enforcing; this section is only about the *branch*, which is
now an empty container for it.

⭐ **This section went stale twice, and the second time was catchable — which is the part worth
carrying forward.** §11.1's #3098 row was falsified by its own merge group: at every moment that text
was reviewable it was true. **That exoneration does not apply here.** #3133 landed at `04:26:24Z`;
the PEN-5069 correction that re-asserted the sole-copy claim was enqueued at `06:46:33Z` and merged
at `07:09:09Z` — **2 h 20 m and 2 h 43 m later**. The claim was already false on `master` before it
was enqueued. The defect was procedural, and so is the fix: PEN-5069 pinned three facts as *"must
NOT be changed"* invariants, and they were honoured as instructions but never **re-measured** before
enqueue. **A fact pinned as "do not touch" is still a fact with an expiry.** Re-measure the
invariants at enqueue exactly as rigorously as the edits.

⭐ **And then it happened a third time, to this section, while the correction that said so was in
flight (PEN-5092).** #3112 was closed at `10:23:55Z`; [#3142](https://github.com/Blockcast/paperclip/pull/3142),
whose body re-states the sentence immediately above, merged at `10:51:16Z` — **27 m 21 s later**,
asserting #3112 `OPEN` and `DIRTY`. The invariant was honoured as an instruction and not re-measured
at enqueue, exactly as before. ⛔ **The error direction was worse than the three before it**: those
pointed a reader at a stale *fact*; this one pointed at an *action* — reopen and merge a branch whose
merge-with-the-wrong-resolution reinstates superseded security verdicts (claims 1 and 2 above).

**The honest conclusion is that writing the lesson down is not transferring it.** This is the fourth
instance, and the third was a warning paragraph in this very section. Prose is losing to a race it
cannot win: the gap between enqueue and merge is minutes to hours, and any claim about another PR's
state can be falsified inside it by someone who never reads this file.
[PEN-5091](https://paperclip.blockcast.net/PEN/issues/PEN-5091) — a mechanical check that re-reads
every PR reference in this document at merge time — is the remedy; a fifth prose warning is not. Cite
this paragraph as the fourth data point for it, not as the fix.

⛔ **SUPERSEDED — the rebase guidance below is MOOT and is retained as a record, not as an
instruction. #3112 is closed; there is no rebase to perform and nobody should perform one.** It is
kept rather than deleted for two reasons: it is the measurement that identifies *which* hunks carry
claims 1 and 2 above, and a reader who finds the closed branch and wonders whether to revive it
should be able to see what reviving it would have required. ⚠ If you are reading it as a to-do, stop
— re-read the ⛔ block above.

Superseded text follows. **The rebase was safe, re-measured 2026-10-30T07:5xZ against `master`
`c147daf85` (not carried over from the earlier measurement, which predates #3133 landing):** the four
shared commits come back `skipped previously applied` and the fifth applies — but **two** single-hunk
conflicts remained, one more than this section recorded before #3133. Re-run on `584068888`
2026-10-30T11:1xZ, the shape is unchanged: same two files, same two hunks.

⚠ **Both conflicts are side-picks in the SAME direction: take `master` (HEAD). The earlier
"resolve as a union" instruction is WITHDRAWN** — it was correct against the pre-#3133 `master` and
is now the more dangerous of the two resolutions. Measured hunk by hunk:

- `server/src/services/heartbeat.ts` — **new since #3133**, and **comment-only**. The
  `BROKERED_POD_COMPOSITION_CONFIG_KEYS` set is outside the markers and merges clean with **all
  three keys** on either resolution; only the rationale comment above it conflicts. HEAD carries
  #3123's §7.6 reasoning, which the branch predates. **Take HEAD.**
- `docs/security/PEN-3183-git-egress-enforcement-boundary-decision.md` — the prose hunk. HEAD is now
  a **strict superset**: it already reads *"Five keys are closed"* and already names
  `workspaceVolumeClaim`, so the one thing this section previously said only the branch carried is
  on `master` in its own right. The branch side additionally carries a **superseded verdict** — that
  the agent-scope docker residual *remains open* — which #3123 closed. **Take HEAD.** A union here
  would quietly re-open a closed residual in a security decision record.

**Owner was Security (`7500672d`), as the author of #3112. ⛔ That action item is DISCHARGED and
is not owed by anyone** — the resolution is not needed, because the PR is closed and its content is
on `master`. End of superseded text.

### 11.3 The dates

**Stage 0 — preparation. `2026-11-05`. SET, firm and unconditional.** Unchanged from the proposal and
re-affirmed here. Stage 0 carries **no PR merges**, sets no gate, and does **not** wait on #3098 or
#3112; it can complete with both still open. Its exit is the §7 list — saved §5.3 broker queries, §4
re-read, §3.5a pre-flight, the §3.4 board-level env read, the §5.1 node baseline.

**Stage 1 — one agent, one company. No calendar start date, by design. Earliest start `2026-11-06`.
SET as a conditional start.** A date that fires before its preconditions is not a date, it is an
instruction to skip them. Stage 1 starts on the first working day after **both** of these hold:

1. **§11.1 reads six of six discharged**, each confirmed as content on `master`.
2. **The entry gate in §11.6 passes.**

Duration unchanged: ≥ 3 working days and ≥ 10 runs, exit on all six observations of §7.

**`2026-11-12` — escalation date. SET.** If §11.1 is not six-of-six by end of day 2026-11-12, that is
an escalation to the CTO and **not a silent slip**. To be concrete about what escalation means here,
because "escalate" has been doing too much work: the CTO re-reads §11.2, decides whether #3112 is
still recoverable, and if it is not, files the pin as a new carrier row before anything else. The
open PRs are the live risk in this plan, not the soak.

**Stage 2 — one company, all agents. `stage-1 exit + 1 working day`, ≥ 5 working days. Earliest
`2026-11-11 → 2026-11-18`.**
**Stage 3 — fleet. `stage-2 exit + 1 working day`, held a full week. Earliest `2026-11-19 → 2026-11-26`.**

⚠ **This is a deliberate change from §7's proposal, which gave stages 2 and 3 fixed calendar dates.**
Fixed dates downstream of a conditional start are not a schedule — they silently compress or skip the
stage when the start slips, and the compression lands on the soak, which is the only part of this
plan that produces evidence. The calendar dates are retained as the **earliest case**, i.e. what
happens if stage 1 starts on 2026-11-06 and every exit is met on its first opportunity. They are not
commitments and a slip upstream moves them.

### 11.4 Rollback owner — bound, and the unreachable-Security gap closed

§6's decision owner is **accepted as written: Security (`7500672d`)**, with §6's evidence list (two
agents, named door, the three working-as-designed refusals ruled out, narrowing already tried)
binding as the standard of proof.

PEN-5063 required the owner to be *named*, because otherwise the first bad night makes the call by
default. §6 names one. **What §6 does not say is what happens when that owner is unreachable**, and an
owner who cannot be reached at 3am is operationally the same gap. Closing it:

- On-call may always use the three non-§7.1 levers in §6's table — **narrow the stage, pause the
  agent, restart a Job**. These restore service without re-opening §7.1 and need nobody's permission.
  ⚠ Narrowing is very often the whole remedy (§6 table **row 1**): if it restores service, the gate
  **stays on** for the healthy stages and there is no rollback decision to make.
- Setting the gate `false` for an already-enabled population stays **Security's alone**.
- **If Security is unreachable, it escalates to the CTO (`29033747`) — not to on-call, and not by
  default.** The CTO may make the call on §6's evidence standard and must record it on PEN-3183 §7.1
  as a re-grant with a date, because that is what it is.
- ⛔ **Silence is not authorisation.** An unanswered page does not promote the decision to whoever is
  awake. The escalation path above is the only route, and until it completes the gate stays on and
  the levers above are the response.

### 11.5 The successor residual — review date bound, and it needs a carrier

§8's four residuals and their **2027-01-31** review date are **bound**. PEN-5063 asked specifically
that this not be silently dropped when the §7.1 acceptance ended, because an acceptance that ends can
quietly take its successor with it.

A date in a table is not yet a review. **Before stage 3 exits, the 2027-01-31 review must be given a
carrier row**, owned by Security, referencing §8 and this section. Discharging §7.1 without that
carrier is the failure mode, not the discharge.

⚠ One of the four does **not** wait for 2027-01-31: the `diff.<driver>.textconv` / `core.hooksPath`
row is explicitly *"and on any change to those two files"*, and that trigger is live today. It is
**one** residual row naming **two files** — do not read it as two residuals. The carrier row owns that
watch too.

**The standing blind spot stays the CTO's**, unchanged and not re-granted: no cluster-wide exec
telemetry, trigger 4 has a measurement and not a detector (PEN-4989). D1 does not close it; it makes
it matter less. Recorded here so that discharging §7.1 is not read as closing it.

### 11.6 Stage-1 entry gate — four checks, all mechanical

Run these in order immediately before starting stage 1. Each is a command, not a judgement, and each
has a stated failing value, so "I checked" is falsifiable.

| # | Check | Pass | Measured 2026-10-30 |
|---|---|---|---|
| 1 | `BROKERED_POD_COMPOSITION_CONFIG_KEYS` on `master` | **three** keys incl. `workspaceVolumeClaim` | ✅ **three — PASSES** since [#3133](https://github.com/Blockcast/paperclip/pull/3133) (§11.2) |
| 2 | §11.1 ledger | six of six on `master` | ✅ **six of six — PASSES** as measured 2026-10-30T11:1xZ on `584068888`. ⚠ The sixth is discharged by **content on `master`**, #3112 having been closed unmerged — a check that reads `merged` fails this row wrongly (§11.1, §11.2) |
| 3 | §4 trigger-2 query, re-read over a window overlapping stage 0 | zero broad renders, with the liveness control | ✅ **pass** (§11.7) |
| 4 | §3.5a privilege pre-flight across the stage-1 population | no privileged container beside the broker | ✅ **pass** (§11.7) |

**None of the four fails as measured on 2026-10-30. ⛔ That is NOT a stage-1 go, and this row must
not be read or cited as one.** Three things still stand between this table and a start, and the
first of them is unconditional:

1. **§11.3's date floor governs and is not satisfied.** Stage 0 is `2026-11-05`; stage 1 is earliest
   `2026-11-06`. Four green checks on 2026-10-30 do not move that by a day. The checks are a
   *necessary* condition that §11.3's condition 2 names — never a sufficient one.
2. **Checks 3 and 4 are perishable, and this row is the measurement that proves it.** Both are
   point-in-time reads of a live fleet. Re-run them in order immediately before starting stage 1 and
   again at every widening — **never cite this row for them.** A green recorded on 2026-10-30 says
   nothing about the population on 2026-11-06.
3. **The go/no-go is the plan owners' (PEN-5016 / Security), not a document's.** This section is a
   gate, not an authorisation; recording that the gate passes is not the act of opening it.

⚠ **Check 2 flipped from ⛔ to ✅ by a route worth naming**: not because the outstanding PR merged,
but because it was **closed** and its content was already on `master` (§11.2). A re-run that tests
PR *state* rather than content on `master` will get this row wrong in the direction of a false
failure — which is the safe direction, but it is still wrong, and it will cost whoever re-runs it an
hour. Test content.

⛔ **The failure is wider than that paragraph says, and it is not confined to #3112.** Testing a PR's
*head* ancestry — the natural reading of "ancestor-confirmed" — gets **every** precondition row wrong,
not merely this one, because the merge queue **rebases before landing**: no PR's `headRefOid` is ever
an ancestor of `master`, merged or not. Measured 2026-10-31, all six precondition PRs return
`diverged` from `compare/master...<headRefOid>`, while all five merged ones return `behind` from
`compare/master...<merge_commit_sha>`. Test `merge_commit_sha`, or test content; never the PR head.
§9 carries the measurement and the corrected table.

### 11.7 The §4 pre-flight, actually run (2026-10-30T01:0xZ)

PEN-5063 asked for this to be *run*, not assumed — *"a refusal to build discovered at rollout is a
much worse discovery than a query now"* — and for the **environment** scope as well as the agent
config. Both were attempted. One succeeded, one is refused from every agent seat, and the refusal
turns out not to matter. That last part is the finding.

**(a) Agent config, stage-1 population (Devops `11b9c48f`) — clean.** `adapterConfig` reads `{}`:
no `enableDocker`, no `dockerImage`, no `workspaceVolumeClaim`, no `isolationMode`. The §3.5a
pre-flight is clean for the stage-1 population at agent scope, and so is the §3.5b key.

**(b) Environment scope — NOT readable, and this is now measured rather than asserted.**
`GET /api/environments/{id}` and the company-scoped list both return **`403 Board access required`**
from the CTO seat; `GET /api/environments` is `404`. §3.4 recorded this for the env *credential*
read from a Devops seat. It holds for the env *config* read, and it holds at CTO seat level too — so
this is a property of the API's board boundary, not of which agent asks. **No agent seat can
complete the configuration half of this pre-flight.**

**(c) …and the render-time observation covers what the config read cannot. This is why (b) does not
block.** The §4 warn is emitted from `resolveJobIsolation`, which reads `config.isolationMode` off
the **merged** config (`vendor/paperclip-adapter-claude-k8s/src/server/job-manifest.ts:885`) — after
every scope has been applied. So a broad render caused by an *environment*-scope setting fires
exactly the same warn as an agent-scope one. The
render observation is **scope-agnostic and strictly stronger than a config read**: it observes the
assembled outcome rather than one layer of the input.

Re-run over the 14 days to 2026-10-30T01:0xZ:

| | |
|---|---|
| total broad renders | **1634** |
| first / last | 2026-10-16T01:06:52Z / **2026-10-20T01:47:28Z** |
| reason legs | `isolation_disabled` **1634**, `no_claim` 0, `foreign_claim` 0 |
| distinct agents | **8** |
| renders since 2026-10-20T01:47:28Z | **0** — ≈ 239 h clear |
| **of which, by the stage-1 agent (`11b9c48f`)** | **234 historically, 0 since the cutoff** |

**Liveness control, because silence is byte-identical to clear:** the `container="paperclip"` stream's
newest entry at query time was 2026-10-30T01:01:02Z, seconds old. The zero is *"the warn site was
evaluated and did not fire"*, not *"nobody looked"*.

⭐ **The stage-1 agent is one of the 8 that historically rendered broad** — 234 times, all before the
cutoff. §4 counted 8 distinct agents and did not attribute them; this attributes them, and the
attribution strengthens the result rather than weakening it. Had the stage-1 population been chosen
from agents that *never* rendered broad, a clean reading would have been consistent with "this agent
was never affected". It is not: Devops **was** affected, and stopped when `BLO-47526` landed. The
zero is evidence about the mechanism, not about the sample.

⚠ **Bounds, stated so a later reader does not inherit this as stronger than it is.** This is a 10-day
negative over Loki's retained window, liveness-controlled — it is **not** a configuration proof, and
§4's surviving broad path is untouched by it: a run arriving with no runtime isolation descriptor and
no `isolationMode` still reaches the `SHARED_JOB_ISOLATION` fallback — in
`vendor/paperclip-adapter-claude-k8s/src/server/job-manifest.ts`, the constant declared at **`:762`**
and returned at **`:885-887`**. The zero is a property of the server supplying a descriptor on every
render. A run path that stops supplying one renders broad — and once the gate is on, that is a
hard build failure, not a quiet annotation.
⇒ **Check 3 of §11.6 re-runs this at every widening. It is not cleared once.**

**What remains owed to §3.4, and it is not this section's to close:** the board-level environment and
project-scope read is still a stage-0 exit item with a **board/operator** owner, because no agent seat
can perform it. (a)-(c) discharge PEN-5063's pre-flight requirement; they do not discharge §3.4.
