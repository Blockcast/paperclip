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
 * a wake that arrives after a review is already visible. It does NOT close
 * concurrent dispatch at one head — for #1304's 53 s byte-identical pair the
 * second run must already have been running when the first review landed (a
 * review run does not finish inside 53 s), so its dispatch preceded any
 * attestation and this predicate would have answered `not_attested` truthfully.
 * That window is also missed by the delivery-scoped wake idempotency keys, and
 * closing it needs a lock or a post-time check, not this.
 *
 * Stated explicitly because the next I1 red on `master` will otherwise read as
 * a regression here rather than as the known residual it is.
 *
 * CORRECTION (PEN-3754): "it closes the wide ones" OVERSTATES this guard, and
 * a wide gap is NOT evidence that it was consulted and answered wrongly.
 *
 * The paragraph above holds review-run duration (~45 min, measured on #2157:
 * 11:48:35Z request → 12:30:34Z review) as the only thing between dispatch and
 * post, and concludes that a gap of hours implies the first review was already
 * visible at the second dispatch. QUEUE LATENCY breaks that step. A wake can
 * clear this gate while no review exists, sit queued for hours, and post into a
 * head that was attested in the meantime — so a long gap and a short gap can
 * have the same cause, differing only in how long the second run waited.
 *
 * Measured on the three same-head pairs in PEN-3754 (#2121 `9190d265` 19.7 h,
 * #2128 `621589ce` 6.6 h, #2157 `f03ade2f` 9.3 h): all 13 Ally reviews across
 * those PRs parse cleanly under this module's own predicate — one well-formed
 * attestation each, App identity — so every first review WOULD have returned
 * `attested` had this been asked at post time. The predicate is sound; the
 * timing assumption in its coverage claim is not.
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
 * Exclusion therefore belongs at dispatch (BLO-20074), where the queueing
 * above is the specific thing it has to survive: a check at wake time is not
 * enough on its own, because the decision it makes can be hours stale by the
 * time the run it authorises actually posts.
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
