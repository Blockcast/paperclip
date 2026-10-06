/**
 * Does an operative Ally App review already attest this exact head? (BLO-32198)
 *
 * `scripts/check-ally-review-consistency.mjs` invariant I1 permits at most one
 * operative Ally App review per (PR, head SHA). Until this module existed, the
 * only thing enforcing that was a prose instruction to the agent —
 * `.planning/ally-agent/AGENTS.md` "Step 2 — Idempotency check". That document
 * is not the agent's live instruction source: `scripts/ally-agent-idempotency-
 * contract.test.mjs` says so in its own header ("Ally's live instructions are a
 * managed bundle on the paperclip volume ... these assertions keep the
 * *document* honest — they cannot and do not change agent behaviour"). So the
 * check was advisory, and duplicates kept landing.
 *
 * Measured on 2026-09-05, four open PRs each carried two operative App reviews
 * at one head, with gaps from 53 s (#1304, byte-identical bodies) to 6h35m
 * (#1316).
 *
 * WHAT THIS CLOSES, AND WHAT IT DOES NOT. This is a check-then-act guard at
 * *dispatch* time, but the duplicate is created minutes later at *post* time,
 * so it can only close gaps wider than a review run. It closes the wide ones:
 * a wake that arrives after a review is already visible. (BOTH the "minutes"
 * earlier in this paragraph and this coverage claim are narrowed — see
 * CORRECTION below. The real figure runs to hours — see the five-pair range
 * under QUEUE LATENCY below.) It does NOT close concurrent dispatch at one
 * head — for #1304's 53 s byte-identical pair the second run must already
 * have been running when the first review landed (a review run does not
 * finish inside 53 s), so its dispatch preceded any attestation and this
 * predicate would have answered `not_attested` truthfully. That window is
 * also missed by the delivery-scoped wake idempotency keys, and closing it
 * needs a lock or a post-time check, not this.
 *
 * Stated explicitly because the next I1 red on `master` will otherwise read as
 * a regression here rather than as the known residual it is.
 *
 * CORRECTION (PEN-3754): "it closes the wide ones" OVERSTATES this guard. Each
 * of the three wide pairs measured below was preceded by an explicit re-request
 * at the unchanged head, so a wide gap is not by itself evidence of the failure
 * the coverage claim describes — a wake arriving after a review is visible with
 * nothing but run duration in between.
 *
 * Do NOT read that as "the guard was never consulted, so it cannot have let
 * these through". Which of those happened is OPEN, and it is the most
 * decision-relevant fact here. What is established mechanically:
 *
 *   - The suppression was ALREADY LIVE IN THE TREE before every measured pair.
 *     `master@fce3d292` (2026-09-29T23:53:07Z) calls this module at its
 *     `:5580`, under the "suppresses unconditionally across wake reasons"
 *     comment at its `:5551`. The three second reviews landed
 *     2026-09-30T22:21:15Z, 2026-09-30T22:41:51Z and 2026-10-01T21:50:07Z —
 *     all after it.
 *   - The unconfigured-login fail-open below does not account for it:
 *     `prReviewerBotLogin` defaults to `allyblockcast[bot]` (`config.ts:1277`),
 *     so the "no reviewer bot login is configured" arm was not the one taken.
 *   - A missing head is NOT excluded — but the trigger surface is narrower than
 *     it looks, and unlike the other open explanations this one is readable in
 *     the logs. An `issue_comment` can produce FOUR wake reasons, not two —
 *     the ternary at `github-webhook.ts:1813-1819` yields
 *     `github_pr_review_gate_escalation`, `github_pr_merge_queue_evicted`,
 *     `github_pr_review_requested` or `github_pr_review_feedback` — and only
 *     ONE of them survives `shouldFirePrReviewerWake`, whose whitelist at
 *     `:2767-2774` is {`opened`, `reopened`, `ready_for_review`,
 *     `synchronized`, `review_requested`, `review_submitted`}. The other three
 *     return false at `:5534` and execution never arrives at `:5602`. So the
 *     only comment-driven reason that reaches this gate is
 *     `github_pr_review_requested`, and for it the webhook resolves the head
 *     lazily (`:5262-5303`) BEFORE the
 *     `if (context.headSha && context.repoFullName)` gate at `:5602`.
 *
 *     That lookup is BEST-EFFORT, not guaranteed, so it does not establish that
 *     a head is present. Both failure arms continue without one: a falsy result
 *     warns "could not resolve current PR head for review comment; continuing
 *     without head context" (`:5288`), and a thrown lookup warns "PR-head lookup
 *     failed for review comment; continuing without head context" (`:5301`).
 *     Either leaves `context.headSha` undefined, so the `:5602` gate is skipped
 *     entirely and the wake dispatches UN-GATED — and for a comment-driven wake
 *     there is no other source of a head, as `:5255-5260` says in as many words.
 *     "A head is present whenever this gate is CONSULTED" would be true but
 *     vacuous: the gate's own condition requires a head, so it cannot be
 *     consulted without one. What would be needed to exclude this explanation,
 *     and is not available, is that the gate is always REACHED.
 *
 *     That narrowing moves #2128 out of this bullet entirely. Its only trigger
 *     is `allyblockcast[bot]`-authored and carries no `paperclip:review-request`
 *     marker (live comment, 2026-09-30T16:18:00Z, body opens "## Response to
 *     review at `621589ce`"), so `reviewerRequest` at `:1560-1562` is false and
 *     it classifies as `github_pr_review_feedback` — which never reaches `:5602`.
 *     For that pair the gate was not bypassed for lack of a head; it was not
 *     reached. That is the fourth surviving explanation below, and for #2128 the
 *     tree answers it rather than leaving it open. #2121 and #2157 are
 *     unaffected: both carry explicit `paperclip:review-request` triggers.
 *
 * So on the tree, #2121's and #2157's duplicates reached GitHub past a live
 * guard. The surviving explanations are: it answered `not_attested`; it answered
 * `unknown` for some reason other than the two excluded above; the deploy
 * carrying `fce3d292` had not rolled out when those wakes arrived; those runs
 * were not dispatched through this webhook path at all; or the comment-driven
 * head lookup failed, leaving no `context.headSha`, so `:5602` never ran. NOT
 * RESOLVED HERE — deploy timing and dispatch provenance were not checked, and
 * neither is readable from the review API this measurement used. The fifth is
 * not in that class: it IS readable, from the `could not resolve current PR
 * head` / `PR-head lookup failed` warnings at `:5288`/`:5301`, which are keyed
 * on `deliveryId` and `prNumber`.
 *
 * It is PARTLY answerable from evidence already emitted, but current logging
 * cannot settle the question `:41-43` calls the decision-relevant one. This
 * module returns THREE outcomes (`PrReviewHeadAttestation` below) and the call
 * site logs only two:
 * `attested` logs at `github-webhook.ts:5622` ("...wake skipped: this head is
 * already attested...") and then `return false`s at `:5624` — that is the
 * SUPPRESSING outcome, not a non-suppressing one — while `unknown` warns at
 * `:5636` ("...could not establish whether this head was already reviewed;
 * dispatching the reviewer wake anyway") and falls through. `not_attested`
 * emits NOTHING and falls through to the dispatch at `:5640`.
 *
 * So a hit at `:5622` or `:5636` proves the gate WAS reached, and that is all
 * these logs establish. Absence of both does NOT mean the gate was not reached:
 * it is precisely the signature of the ordinary `not_attested` path, where the
 * gate was reached and answered. Absence leaves `not_attested` (the first
 * surviving explanation above), never-reached (the fourth) and the failed head
 * lookup (the fifth) indistinguishable from one another in THIS module's logs
 * — and `not_attested` is the ORDINARY path by construction: every wake on a
 * head no operative review attests yet answers it, which is the whole steady
 * state of a healthy gate. So reading absence as "not reached" resolves the
 * common case to the wrong answer. Separating the first from the fourth needs a
 * debug log on the `not_attested` arm; it does not exist today. The fifth,
 * though, is already separable without one, and from the caller rather than
 * here: the `:5288`/`:5301` warnings fire on exactly that arm, so a delivery
 * carrying one of them took it. The converse holds only one way: a delivery
 * carrying neither did not take that arm PROVIDED the lookup was entered at
 * all, and its conjuncts at `:5262-5268` also require a numeric
 * `context.prNumber` — which `:1768` derives as `(issue.number as number |
 * undefined) ?? null`. A null there skips the block, logs neither warning, and
 * still reaches `:5602` with no head. GitHub always sends `issue.number` on an
 * `issue_comment` payload, so that is a theoretical residual rather than a
 * live one; it is recorded because this docblock's subject is exactly the line
 * between what is established and what is open. Read these logs for what they
 * can prove before concluding the wake keying is at fault.
 *
 * The coverage claim in the WHAT THIS CLOSES paragraph holds review-run
 * duration (~42 min, measured on #2157: 11:48:35Z request → 12:30:34Z review)
 * as the only thing between dispatch and post, and concludes that a gap of
 * hours implies the first review was already visible at the second dispatch.
 * Three same-head pairs were examined for PEN-3754 (#2121 `9190d265` 19.7 h,
 * #2128 `621589ce` 6.6 h, #2157 `f03ade2f` 9.3 h). In every one the second
 * review was preceded by an EXPLICIT re-request at the unchanged head, posted
 * after the first review was already visible:
 *
 *   #2121  first 03:01:17Z → `paperclip:review-request` (kkroo, HUMAN)
 *                            17:52:18Z
 *                          → second 22:41:51Z
 *   #2128  first 15:44:37Z → "Response to review at `621589ce`"
 *                            (allyblockcast[bot], SELF-WAKE) 16:18:00Z
 *                          → second 22:21:15Z
 *   #2157  first 12:30:34Z → "please re-review exact head `f03ade2f`"
 *                            (kkroo, HUMAN) 17:44:25Z
 *                          → `paperclip:review-request`
 *                            (allyblockcast[bot], SELF-WAKE) 20:50:33Z
 *                          → second 21:50:07Z
 *
 * So these are not the failure the coverage claim describes. They are DELIBERATE
 * re-reviews of a head that already carried a verdict — precisely the traffic
 * this guard must not refuse.
 *
 * THE CALLER DISAGREES, IN WRITING, AND THE DISAGREEMENT IS LIVE. That sentence
 * is normative, and the live path takes the opposite position: the gate at
 * `github-webhook.ts:5602` "suppresses unconditionally across wake reasons"
 * (`:5564-5572`), deliberately INCLUDING the explicit-request reason, on the
 * stated asymmetry that "a duplicate COMMENTED review can never be retracted
 * ... whereas a re-review someone still wants is one commit away". So the
 * shipped behaviour refuses exactly the re-requests this paragraph says must
 * not be refused. Neither position is being changed here, and this PR does not
 * change behaviour at all.
 *
 * Where they actually conflict is narrow, and it is the description-only case
 * at `:225-232` below: when the finding lives in the PR description, no commit
 * can carry the fix, so "one commit away" is false by construction and the
 * caller's asymmetry does not hold for that class. For every other class the
 * caller's reasoning stands. Whoever resolves this should change BOTH comments
 * together — the point of this correction is to stop the next reader taking
 * either side's text as the settled one. Tracked with the exclusion work in
 * BLO-20074.
 *
 * Note the attributions above are NOT equal
 * evidence: #2121's and #2157's first triggers are human requests, which are
 * unambiguously deliberate, while #2128's only trigger and #2157's second are
 * the reviewer re-waking itself — nearer the duplicate-generation mechanism
 * under study than to an external ask. #2128 therefore does not rest on its
 * trigger at all; it holds on the independent description-only ground stated
 * below, where no commit can carry the fix. The legitimate-re-review argument
 * below was first made for #2128 alone; the measurement extends it to all three.
 *
 * All 13 Ally reviews across those PRs parse cleanly under this module's own
 * predicate — one well-formed attestation each, App identity — so the predicate
 * is sound and this is not a detection failure.
 *
 * QUEUE LATENCY is real here but is NOT what produced these pairs, and the
 * distinction matters because the two point at different fixes. The quantity
 * actually measured is request→review, over the FIVE pairs this docblock
 * enumerates: the four in the table above, plus the 11:48:35Z→12:30:34Z
 * first-review pair cited as "~42 min". Across those five it spans 0.7–6.1 h
 * (0.700, 0.993, 4.095, 4.826, 6.054).
 *
 * Read that as a statement about THOSE FIVE PAIRS, never as a universal over
 * the three PRs — the PRs carry faster pairs that are not in this population.
 * #2128 alone has 06:58:11Z→07:19:12Z (0.350 h) and 10:18:56Z→10:52:03Z
 * (0.552 h), and taking the `synchronize` push as the trigger instead of the
 * comment does not lift them (`e0336557` committed 06:57:05Z → 0.369 h;
 * `a8a417ac` 10:18:24Z → 0.561 h). Those are below the floor and change
 * nothing: the window a wake-time exclusion has to hold across is governed by
 * the MAXIMUM, which over these five is 6.054 h exactly. Read it as a LOWER
 * BOUND — at least 6.054 h — because a wider population can only raise a
 * maximum, never lower it. Hours, not minutes; and a lower floor cannot weaken
 * a bound on how long a remedy must survive. It needs no decomposition to say
 * so.
 *
 * Do NOT read the ~42 min above as an independent measurement of run duration
 * and subtract it: it is one of those five request→review pairs, and the
 * fastest of the five. Nothing visible in the review API separates time spent
 * queued from time spent running, so that split is unmeasured here. Queue
 * latency still does not account for these three, because in each the first
 * review predated the re-request and so predated the wake. Treat it as a
 * constraint on the remedy, not as the diagnosis.
 *
 * Do NOT conclude from that measurement that a post-time refusal is the
 * remedy. It is not, and the reason generalises: a same-head re-review can be
 * LEGITIMATE. When a finding lives in the PR description rather than the code,
 * no commit can carry the fix and the head necessarily stays put — #2128's
 * second review is exactly that case, preceded by "Description-only — no
 * commit, head stays `621589ce`". Refusing it would strand the finding
 * permanently, because the one remedy a refusal can suggest (move the head) is
 * unavailable by construction. BLO-25764 measured the gap distribution across
 * every same-head App pair (n=15, 3 s → 120971 s, continuous) and found no
 * threshold separating race from re-review, which is why review data alone
 * cannot classify these and why I1 is being re-specified to treat a
 * distinct-body pair as supersession rather than as a violation.
 *
 * Exclusion therefore belongs at the queued→running claim (BLO-20074,
 * `pr-review-dispatch-lock.ts`), which observes strictly later than this
 * module does. How much later is exactly the unmeasured split above, so
 * BLO-20074 has to measure start→post for itself rather than inherit the
 * five-pair 0.7–6.1 h figure, which measures wake→post. A vocabulary warning,
 * because this docblock uses both words: "dispatch time" in the WHAT THIS
 * CLOSES paragraph and "wake time" here are the SAME instant for this module.
 * It is called from the webhook handler at the moment the wake is decided
 * (`github-webhook.ts:5603`, and on the contended-replay path at `:4036`), so
 * it has exactly one point of observation, not two to check between. What that
 * check decides is whether a run STARTS; the duplicate is created hours later
 * when that run POSTS, and nothing re-asks in between. That is the gap — one
 * observation against a multi-hour lifetime — not a wake-versus-dispatch
 * distinction.
 *
 * Why this must be enforced BEFORE the run rather than cleaned up after: a
 * COMMENTED review cannot be retracted. GitHub's dismiss endpoint rejects it
 * (`PUT .../reviews/{id}/dismissals` → 422 "Can not dismiss a commented pull
 * request review") and there is no delete-review API at all. Once a second
 * review is posted the violation is permanent until the head moves or the PR
 * closes, so prevention is the only available remedy.
 *
 * Attestation is read from the review BODY, never from `commit_id`. GitHub
 * rewrites `commit_id` when a branch is updated, so a review that examined an
 * older tree can silently start reporting the current head — which would make
 * this predicate suppress review of a head nobody read. The body's
 * `Reviewed head: <40-hex>` line is immutable and is what the reviewer emits
 * for exactly this purpose.
 */
