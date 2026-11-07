<!--
  Repo-local copy of the company shared doc `docs/pr-conventions.md`.

  Paperclip materializes company shared docs into an agent's workspace, but it
  only fills ABSENCES: both the server-side materializer
  (`ensureReferencedSharedDocsMaterialized`) and the run-isolated pod overlay
  (`buildSharedDocOverlayShell`) skip any path that already exists, so this
  tracked file is what every agent working in this repository reads.

  It exists because the company copy's PR body template names four headings
  (`## What changed` / `## Why` / `## How to test` / `## Related`) that
  `.github/scripts/check-pr-template.mjs` does not accept — the two sets do not
  intersect, so a body written from that template fails all five section checks
  and red-lights the `review` gate. Only the `## PR Body Template` section below
  differs from the company copy; everything else is carried verbatim.

  Because this file shadows the company copy for this repository, company-level
  edits to `pr-conventions.md` do NOT reach agents here. Mirror them into this
  file when they land.
-->

# PR Conventions

## Branch Naming

```
<prefix>-<N>/<short-description>
```

Where `<prefix>` is the company issue prefix (lowercase) and `<N>` is the issue number.

Examples: `yes-6/add-auth-endpoint`, `yes-12/fix-game-loop`

## PR Title

Use Conventional Commits format:

```
<type>: <short description>
```

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`

Rules: lowercase after colon, no period, under 72 chars.

## PR Body Template

Use the five `##` sections below **exactly as spelled**. They are enforced by
`.github/scripts/check-pr-template.mjs`, which matches each heading with a
case-sensitive `indexOf` on the literal string — `## What changed` does not
satisfy `## What Changed`. A body missing any of them fails the `review` gate,
and unlike `check-pr-linked-issue` and `check-pr-dedup-search` this checker has
no skip list, so it fires on every PR regardless of the title prefix.

`.github/PULL_REQUEST_TEMPLATE.md` is the authoritative long form. GitHub only
pre-fills it in the web UI, so a PR opened with `gh pr create --body-file` never
sees it — that is why the template is restated here.

````markdown
## Thinking Path

> - Paperclip is the open source app people use to manage AI agents for work
> - [Which subsystem or capability is involved]
> - [What problem or gap exists]
> - [Why it needs to be addressed]
> - This pull request ...
> - The benefit is ...

## Linked Issues or Issue Description

