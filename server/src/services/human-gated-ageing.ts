/**
 * Human-gated ageing escalation (BLO-19130).
 *
 * A "human-gated" issue is an open issue with a non-null `assigneeUserId`. That
 * field is already populated on 100% of human-gated work, so this module adds no
 * label, status, or title-prefix convention — `assigneeUserId` stays the single
 * source of truth.
 *
 * ## Why this module does not read `updatedAt` or `lastActivityAt`
 *
 * Neither column can measure *human* silence, because agent writes move both:
 *
 *   - `issues_sync_last_activity_at_trigger` (BEFORE UPDATE, migration
 *     `0076_issues_last_activity_at.sql`) mirrors any `updated_at` change into
 *     `last_activity_at`, so every agent-side PATCH bumps both.
 *   - `issue_comments_bump_issue_last_activity_at_trigger` (AFTER INSERT on
 *     `issue_comments`, same migration) bumps `last_activity_at` on *any*
 *     comment. It has no `author_type` filter, so an agent comment makes an
 *     abandoned issue look freshly touched.
 *
 * That is not theoretical. On 2026-06-08 a single sweep run bulk-posted
 * AC-policy grace-flag comments and reset `updatedAt` on 9 of the 10 oldest
 * human-gated issues in this company; 11 of the 15 oldest carry an `updatedAt`
 * within 10-51ms of an agent-authored comment, and 0 of 15 are attributable to
 * a human action. Measured on `updatedAt`, those issues under-report their real
 * staleness by 6-12 days each.
 *
 * So the escalation clock here is {@link humanClockAt}: the newest timestamp a
 * *human* produced, falling back to issue creation when a human has never
 * touched the issue at all. An agent cannot advance it, which is the whole
 * point — an escalation an agent can silence by commenting is not an
 * escalation.
 */

/** Open statuses that can legitimately be waiting on a human. */
export const HUMAN_GATED_OPEN_STATUSES = [
  "todo",
  "backlog",
  "in_progress",
  "in_review",
  "blocked",
] as const;

const HUMAN_GATED_OPEN_STATUS_SET: ReadonlySet<string> = new Set(HUMAN_GATED_OPEN_STATUSES);

/** Priority ordering used when grouping a report, most urgent first. */
export const HUMAN_GATED_PRIORITY_ORDER = ["critical", "high", "medium", "low"] as const;

const PRIORITY_RANK = new Map<string, number>(
  HUMAN_GATED_PRIORITY_ORDER.map((priority, index) => [priority, index]),
);

/**
 * What the issue is actually waiting for. `in_review` is waiting on a reviewer
 * to look at finished work; `todo`/`backlog` is waiting on someone to begin.
 * They need different nudges, so the report never merges them.
 */
export type HumanGatedWaitKind = "waiting_on_review" | "waiting_to_start" | "waiting_in_flight";

export type HumanGatedIssue = {
  id: string;
  identifier?: string | null;
  title: string;
  status: string;
  priority?: string | null;
  assigneeUserId?: string | null;
  /** Issue creation time (ISO-8601). The floor of the human clock. */
  createdAt: string;
  /**
   * Newest timestamp (ISO-8601) attributable to a human on this issue — the
   * latest of any `issue_comments` row with `author_type = 'user'` and any
   * `activity_log` row with `actor_type = 'user'`. Null when no human has ever
   * touched it.
   */
  lastHumanTouchAt?: string | null;
};

export type AgedHumanGatedIssue = HumanGatedIssue & {
  waitKind: HumanGatedWaitKind;
  /** The clock this issue is measured on. */
  humanClockAt: Date;
  humanSilenceDays: number;
  /** True when no human has ever touched the issue, so the clock fell back to `createdAt`. */
  neverTouchedByHuman: boolean;
};

export function classifyHumanGatedWait(status: string): HumanGatedWaitKind {
  if (status === "in_review") return "waiting_on_review";
  if (status === "todo" || status === "backlog") return "waiting_to_start";
  return "waiting_in_flight";
}