import {
  githubListPrReviewsWithTimestamps,
  githubReviewerIdentityMatches,
} from "./github-app-auth.js";
import { extractAllyReviewedHeadSha } from "./ally-review-detection.js";

/**
 * `unknown` is a distinct outcome, not a flavour of `false`.
 *
 * The caller suppresses work on `attested`, and the fail-open direction is
 * load-bearing: a duplicate review is permanent (see above) but merely
 * redundant, whereas a suppressed wake on a head nobody reviewed means a PR is
 * never reviewed at all and nothing retries it. So an unreachable or
 * unparseable GitHub response must let the wake through, and the caller must
 * not be able to reach that decision by reading a bare boolean.
 */
export type PrReviewHeadAttestation =
  | { outcome: "attested"; attestingReviewCount: number }
  | { outcome: "not_attested" }
  | { outcome: "unknown"; reason: string };

export type ListPrReviewsForAttestation = typeof githubListPrReviewsWithTimestamps;

/**
 * Count operative Ally App reviews whose body attests `headSha`.
 *
 * Identity is matched with `githubReviewerIdentityMatches`, which accepts only
 * the App's `<slug>[bot]` / `app/<slug>` forms. That deliberately excludes the
 * bare `allyblockcast` User seat: it is a second hat on the same agent rather
 * than an independent reviewer, and the consistency guard scores the two lanes
 * separately, so a User-seat review must not suppress the App lane's work.
 *
 * `githubListPrReviewsWithTimestamps` already drops PENDING and DISMISSED,
 * which is the same definition of "operative" the guard uses.
 */