Refs: [PREFIX-N](https://paperclip.blockcast.net/PREFIX/issues/PREFIX-N)

## What Changed

- [One bullet per logical unit of change]

## Verification

- [Test commands run, manual steps taken, or both — and their result]

## Risks

- [What could go wrong: migration safety, breaking changes, behavioural
  shifts — or "Low risk" with the reason]

## Model Used

- [Provider and model name, exact model id, and reasoning mode — e.g.
  "Claude Opus 4.6 (claude-opus-4-6), extended thinking". Write
  "None — human-authored" if no model was involved.]

## Checklist

- [ ] I searched the GitHub PR list for similar PRs and confirmed this is not a duplicate
- [ ] I have run tests locally and they pass
- [ ] I have considered and documented any risks above
````

Three gates read the body, and each keys on something specific:

| gate | what it reads | skips `docs\|chore\|build\|ci\|style\|test\|revert` prefixes |
|---|---|---|
| `check-pr-template` | the five `##` headings above | **no** |
| `check-pr-linked-issue` | `Fixes:`/`Closes`/`Refs` + `#N` or `PREFIX-N`, or a `paperclip.blockcast.net` issue URL | yes |
| `check-pr-dedup-search` | a `- [x]` checkbox line reading `searched … similar … PRs` | yes |

Notes on the three sections that fail most often:

- **`## Thinking Path`** needs **3 or more** items. The counter splits on terminal
  punctuation, on bullet/blockquote line starts (`-`, `*`, `>`), and on blank
  lines, so a blockquote bullet list counts per bullet.
- **`## Model Used`** is rejected if it still contains `provider, model id`,
  `your model`, or `<model>`. Name the real model.
- **The dedup checkbox** must be `[x]`, not `[ ]`, and its label must mention
  searching, then `similar`/`duplicate`/`prior`, then `PRs`, in that order.

## Labels

Apply one primary label: `feature`, `bug`, `docs`, `chore`, `infra`, `agent`.

## Review Workflow

Two-role review via @-mention on the originating issue:

1. **Engineer** opens PR on GitHub
2. **Engineer** sets originating issue to `in_review`
3. **Engineer** @-mentions @Code Reviewer and @Product Owner on the issue with PR link
4. **Code Reviewer** reviews for correctness, security, code style, simplicity
5. **Product Owner** reviews for intent match, scope discipline, acceptance criteria, roadmap alignment
6. Both reviewers post their verdict on the issue
7. **Engineer** merges when both approve, sets issue to `done`

## Review Roles

- **Code Reviewer**: Correctness, security, style, simplicity. Uses `gh pr review`.
- **Product Owner**: Intent alignment, scope discipline, acceptance criteria. Posts review as PR comment.
- **UI Designer** *(when present)*: Visual consistency, brand compliance, accessibility, design token usage.
- **UX Researcher** *(when present)*: Usability, user flow integrity, cognitive load, error handling UX.
- **QA Engineer** *(when present)*: Test coverage, edge cases, regression risk, boundary conditions.
- **DevOps Engineer** *(when present)*: Infrastructure impact, security, performance, rollback safety.

## Merge Rules

- Code Reviewer and Product Owner must approve (required)
- Other reviewers provide advisory feedback — blocking only for their domain-critical issues (e.g., security for DevOps, accessibility for UI Designer)
- CI must pass
- No force pushes
- Merge using `gh pr merge <number> --merge`
- Engineer is the merge owner — reviewers never merge

## Escalating a merge or an approval on a PR

> ## ⛔⛔ THE "NEVER FILE A BOARD CARD" CLAUSE BELOW IS RETRACTED
>
> **Retracted 2026-09-13T15:0xZ by the CEO who ruled it. Do NOT apply it.**
>
> The retracted clause read: *"should not exist at all … Request review on the PR instead;
> withdraw the card."* It rested on the claim that the founder services GitHub's review queue
> and not the card queue.
>
> **Measured counter-example, 2026-09-13.** Card `3bb6d3fb` asked for a review-approve on
> `onprem-k8s#3443` — a PR that had sat **7h06m** with its reviewer team requested and **zero**
> human reviews. The card was approved at 14:35:25Z; the human review landed **26 seconds
> later**. The GitHub-native channel did not service it in seven hours. The premise is false.
>
> **⛔ NO replacement rule is in force.** A narrower one is PROPOSED and UNRATIFIED on PEN-3167
> (comment `5bbc27c3`) — do not cite it as authority.
>
> **Until something is ratified: use judgement, and put your evidence in the card** — PR age,
> whether reviewers are already requested, why polling cannot move the gate. Do **not** withdraw
> a card merely for being of this class, and do **not** suppress a correct ask on the strength of
> the retracted text below.
>
> **What is void, precisely.** Void: the prohibition itself — *"do not file a board approval card
> whose entire ask is merge/approve this PR"* — and its justification, i.e. both `### ⚠️ RETRACTED`
> blocks below. The "Board cards are reserved for…" list inside the first one still reads true as a
> description of what cards are *good for*; it is no longer an exhaustive whitelist, and a
> merge/approve ask is not excluded by it.
>
> Still standing, never part of the retraction: *"The discriminator is the card's ASK, not the PR's
> state"*, *"A merge-press card also carries a freshness claim it cannot keep"* (still the reason to
> re-read a PR before asking a human to act on it), *"Before you ask a human for anything on a PR,
> read the gate"*, and every section from *"You own retirement of your own cards"* onward.
>
> *(Delivery note: this document was unreadable by every agent until 2026-09-13 — it materialized
> as a "Missing Shared Documentation" placeholder. See PEN-3172. So this retraction is being
> published at the same moment the clause it retracts first became legible.)*

### ⚠️ RETRACTED — history only, do not apply

**Superseded. Was: "Standing policy. CEO decision, 2026-09-11, recorded on PEN-3167. Applies to
every agent."**

**Do not file a board approval card whose entire ask is "merge this PR" or "approve this
PR."** Request review from the founder on the pull request itself. That is the queue they
actually work.

**Board cards are reserved for asks GitHub cannot express:**

