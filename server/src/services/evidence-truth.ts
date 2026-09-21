/**
 * GitHub truth probe for the evidence gate (BLO-32239; eng review 2026-09-06:
 * D5, D6, D11, D12).
 *
 *   workProducts ─► prRefsFromWorkProducts ─► ≤5 PrRef (webhook rows trusted for `merged`)
 *        │                                      │
 *        │        per PR, concurrently, under one deadline:
 *        │          deploy:landed     = webhookMerged || getPullRequestGate().merged
 *        │          review:ally-clean = head := fetchHeadSha()          <- CURRENT head
 *        │                              surfaces := listReviewerSurfaces()
 *        │                              clean if either surface attests THAT head
 *        │                              by someone who is NOT the PR author,
 *        │                              clean and NEITHER surface blocks it
 *        ▼
 *   {detections, diagnostics, probeFailed}
 *
 * Two invariants carry the whole design:
 *
 * 1. DB-first (D11/D5). A pull request exists here only because Paperclip
 *    linked it — the webhook's `pull_request` work product, or a row an
 *    operator attached. A PR URL pasted into a comment is never a PR to this
 *    module, because that is precisely the string an agent can fabricate, and
 *    fabrication is what these two shapes exist to defeat. `merged` is trusted
 *    only from a webhook-stamped row; every other row is a reference whose
 *    facts GitHub must confirm.
 *
 * 2. `probeFailed` is not `!detected`. "GitHub says nobody reviewed this head"
 *    and "we could not ask GitHub" produce the same empty detections, and only
 *    the first is a fact about the work. The caller blocks on the first and
 *    never on the second — otherwise a GitHub outage becomes an estate-wide
 *    in_review freeze.
 *
 * The review verdict is judged by `evaluateCommentReviewGate`, the same
 * function the merge gate publishes from. Two parsers for one grammar is how
 * a PR ends up merge-gate-clean and evidence-gate-dirty at the same instant.
 */
import type { EvidenceShape } from "./evidence-shapes.js";
import { evaluateCommentReviewGate } from "./pr-comment-review-gate.js";
import { extractAllyReviewedHeadSha, hasActionablePrReviewFeedback } from "./ally-review-detection.js";
import { PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST_ACTOR_ID } from "./pull-request-work-products.js";
import { githubSameActorLogin, type ReviewerSurfaces } from "./github-app-auth.js";

export interface TruthWorkProduct {
  type: string;
  metadata: Record<string, unknown> | null;
  sourceTrust: { promotedByActorId?: string | null } | null;
}

export interface TruthProbeInput {
  workProducts: TruthWorkProduct[];
}

export interface TruthProbeResult {
  detections: Partial<Record<EvidenceShape, boolean>>;
  diagnostics: string[];
  /** True when truth could not be established. NEVER means "not detected". */
  probeFailed: boolean;
  /**
   * True when the issue has no linked pull request at all. A THIRD state,
   * distinct from `probeFailed`: the probe worked perfectly and the honest
   * answer is "there is nothing to review".
   *
   * Kept off `probeFailed` deliberately. That field is how the rollout runbook
   * separates a GitHub outage from a real evidence gap; folding PR-less issues
   * into it makes the seven-day measurement unreadable in both directions, and
   * writes `suppressed:probe-failed` into an operator-visible verdict on an
   * issue where nothing failed.
   */
  noLinkedPullRequest: boolean;
}

export type TruthProbe = (input: TruthProbeInput) => Promise<TruthProbeResult>;

/**
 * One linked pull request.
 *
 * Deliberately carries no head SHA. The webhook's `headSha` is a snapshot from
 * whenever that event fired, and judging a review against it is the exact
 * defect BLO-19118 / BLO-21489 are about: a review that was clean at an older
 * head says nothing about the code that would ship now. The head is always
 * re-fetched.
 */
export interface PrRef {
  repoFullName: string;
  prNumber: number;
  webhookMerged: boolean;
}