function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The escalation clock: the newest human-produced timestamp on the issue, or
 * its creation time when no human has ever touched it.
 *
 * Deliberately ignores `updatedAt` / `lastActivityAt` — see the module docblock.
 */
export function humanClockAt(issue: HumanGatedIssue): Date {
  const createdAt = parseTimestamp(issue.createdAt);
  const humanTouch = parseTimestamp(issue.lastHumanTouchAt);
  if (!createdAt) {
    if (!humanTouch) {
      throw new Error(`Issue ${issue.identifier ?? issue.id} has no parseable createdAt`);
    }
    return humanTouch;
  }
  if (!humanTouch) return createdAt;
  return humanTouch > createdAt ? humanTouch : createdAt;
}

export function humanSilenceDays(issue: HumanGatedIssue, now: Date): number {
  const elapsedMs = now.getTime() - humanClockAt(issue).getTime();
  return elapsedMs / 86_400_000;
}

export function isHumanGatedOpenIssue(issue: HumanGatedIssue): boolean {
  return Boolean(issue.assigneeUserId) && HUMAN_GATED_OPEN_STATUS_SET.has(issue.status);
}

export type SelectAgedHumanGatedOptions = {
  now: Date;
  /** Silence in days past which an issue is escalated. */
  escalateAfterDays: number;
  /**
   * Optional cap on how many issues the actionable list may contain, applied
   * after the oldest-first sort. A report that names 120 issues is a report
   * that gets muted, so the sweep escalates a bounded head and reports the
   * remainder as a count. Omit for no cap.
   */
  maxEscalated?: number;
};

export type HumanGatedAgeingReport = {
  /** Every open human-gated issue considered, oldest human-touch first. */
  scanned: AgedHumanGatedIssue[];
  /** Issues past the threshold, oldest first, truncated to `maxEscalated`. */
  escalated: AgedHumanGatedIssue[];
  /** How many issues were past the threshold but dropped by `maxEscalated`. */
  escalatedOmitted: number;
  totalOverThreshold: number;
  escalateAfterDays: number;
  countsByWaitKind: Record<HumanGatedWaitKind, number>;
  countsByPriority: Record<string, number>;
};

function comparePriority(a: string | null | undefined, b: string | null | undefined): number {
  const rankA = PRIORITY_RANK.get(a ?? "") ?? PRIORITY_RANK.size;
  const rankB = PRIORITY_RANK.get(b ?? "") ?? PRIORITY_RANK.size;
  return rankA - rankB;
}

/**
 * Select and rank open human-gated issues whose human clock has been silent
 * past `escalateAfterDays`.
 *
 * Selection is `assigneeUserId IS NOT NULL` and an open status. Ordering is
 * strictly oldest-human-touch first; ties break on priority then identifier so
 * the output is stable across runs and diffable week over week.
 */
export function selectAgedHumanGatedIssues(
  issues: HumanGatedIssue[],
  options: SelectAgedHumanGatedOptions,
): HumanGatedAgeingReport {
  const { now, escalateAfterDays, maxEscalated } = options;

  const scanned = issues
    .filter(isHumanGatedOpenIssue)
    .map((issue): AgedHumanGatedIssue => {
      const clock = humanClockAt(issue);
      return {
        ...issue,
        waitKind: classifyHumanGatedWait(issue.status),
        humanClockAt: clock,
        humanSilenceDays: (now.getTime() - clock.getTime()) / 86_400_000,
        neverTouchedByHuman: !issue.lastHumanTouchAt,
      };
    })
    .sort((a, b) => {
      const byClock = a.humanClockAt.getTime() - b.humanClockAt.getTime();
      if (byClock !== 0) return byClock;
      const byPriority = comparePriority(a.priority, b.priority);
      if (byPriority !== 0) return byPriority;
      return (a.identifier ?? a.id).localeCompare(b.identifier ?? b.id);
    });

  const overThreshold = scanned.filter((issue) => issue.humanSilenceDays > escalateAfterDays);
  const escalated =
    typeof maxEscalated === "number" ? overThreshold.slice(0, maxEscalated) : overThreshold;

  const countsByWaitKind: Record<HumanGatedWaitKind, number> = {
    waiting_on_review: 0,
    waiting_to_start: 0,
    waiting_in_flight: 0,
  };
  const countsByPriority: Record<string, number> = {};
  for (const issue of overThreshold) {
    countsByWaitKind[issue.waitKind] += 1;
    const priority = issue.priority ?? "unset";
    countsByPriority[priority] = (countsByPriority[priority] ?? 0) + 1;
  }

  return {
    scanned,
    escalated,
    escalatedOmitted: overThreshold.length - escalated.length,
    totalOverThreshold: overThreshold.length,
    escalateAfterDays,
    countsByWaitKind,
    countsByPriority,
  };
}