- operator execution (`kubectl apply`, `argocd app sync`, a one-off `psql`)
- credential or account provisioning
- policy and design decisions
- anything needing a cluster-admin or billing-console boundary

### ⚠️ RETRACTED — why the void rule was believed (history only)

Five pending cards named a PR the founder had **already merged**. Four of the five merged
inside a 41-minute window on 2026-09-09: they sat down, worked through GitHub, and never
came back to the cards. Three of those PRs carried a GitHub review request. **The GitHub
request is the channel that got serviced; the card is the one that did not.**

A merge-press card is a second, weaker copy of an ask GitHub already expresses natively —
and unlike the GitHub request, **it does not retire when satisfied**. So each one adds depth
to a queue that is ~29 deep on one human, is satisfiable *without being decided*, and then
rots into a stale instruction a later reader can act on wrongly.

### ⛔ The discriminator is the card's ASK, not the PR's state

A card naming a merged PR is **not** automatically stale. If its ask is a post-merge operator
action — a merge does not perform a `kubectl apply` — the card is still live and must not be
withdrawn. Read what the card asks for, not what happened to its PR.

### A merge-press card also carries a freshness claim it cannot keep

This is the failure mode that makes the rule stronger than "it's a duplicate". A merge-press
card argues its case with a snapshot — *"mergeable_state: clean, 0 Critical, nothing blocks
merge"* — but the PR keeps moving. Reviews land, branches conflict, gates flip.

Measured on 2026-09-11: **both** remaining merge-press cards were asking for a press that
**could not have succeeded**. One named a PR whose gate had since gone
`failure :: Ally review flagged blocking findings`; the other's branch had gone `dirty`. One
card's own text still asserted `pending :: Waiting for Ally review` — a state that was no
longer true. So the card was not merely a duplicate ask; it was a **wrong** one, aimed at a
human who would have found nothing to press.

### Before you ask a human for anything on a PR, read the gate

Branch on the *description* of `review/ally-complete` at the head, not on its state alone:

| gate description says | who owes the next action |
|---|---|
| `failure :: … blocking findings` | **You.** Push the correction to the branch. |
| `pending :: … requested changes …; a human approval cannot clear it` | **You.** Push the correction. |
| `pending :: … not authoritative; needs an approving review` | A human. Freeze the head, request review. |
| `pending :: Waiting for Ally review` | Nobody yet — nothing has reviewed the head. |

And check `mergeable` first: asking a human to approve a branch that does not merge is queue
noise. Resolve conflicts, *then* request review.

### You own retirement of your own cards

**CEO ruling, 2026-09-11, PEN-3167. Four parts, all standing policy.**

A card is satisfiable without being decided, so it will never retire itself. A comment on a
card reaches nobody — a pending approval emits nothing, and no heartbeat enumerates its own
cards.

**(a) The requester owns retirement.** If you filed it, you retire it. Nobody else can:
`withdraw` is requester-scoped, and the only other disposal path is spending the founder's
click to decide an ask that is already satisfied.

**(b) Every card names a retirement condition that its requester can observe.**

> One line, in the card, stating the observable that makes it moot. If you cannot observe it
> yourself, name the agent who can, and retire on their reported observation — you still own
> the `withdraw`, they own the sighting. If *no* agent can observe it, say so on the card: an
> ask whose completion this company cannot detect is worth flagging at filing time, not
> discovering months later.

"Observable by the requester" is the load-bearing half, and it is not decoration. An execution
card asks for an action behind a boundary the agent cannot cross — and **the same boundary that
makes the card necessary usually makes its completion unobservable**. So this rule is weakest
exactly on operator cards, which are the ones we keep.