/** Read at most this many linked PRs. Beyond it the probe fails rather than answering from a subset. */
export const MAX_LINKED_PRS = 5;
/** Whole-probe budget. The gate runs inside a PATCH; a slow GitHub must not hold the request open. */
export const PROBE_DEADLINE_MS = 8000;
/**
 * Per-call budget, so one wedged socket cannot consume the whole probe deadline.
 * Sized to leave HEADROOM under `PROBE_DEADLINE_MS`, not to tie it: the pinned
 * chain models less than the real one, because `AbortSignal.timeout(perCallMs)`
 * covers the `fetch` but not the `await getInstallationToken()` that precedes it
 * in each dep (`github-app-auth.ts`). That is a cached no-op on a warm token, so
 * the tie only lost on a cold one — but a deadline loss discards every PR's
 * result, not just the slow one, so the margin is worth more than the extra
 * 200ms of per-call patience.
 */
export const PER_CALL_TIMEOUT_MS = 1800;
/**
 * Longest serial call chain in `probeOne`: gate → head → surfaces → author.
 * PRs are probed in PARALLEL, so this chain — not the PR count — is what has to
 * fit inside `PROBE_DEADLINE_MS`. At 2500ms it did not (4 x 2500 = 10000 > 8000),
 * and the overflow landed exactly where it was least affordable: the author read
 * fires only on the would-be-`clean` route, so a full-length chain threw away the
 * detection it was one call from establishing. `evidence-truth.test.ts` pins the
 * relation STRICTLY, so a fifth call cannot cross it silently and the chain has
 * somewhere to give when a cold token lands outside the per-call signal.
 */
export const MAX_SERIAL_CALLS = 4;

export function prRefsFromWorkProducts(wps: TruthWorkProduct[]): PrRef[] {
  const byKey = new Map<string, PrRef>();
  for (const wp of wps) {
    if (wp.type !== "pull_request" || !wp.metadata) continue;
    const repo = wp.metadata["repoFullName"];
    const n = wp.metadata["prNumber"];
    if (typeof repo !== "string" || !repo.trim()) continue;
    if (typeof n !== "number" || !Number.isInteger(n)) continue;
    const trusted = wp.sourceTrust?.promotedByActorId === PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST_ACTOR_ID;
    const key = `${repo.toLowerCase()}#${n}`;
    const prev = byKey.get(key);
    byKey.set(key, {
      repoFullName: repo,
      prNumber: n,
      // OR across duplicates: one webhook row saying merged is enough, and an
      // untrusted row can never contribute the claim.
      webhookMerged: (prev?.webhookMerged ?? false) || (trusted && wp.metadata["merged"] === true),
    });
  }
  return Array.from(byKey.values());
}

export interface GithubTruthDeps {
  fetchHeadSha(ref: { repoFullName: string; prNumber: number; signal?: AbortSignal }): Promise<string | null>;
  listReviewerSurfaces(ref: {
    repoFullName: string;
    prNumber: number;
    signal?: AbortSignal;
  }): Promise<ReviewerSurfaces | { error: string }>;
  getPullRequestGate(ref: {
    repoFullName: string;
    prNumber: number;
    signal?: AbortSignal;
  }): Promise<{ state: "open" | "closed"; merged: boolean } | { error: string }>;
  fetchPrAuthorLogin(ref: {
    repoFullName: string;
    prNumber: number;
    signal?: AbortSignal;
  }): Promise<string | null>;
  reviewerBotLogin: string;
}

interface PerPr {
  merged: boolean;
  clean: boolean;
  failed: boolean;
  diagnostics: string[];
}