/**
 * Age histogram over the scanned population, for justifying (and re-justifying)
 * the threshold against the real distribution rather than a guessed number.
 */
export function humanGatedAgeHistogram(
  scanned: AgedHumanGatedIssue[],
  bucketUpperBoundsDays: number[] = [7, 14, 21, 30, 45, 60, 90],
): Array<{ label: string; count: number }> {
  const bounds = [...bucketUpperBoundsDays].sort((a, b) => a - b);
  const buckets = bounds.map((upper, index) => ({
    label: index === 0 ? `<${upper}d` : `${bounds[index - 1]}-${upper}d`,
    upper,
    count: 0,
  }));
  const overflow = { label: `${bounds[bounds.length - 1]}d+`, count: 0 };

  for (const issue of scanned) {
    const bucket = buckets.find((candidate) => issue.humanSilenceDays < candidate.upper);
    if (bucket) bucket.count += 1;
    else overflow.count += 1;
  }

  return [...buckets.map(({ label, count }) => ({ label, count })), overflow];
}

const WAIT_KIND_HEADINGS: Record<HumanGatedWaitKind, string> = {
  waiting_on_review: "Waiting on a reviewer (`in_review`)",
  waiting_to_start: "Waiting for someone to start (`todo` / `backlog`)",
  waiting_in_flight: "Waiting mid-flight (`in_progress` / `blocked`)",
};

function formatAge(days: number): string {
  return `${days.toFixed(1)}d`;
}

function formatIssueRef(issue: AgedHumanGatedIssue): string {
  return issue.identifier ?? issue.id;
}

/**
 * Render the escalation section, split by what each issue is waiting for and
 * grouped by priority within each split.
 */
export function formatHumanGatedAgeingSections(report: HumanGatedAgeingReport): string {
  const lines: string[] = [
    `### Human-gated work aged past ${report.escalateAfterDays}d of human silence (${report.totalOverThreshold})`,
  ];

  if (report.totalOverThreshold === 0) {
    lines.push("", "- None.");
    return lines.join("\n");
  }

  if (report.escalatedOmitted > 0) {
    lines.push(
      "",
      `Showing the ${report.escalated.length} oldest; ${report.escalatedOmitted} further issues are also past the threshold.`,
    );
  }

  for (const waitKind of [
    "waiting_on_review",
    "waiting_to_start",
    "waiting_in_flight",
  ] as HumanGatedWaitKind[]) {
    const inKind = report.escalated.filter((issue) => issue.waitKind === waitKind);
    if (inKind.length === 0) continue;

    lines.push("", `#### ${WAIT_KIND_HEADINGS[waitKind]} — ${report.countsByWaitKind[waitKind]}`);

    for (const priority of HUMAN_GATED_PRIORITY_ORDER) {
      const inPriority = inKind.filter((issue) => (issue.priority ?? "unset") === priority);
      if (inPriority.length === 0) continue;

      lines.push("", `**${priority}**`);
      for (const issue of inPriority) {
        const neverTouched = issue.neverTouchedByHuman ? ", never touched by a human" : "";
        lines.push(
          `- ${formatIssueRef(issue)} — ${issue.title} (${formatAge(issue.humanSilenceDays)}${neverTouched})`,
        );
      }
    }
  }

  return lines.join("\n");
}