**Prefer restructuring the ask over delegating the sighting.** Naming another agent works, but
it reintroduces the delivery problem — you now need *them* to report, through a channel that
reaches you. The stronger move is to **make the ask itself produce a durable artifact you can
already read**: "paste the three pod logs on PEN-3080", "paste `kubectl get clusterpolicy -o
yaml` on the row". Then the card is self-observing, and retirement costs one row read by
someone who is already awake.

**(c) The heartbeat sweep is a check against the stated condition, not a re-audit.** Full
re-verification of every card every heartbeat is **not** required and is not being asked for.
You check the named observable you wrote. One call enumerates yours:

```
paperclipListApprovals(requestedByAgentId: "<your agent id>", status: "pending", view: "summary")
```

Use `view: "summary"`; `view: "full"` on a busy queue returns hundreds of KB. `withdraw`
requires a non-empty `reason` — name the merge or the event that satisfied it.

**(d) The discriminator is the card's ASK, never the world's state** — unchanged, see above.

### ⛔ State the condition precisely, or you will retire a live card

Not a hypothetical. Card `3bb4b04e` asks to restart **and relocate** `paperclip-pg-0` off
`k8s-paperclip-7`, raising its memory request 4Gi→7Gi. The pod **was recreated on 2026-09-07**,
a day after the card was filed. A condition written loosely as *"retire when pg-0 restarts"*
would have been satisfied — and withdrawing on it would have silently dropped the relocation
and the memory change, which are the entire point. The pod came back **on pp-7, still at 4Gi**.

Write the condition as the *end state you actually want*, in fields you can read:
`nodeName != k8s-paperclip-7` **and** `requests.memory == 7Gi`. Both were checked in one call
on 2026-09-11; both still say no; the card correctly stays live.

### Age is the wrong instrument

Do not sweep on "older than N days". Age does not cause rot — a world-event does, so an age
trigger fires late on fast rot and never on slow rot. Card `58b71f9c`'s premise was falsified
**96 minutes** after it was filed, and it then sat for 8 days. No age threshold catches that; a
named retirement condition catches it on the next sweep.

### File only what you could retract

If only the requester can retire a card, a card that outlives its author is **unretirable** —
it can then be cleared only by spending exactly the click it was filed to request, on an ask
that is already satisfied. So: **file a board card only for an ask that will still be
meaningful if you are not alive to retract it.** A card you could not withdraw is a card you
should not have filed.

### Verify your capability with a positive control before claiming you cannot observe

"I can't see it" is an easy thing to get wrong, and it converts a live card into a permanent
one. On 2026-09-11 `kubectl auth can-i get configmaps` returned **no** from an agent shell for
a ConfigMap that the `k8s-ro` MCP server had read seconds earlier — different seats, and the
local `kubectl` answer was not evidence about the capability that mattered. Likewise an empty
`resources_list` means "absent" only if the same query shape returns a known-present object.
Pair every negative with a positive control in the same breath, then record the verdict.

## Writing a claim that survives being read out of context

**Three rules.** They are deliberately **not** *"state the scope of every claim"* — applied to
every claim in every PR that is unachievable, so it gets ignored, and an ignored convention is
worse than none because it still carries the appearance of a guard.

All three come from one incident. [PEN-5760](https://paperclip.blockcast.net/PEN/issues/PEN-5760)
/ [#3454](https://github.com/Blockcast/paperclip/pull/3454) produced three instances of the same
error class in one document, **each one produced while fixing the previous one**, and three
readers passed over the third. The diagnosis: *a document that says "name your scope" is unusually
good at hiding an unscoped sentence, because every reader is checking the claims and not the
quantifiers.*

### 1. Scope a claim at the SENTENCE — on surfaces read out of context

Two surfaces where this applies, and they fail **differently**; one where it does not. Flattening
(a) and (b) together is itself an instance of the error class.

**(a) Fully out of context — the sentence must stand alone.**

Rule 1(a) applies to: tool and schema field descriptions, error strings, monitor notes, and
convention text that gets quoted piecemeal — including this file. The reader receives one
paragraph and *none* of its neighbours, in either direction, so the sentence cannot inherit
scope from the page it sits on. The author structurally cannot perceive this, because the author
is looking at the page where the scope is visibly established two paragraphs up.

> **The check for 1(a) is mechanical: lift the sentence out alone — is it still true?**

⚠️ The 1(a) check is strictly stronger than *"render it and read it as a stranger"*, which is
the prescription that failed on PEN-5760. A stranger reads **in order** and therefore *infers*
scope from the neighbours: on PEN-5760 the unscoped rule sat between two buckets that *did* name
their scope, so its silence read as deliberate. The defect is visible only when read out of order,
one sentence at a time, which is how the real reader receives it.

**(b) Truncated — the tail is destroyed and the head survives.**

Rule 1(b) applies to: issue descriptions longer than 1200 code points, as served by
`paperclipListIssues` and `paperclip_search_issues`. This is the weaker, **directional** form of
(a) — text before the claim does travel with it, and only text after the cut is lost. Run three
checks, **in this order**:

1. **Does the rendered first 1200 code points read as FINISHED?** If it ends mid-word or
   mid-structure, the reader sees a fragment and opens the row — the defect is mild, so stop here.
   ⭐ The operative property is whether what survives reads as complete, not how much was cut.
   PEN-5792's own description loses all three of these rules and is nearly harmless, because its
   prefix stops mid-word and the reader opens the row. PEN-5760 lost **one table row** — its
   single disconfirming case, which began fourteen code points past the cut — and that was
   catastrophic, because its prefix read as finished. A visible fragment is self-correcting; a
   coherent remainder is not.
2. **If it reads as finished: is what survives true, and still as uncertain as it should be?** Put
   the **disconfirming case first** — not merely the qualifier before the claim. A qualifier is a
   sentence and sentences get cut too: a draft of PEN-5760's own repair put the qualifier first,
   was cut *inside* it, and the half that survived was the confirming half alone.
3. **Any count in the surviving part must be accurate.** ⭐ Prefer this one. It is the cheapest of
   the three, and the only one that works at *reading* time rather than at authoring time — the
   other two need an author who remembers to run them. PEN-5760's measurement heading read *"four
   responses"* above a **five**-row table; the cut left exactly four. So the prefix was not merely
   truncated, it was **self-corroborating**: a heading promising four, followed by four, in a
   table, agreeing. Every consistency check a careful reader runs on that prefix passed, and
   nothing was available to notice. Had the heading said *five*, the prefix would have announced
   its own loss to every future reader, for free, without the author having to predict where the
   cut would land.

**Scope of (b), stated so it survives being lifted out of this file:** the 1200-code-point cut was
measured on `paperclipListIssues` row projections over one company's corpus on 2026-11-06 — 864 of
1000 rows truncated, at exactly 1200 code points, with no other prefix length observed.
`paperclipGetIssue` returns the full column and is unaffected. `paperclip_search_issues` was **not
probed**; it is documented as sharing the cap, and that is carried here on documentation rather
than on measurement. Every list row carries a `descriptionTruncated` flag — prefer reading it over
measuring the string.

**(c) Rule 1 does NOT apply to:** PR bodies and code comments. There the surrounding text
genuinely does travel with the claim — a PR body is rendered whole, and for a comment the code
*is* the scope.

### 2. Pin the failure mode, not the content

A test that pins prose should pin **the token that this document's *observed* failure mode
destroys** — not the token that seems important.

- Observed three times on PEN-5760: an editor narrows or widens a claim and the **quantifier** goes
  with it, silently. ⇒ pin the quantifier.
- Never observed there: an editor deleting a field name from an omission list. ⇒ pinning that list
  buys nothing and goes stale.

**The binding constraint is the useful half: in a prose pin, you may only pin what you have
watched fail.** That is what stops a test accreting important-looking assertions — which is
exactly how `c10a6df5`'s test came to defend a *false* sentence. It pinned that sentence because
the sentence mattered, not because anything had ever broken it, and the pin would then have
nudged the next correct editor into reverting the fix.

⚠️ Rule 2 is not *"always pin the scope"*. It is *pin what you have watched break*.

### 3. A test assertion that pins prose ships with a demonstrated failing revert

**Scope: this governs an assertion once you have decided to write one. Rule 2 decides whether to
pin at all.** It does not require that any given prose be pinned — and this section is its own
example: nothing has been observed deleting these three rules, so by rule 2 no test pins them.

When you do pin prose: revert the text, watch **that exact assertion** fail, restore. A prose
assertion nobody has seen fail is not a guard, and PEN-5760 has a measured instance of one that
was actively harmful.

⚠️ Rule 3 cannot reach a claim that lives in a database prose field — an issue description has no
test to revert. Rule 1(b)(3)'s accurate count is the nearest thing to a guard available in a
database prose field, which is part of why it is rated above the other two checks in 1(b).

## Dev Cycle Rules

**Requires PR**: code logic, APIs, DB schema, agent configs, infrastructure
**Direct-to-main OK**: typos, comment-only changes, minor doc fixes (must reference issue)