async function probeOne(
  deps: GithubTruthDeps,
  ref: PrRef,
  perCallMs: number,
  probeSignal: AbortSignal,
): Promise<PerPr> {
  const tag = `${ref.repoFullName}#${ref.prNumber}`;
  const out: PerPr = { merged: false, clean: false, failed: false, diagnostics: [] };
  const call = { repoFullName: ref.repoFullName, prNumber: ref.prNumber };
  // Two independent cancels: this call's own budget, and the whole-probe
  // deadline. Either one ends the read.
  const sig = (): AbortSignal => AbortSignal.any([probeSignal, AbortSignal.timeout(perCallMs)]);

  // The PR author, read AT MOST ONCE and shared by both surfaces.
  //
  // Both now need it — Surface 1 to let the merge gate's author rule decide
  // `clean`, Surface 2 to refuse a self-attested review object — and both want
  // it LAZILY, because `clean` is the only verdict either surface lets the
  // author change. Fetching up front would spend a call from this probe's
  // deliberately scarce budget on every PR to change at most one verdict, and
  // would let an unreadable `GET /pulls/{n}` turn a fully justified red into a
  // failed read.
  //
  // Memoized rather than fetched per surface, and that is what keeps
  // MAX_SERIAL_CALLS at 4: the would-be-clean route reads gate, head, surfaces,
  // author — and a second author fetch would silently break the pinned
  // relation to PROBE_DEADLINE_MS. The null result is cached too; a failed read
  // is an answer, and retrying it inside one probe just spends the deadline
  // twice for the same nothing.
  let authorRead: { login: string | null } | undefined;
  const readPrAuthor = async (): Promise<string | null> => {
    authorRead ??= { login: await deps.fetchPrAuthorLogin({ ...call, signal: sig() }) };
    return authorRead.login;
  };

  try {
    if (ref.webhookMerged) {
      // The webhook is GitHub telling us directly; re-asking buys nothing and
      // spends a call from a budget the deadline makes scarce.
      out.merged = true;
    } else {
      const gate = await deps.getPullRequestGate({ ...call, signal: sig() });
      if ("error" in gate) {
        out.failed = true;
        out.diagnostics.push(`github-truth-probe-failed:pull_request:${tag}:${gate.error}`);
      } else {
        out.merged = gate.merged;
      }
    }

    const head = await deps.fetchHeadSha({ ...call, signal: sig() });
    if (!head) {
      out.failed = true;
      out.diagnostics.push(`github-truth-probe-failed:head_sha:${tag}`);
      return out;
    }
    const surfaces = await deps.listReviewerSurfaces({ ...call, signal: sig() });
    if ("error" in surfaces) {
      out.failed = true;
      out.diagnostics.push(`github-truth-probe-failed:surfaces:${tag}:${surfaces.error}`);
      return out;
    }

    const normalizedHead = head.trim().toLowerCase();

    // Surface 1: the review GRAMMAR — the consolidated-review body, wherever it
    // was filed — judged by the same function the merge gate publishes from,
    // over the same input, including its carried-finding rules.
    //
    // Author-blind FIRST, then read the author only for the outcomes the author
    // could still change — the same order, and the same reason, as the merge
    // gate's own publish path (`pr-comment-review-gate.ts`). `clean` is the one
    // outcome that consults the author, so fetching up front would spend a call
    // from this probe's deliberately scarce budget on every PR to change at most
    // one verdict, and would let an unreadable `GET /pulls/{n}` turn a fully
    // justified red into a failed read.
    const commentInput = {
      // BOTH surfaces, because the grammar is a property of the BODY and not of
      // the object carrying it. The merge gate builds this argument as
      // `[...issueComments, ...prReviews]` (`pr-comment-review-gate.ts`), and
      // Ally files most verdicts as formal review objects — so reading
      // `surfaces.comments` alone left the carried-finding rules computed over a
      // list that is EMPTY on exactly the PRs that have a finding to carry, and
      // a red the merge gate publishes could read `clean` here. Mirror the
      // gate's own row filter: `githubListPrReviewsWithTimestamps` drops
      // DISMISSED and any row with no `submitted_at`, and keys `createdAt` off
      // it. Surface 2 below keeps reading `surfaces.reviews` separately — it
      // asks a question only it can (the bodyless CHANGES_REQUESTED veto, keyed
      // on review STATE rather than on grammar).
      comments: [
        ...surfaces.comments.map((c) => ({ authorLogin: c.login, body: c.body, createdAt: c.createdAt })),
        ...surfaces.reviews
          .filter((r) => (r.state ?? "").trim().toUpperCase() !== "DISMISSED" && typeof r.submittedAt === "string")
          .map((r) => ({ authorLogin: r.login, body: r.body, createdAt: r.submittedAt as string })),
      ],
      headSha: normalizedHead,
      reviewerBotLogin: deps.reviewerBotLogin,
    };
    let commentVerdict = evaluateCommentReviewGate({ ...commentInput, prAuthorLogin: null });
    // `authorUnknown` marks every outcome the author could still change. Gating
    // on `outcome` instead would miss the carried-finding route, and `clean` is
    // unreachable author-blind by construction.
    if ("authorUnknown" in commentVerdict && commentVerdict.authorUnknown) {
      const prAuthorLogin = await readPrAuthor();
      if (prAuthorLogin) {
        commentVerdict = evaluateCommentReviewGate({ ...commentInput, prAuthorLogin });
      } else {
        // Fail CLOSED and say so: an unread author leaves the verdict at the
        // withheld positive, so this surface cannot vouch. That is the safe
        // direction for a probe whose premise is that it never fabricates a
        // pass — and Surface 2 below now fails closed on the same read.
        out.failed = true;
        out.diagnostics.push(`github-truth-probe-failed:pr_author:${tag}`);
      }
    }
    const commentClean = commentVerdict.state === "success" && commentVerdict.outcome === "clean";
    // `blocking_finding` and `carried_finding` — the two outcomes that make the
    // merge-visible gate red. `not_evaluated` is silence, not a verdict.
    const commentBlocking = commentVerdict.state === "failure";

    // Surface 2: a formal review object.
    //
    // DISMISSED is dropped in BOTH directions, matching the ruling this repo
    // already made for the other verdict-supplying read
    // (`githubListPrReviewsWithTimestamps`, github-app-auth.ts). Dismissal is
    // an authorized actor withdrawing a verdict from operation — by hand or
    // via `dismiss_stale_reviews` — and GitHub keeps the body while ceasing to
    // count it. Reading it here re-animates a retraction: a dismissed CLEAN
    // review would set `review:ally-clean` off an approval nobody stands
    // behind. `githubListReviewerSurfacesAtPr` keeps them because
    // `githubHasReviewerEvidenceForPr` asks the different question "did a
    // review happen" — a dismissed review still happened. This probe supplies
    // a verdict, so it asks the other question and filters here.
    const atHead = surfaces.reviews
      .filter((r) => (r.state ?? "").trim().toUpperCase() !== "DISMISSED")
      .filter((r) => (r.commitId ?? "").trim().toLowerCase() === normalizedHead)
      .sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? ""));
    const newest = atHead[0];
    const formalBlocking = newest !== undefined && hasActionablePrReviewFeedback(newest.body, newest.state);
    // CLEAN is keyed on the body attestation, NEVER on `commit_id` alone.
    // GitHub rewrites `commit_id` when the branch is updated, so a review of a
    // tree that no longer exists can start reporting the current head. This
    // repo already made that ruling for the other head-keyed read
    // (`pr-review-head-attestation.ts:39-44`), and it bites hardest here: a
    // false CLEAN is not a missed block, it flips the verdict to `pass` at the
    // shipped default, which is the fabrication the header at :20-24 makes this
    // module's premise. `Reviewed head:` is immutable and is emitted for
    // exactly this; `extractAllyReviewedHeadSha` fails closed on zero or
    // multiple attestations, so an unattested body can never vouch.
    //
    // Only CLEAN is narrowed, deliberately. The BLOCKING veto above still keys
    // on `commit_id`, because a `CHANGES_REQUESTED` review is blocking on its
    // STATE and may carry no body at all to attest with. Narrowing both would
    // drop it from `atHead`, clear `formalBlocking`, and let the other
    // surface's clean win — a false pass arriving through the veto instead of
    // through the detection. `evidence-truth.test.ts` pins that direction with
    // a bodyless CHANGES_REQUESTED against a clean comment.
    const formalAttestingReview =
      newest !== undefined && !formalBlocking && extractAllyReviewedHeadSha(newest.body) === normalizedHead
        ? newest
        : undefined;

    // ...and the attestation must be INDEPENDENT, by the same rule Surface 1
    // applies (BLO-34969). This is option 1 of the three that row put up, and
    // the choice is recorded here so a later reader does not restore the
    // author-blind line as a simplification.
    //
    // WHY, in one sentence: before this, which GitHub object carried a body
    // decided whether the self-attestation rule applied to it — Surface 1
    // refused an author-written `clean`, and Surface 2 read the identical body
    // off the identical row and published it anyway through the OR below.
    // Surface coverage was never the justification for that OR's clean half:
    // since the surface merge above, Surface 1 reads every row Surface 2 does,
    // so the OR had stopped being redundancy and become an override.
    //
    // WHY NOT option 2 (credit a distinct LANE via the head commit's git
    // author, which is per-lane where the GitHub login is not): it does not
    // close this. The git author says who wrote the CODE; a review is not a
    // commit, so nothing on GitHub says which lane wrote the REVIEW. Against
    // the shape this guard exists for — an implementing agent writing its own
    // consolidated-review body — a per-lane code-author test returns
    // "independent" and credits the fabrication. It is a discriminator for a
    // different question.
    //
    // KNOWN CONSEQUENCE, accepted and NOT hidden: the author IS the reviewer
    // identity on every agent-authored PR here, so `review:ally-clean` is now
    // unreachable on them by either surface. That shape is required
    // (`DEFAULT_UNLABELED_REQUIRED`), but its absence is a `warn` at the
    // shipped default — `truthOnlyGap` demotes a truth-only gap out of `block`
    // (`evidence-gate.ts`), and only `PAPERCLIP_EVIDENCE_UNLABELED_BLOCK=1`
    // promotes it back. `evidence-gate.test.ts` pins that demotion, so this
    // change moves no verdict today. Whoever flips that flag owns de-requiring
    // the shape for the self-authored population; the flag exists for a
    // measured rollout, and a detector that fabricates the pass is what would
    // make that measurement say "safe to flip".
    let formalClean = false;
    if (formalAttestingReview !== undefined) {
      const prAuthorLogin = await readPrAuthor();
      if (!prAuthorLogin) {
        // Same fail-closed direction as Surface 1: an unread author cannot
        // establish independence, and a probe whose premise is that it never
        // fabricates a pass must not guess in the crediting direction.
        out.failed = true;
        out.diagnostics.push(`github-truth-probe-failed:pr_author:${tag}`);
      } else {
        formalClean = !githubSameActorLogin(formalAttestingReview.login, prAuthorLogin);
      }
    }

    // The OR is REDUNDANCY, in both halves, and no longer an override.
    // Surface 1 reads every row Surface 2 does (the only exception is a review
    // with `submittedAt: null`, which GitHub does not produce for a submitted
    // review), but the two ask different questions of them: Surface 1 applies
    // the full review GRAMMAR — the consolidated-review heading, the
    // carried-finding ledger — while Surface 2 asks only whether an
    // independent review object attests this head. A human reviewer whose body
    // carries the attestation without Ally's heading is reachable only through
    // Surface 2, which is why it is gated rather than deleted.
    //
    // A BLOCKING verdict is not silence, and it wins outright over the other
    // surface's clean. Without that veto a duplicate or concurrent review lets
    // this shape read `review:ally-clean` at the same head the merge gate is
    // publishing red from — the two-verdicts-for-one-grammar divergence this
    // module exists to avoid, arriving through the OR instead of a parser.
    // The VETO keeps its independent justification either way: `formalBlocking`
    // reads `newest.state`, so a bodyless CHANGES_REQUESTED is reachable only
    // through Surface 2.
    out.clean = !commentBlocking && !formalBlocking && (commentClean || formalClean);
  } catch {
    // A throw is an inability to ask, which is exactly `probeFailed` — never
    // let it escape and turn one bad socket into a failed PATCH.
    out.failed = true;
    out.diagnostics.push(`github-truth-probe-failed:exception:${tag}`);
  }
  return out;
}

