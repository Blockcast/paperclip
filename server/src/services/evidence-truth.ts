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
import { hasActionablePrReviewFeedback } from "./ally-review-detection.js";
import { PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST_ACTOR_ID } from "./pull-request-work-products.js";
import type { ReviewerSurfaces } from "./github-app-auth.js";

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
/** Per-call budget, so one wedged socket cannot consume the whole probe deadline. */
export const PER_CALL_TIMEOUT_MS = 2500;

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

    // Surface 1: the comment-shaped review, judged by the same function the
    // merge gate publishes from — including its carried-finding rules.
    const commentVerdict = evaluateCommentReviewGate({
      comments: surfaces.comments.map((c) => ({ authorLogin: c.login, body: c.body, createdAt: c.createdAt })),
      headSha: normalizedHead,
      reviewerBotLogin: deps.reviewerBotLogin,
    });
    const commentClean = commentVerdict.state === "success" && commentVerdict.outcome === "clean";
    // `blocking_finding` and `carried_finding` — the two outcomes that make the
    // merge-visible gate red. `not_evaluated` is silence, not a verdict.
    const commentBlocking = commentVerdict.state === "failure";

    // Surface 2: a formal review object.
    const atHead = surfaces.reviews
      .filter((r) => (r.commitId ?? "").trim().toLowerCase() === normalizedHead)
      .sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? ""));
    const newest = atHead[0];
    const formalBlocking = newest !== undefined && hasActionablePrReviewFeedback(newest.body, newest.state);
    const formalClean = newest !== undefined && !formalBlocking;

    // Each surface is individually blind to the other — Ally files a formal
    // review on some PRs and only a comment on others — so SILENCE on one is
    // not evidence, and the clean verdicts are OR'd.
    //
    // A BLOCKING verdict is not silence, and it wins outright over the other
    // surface's clean. Without that veto a duplicate or concurrent review lets
    // this shape read `review:ally-clean` at the same head the merge gate is
    // publishing red from — the two-verdicts-for-one-grammar divergence this
    // module exists to avoid, arriving through the OR instead of a parser.
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
    if (all.length === 0) return { detections: {}, diagnostics: ["no-linked-pull-request"], probeFailed: false };

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
      return { detections: {}, diagnostics: [...diagnostics, "truth-probe-deadline"], probeFailed: true };
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
    return { detections, diagnostics, probeFailed };
  };
}
