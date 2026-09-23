import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Open-PR review state, persisted so the review-request ageing digest can read
 * it (BLO-30259).
 *
 * ## Why this table exists at all
 *
 * `server/src/services/pr-review-request-ageing.ts` consumes `pendingReviewRequests`,
 * `reviews`, `authorLogin` and a real PR `createdAt`. Before this table **none of
 * those had any persistence anywhere in the schema** — the only two PR-shaped
 * tables were `issue_pull_requests` (merged-only, and deliberately author-free)
 * and `issue_work_products` (webhook-shaped, no review state). So the ageing
 * module had no data to run on and sat at zero production importers.
 *
 * It could not simply fetch that state at digest time: producer collection runs
 * **inside** the per-company digest transaction with the advisory lock held
 * (`human-gated-ageing-digest.ts`), so a GitHub call there would serialise every
 * company's digest behind GitHub latency and rate limits. The split is therefore
 * deliberate — `pr-review-state-reconciler.ts` does the network I/O on its own
 * interval and writes here; the digest producer is a pure read of this table.
 *
 * ## Readability is a stored fact, not an inference
 *
 * `requestsReadable` / `reviewsReadable` are the load-bearing columns. An empty
 * `pendingReviewRequests` means two completely different things depending on
 * them: *"we asked GitHub and it said nobody is requested"* versus *"we could not
 * read it"*. Collapsing those is the exact false-all-clear this module exists to
 * refuse — a queue of unanswered requests rendered as an empty section reads to a
 * human as "no PRs are waiting".
 *
 * That is not hypothetical. Measured on `Blockcast/onprem-k8s` 2026-08-29, n=114
 * App-authored open PRs: the **list** payload's `requested_teams` reports zero for
 * all 114, while the dedicated `/pulls/{n}/requested_reviewers` endpoint resolves
 * **97** of them as carrying a live pending team request and only 17 as genuinely
 * unrouted. Same installation token, same PRs. Hence the reconciler is required to
 * source presence from the dedicated endpoint, and hence a failed probe is stored
 * as unreadable rather than defaulted to `[]`.
 *
 * Rows are keyed `(companyId, repoFullName, prNumber)` and cover **open** PRs
 * only; the reconciler prunes rows for PRs that have left the open set, but only
 * after an enumeration it knows was complete.
 */
export const pullRequestReviewState = pgTable(
  "pull_request_review_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    repoFullName: text("repo_full_name").notNull(),
    prNumber: integer("pr_number").notNull(),

    /**
     * The PR's real GitHub creation time — the floor of the ageing clock.
     *
     * Deliberately not reused from `issue_work_products.metadata`: the timestamp
     * there is `sourceEventTimestamp`, which is the PR's `updated_at` at webhook
     * time, and the row's own `createdAt` is row-creation. Ageing on either would
     * let any push reset a PR's unanswered age.
     */
    prCreatedAt: timestamp("pr_created_at", { withTimezone: true }).notNull(),
    authorLogin: text("author_login"),
    title: text("title"),
    url: text("url"),
    isDraft: boolean("is_draft").notNull().default(false),

    /** False when the dedicated requested-reviewers probe did not answer. */
    requestsReadable: boolean("requests_readable").notNull().default(false),
    /** `PendingReviewRequest[]`. Meaningless unless `requestsReadable`. */
    pendingReviewRequests: jsonb("pending_review_requests")
      .$type<Array<{ requestedAt?: string | null; reviewerLogin?: string | null; reviewerSlug?: string | null }>>()
      .notNull()
      .default([]),

    /** False when the reviews probe did not answer. */
    reviewsReadable: boolean("reviews_readable").notNull().default(false),
    /** `PullRequestReview[]`. Meaningless unless `reviewsReadable`. */
    reviews: jsonb("reviews")
      .$type<Array<{ authorLogin?: string | null; submittedAt?: string | null; state?: string | null }>>()
      .notNull()
      .default([]),

    /**
     * Why this row could not be fully read, when it could not. Rendered into the
     * digest's unreadable block so a human sees the cause rather than a gap.
     */
    unreadableReason: text("unreadable_reason"),

    /** When the reconciler last successfully probed this PR. */
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRepoPrUniq: uniqueIndex("pull_request_review_state_company_repo_pr_uniq").on(
      table.companyId,
      table.repoFullName,
      table.prNumber,
    ),
    // The digest producer's only query shape: every open PR for one company,
    // oldest first.
    companyCreatedIdx: index("pull_request_review_state_company_created_idx").on(
      table.companyId,
      table.prCreatedAt,
    ),
    // The reconciler's prune scope.
    companyRepoIdx: index("pull_request_review_state_company_repo_idx").on(
      table.companyId,
      table.repoFullName,
    ),
  }),
);