export function buildGithubTruthProbe(
  deps: GithubTruthDeps,
  timing: { deadlineMs?: number; perCallMs?: number } = {},
): TruthProbe {
  const deadlineMs = timing.deadlineMs ?? PROBE_DEADLINE_MS;
  const perCallMs = timing.perCallMs ?? PER_CALL_TIMEOUT_MS;

  return async ({ workProducts }) => {
    const all = prRefsFromWorkProducts(workProducts);
    // Not a failure: plenty of issues legitimately have no PR. The evaluator
    // records the shapes as missing and, unlabeled, only warns.
    if (all.length === 0)
      return {
        detections: {},
        diagnostics: ["no-linked-pull-request"],
        probeFailed: false,
        noLinkedPullRequest: true,
      };

    const diagnostics: string[] = [];
    let probeFailed = false;
    const sorted = [...all].sort((a, b) => b.prNumber - a.prNumber);
    const refs = sorted.slice(0, MAX_LINKED_PRS);
    const capped = sorted.length > MAX_LINKED_PRS;
    if (capped) {
      // A skipped PR could be the unmerged or unreviewed one, so a capped read
      // cannot honestly claim the set landed clean. Name what was dropped —
      // silent truncation reads as full coverage.
      probeFailed = true;
      diagnostics.push(
        `too-many-linked-prs:${sorted.length}:skipped=${sorted
          .slice(MAX_LINKED_PRS)
          .map((r) => `${r.repoFullName}#${r.prNumber}`)
          .join(",")}`,
      );
    }

    const abort = new AbortController();
    const work = Promise.all(refs.map((r) => probeOne(deps, r, perCallMs, abort.signal)));
    // probeOne never rejects, but keep the guard so a future edit that lets one
    // through cannot become an unhandled rejection after the deadline wins.
    work.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"deadline">((res) => {
      timer = setTimeout(() => res("deadline"), deadlineMs);
    });
    const result = await Promise.race([work, deadline]).finally(() => {
      if (timer) clearTimeout(timer);
      // Returning is not finishing: without this, every read still in flight
      // keeps its socket and its share of the request's GitHub budget for up to
      // its own per-call timeout, after the PATCH has already answered. A no-op
      // when `work` won, since every call has settled by then.
      abort.abort();
    });
    if (result === "deadline") {
      return {
        detections: {},
        diagnostics: [...diagnostics, "truth-probe-deadline"],
        probeFailed: true,
        noLinkedPullRequest: false,
      };
    }

    for (const r of result) {
      diagnostics.push(...r.diagnostics);
      if (r.failed) probeFailed = true;
    }
    const detections: Partial<Record<EvidenceShape, boolean>> = {};
    // Every linked PR must satisfy the shape. One unmerged PR means the work
    // is not fully landed, and the issue should not read as though it were.
    //
    // Withheld entirely on a capped read, for the reason the cap guard states:
    // the top 5 landing clean says nothing about the PR that was never read.
    // `probeFailed` alone does not cover this — it suppresses the escalation
    // branch, not the `pass` path, so an empty `missing` still passes. Narrow to
    // the cap on purpose: an individual `probeOne` failure is already safe,
    // since its result stays `merged: false, clean: false` and fails `every`.
    if (!capped) {
      if (result.every((r) => r.merged)) detections["deploy:landed"] = true;
      if (result.every((r) => r.clean)) detections["review:ally-clean"] = true;
    }
    return { detections, diagnostics, probeFailed, noLinkedPullRequest: false };
  };
}