export async function allyReviewAlreadyAttestsHead(input: {
  repoFullName: string;
  prNumber: number;
  headSha: string;
  botLogin?: string | null;
  listPrReviews?: ListPrReviewsForAttestation;
}): Promise<PrReviewHeadAttestation> {
  const headSha = input.headSha.trim().toLowerCase();
  // Anything short of a full commit id cannot be compared to an attestation
  // without guessing, and guessing here suppresses a real review.
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    return { outcome: "unknown", reason: "head sha is absent or not a full commit id" };
  }

  // No hardcoded default identity. `isReviewerSelfEchoReview` — the other
  // suppression path in the webhook — is simply inert when
  // `prReviewerBotLogin` is unconfigured, and the two must agree about what
  // "unconfigured" means. Defaulting here would let this path suppress on a
  // deployment-specific login the rest of the system was not configured to
  // recognise, which is suppression on a guess.
  const botLogin = (input.botLogin ?? "").trim();
  if (!botLogin) {
    return { outcome: "unknown", reason: "no reviewer bot login is configured" };
  }
  const list = input.listPrReviews ?? githubListPrReviewsWithTimestamps;

  let reviews: Awaited<ReturnType<ListPrReviewsForAttestation>>;
  try {
    reviews = await list({ repoFullName: input.repoFullName, prNumber: input.prNumber });
  } catch (err) {
    return {
      outcome: "unknown",
      reason: `listing PR reviews threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // The helper returns null for an unauthenticated client, a non-OK response,
  // or pagination past its hard limit — none of which are evidence that no
  // review exists.
  if (reviews === null) return { outcome: "unknown", reason: "could not list PR reviews" };

  let attestingReviewCount = 0;
  for (const review of reviews) {
    if (!githubReviewerIdentityMatches(review.login ?? "", botLogin)) continue;
    if (extractAllyReviewedHeadSha(review.body) !== headSha) continue;
    attestingReviewCount += 1;
  }

  return attestingReviewCount > 0
    ? { outcome: "attested", attestingReviewCount }
    : { outcome: "not_attested" };
}
