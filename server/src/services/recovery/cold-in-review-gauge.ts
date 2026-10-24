import type { IssueLivenessFinding } from "./issue-graph-liveness.js";

/**
 * PEN-4652 — turn the liveness classifier's own `in_review_without_action_path`
 * verdicts into gauge entries.
 *
 * Deliberately a PROJECTION of `classifyIssueGraphLiveness`'s output rather than
 * a second predicate. An earlier revision of this gauge re-derived "cold" in SQL
 * from four signals (live run, future monitor check, unexpired park, active
 * recovery action). That was not the classified state: `hasExplicitWaitingPath`
 * honours eight satisfiers, and the four it adds — a queued wake request, a live
 * pending interaction, a pending approval, an open recovery issue, a recent open
 * pull request, a user assignee — are the COMMONEST legitimate `in_review`
 * waits. The SQL read every one of those rows as cold, so the number it
 * published was an upper bound wearing the name of a strand rate, which is the
 * one way an instrument built to inform escalation policy can actively mislead
 * it. `recovery/service.ts` already warns (PEN-3198) that two copies of this
 * predicate drift silently; this module keeps there being one.
 *
 * Reading the classifier also settles two edges the SQL got wrong in the other
 * direction: a monitor with a future `next_check_at` that has already passed its
 * `timeoutAt` or exhausted `maxAttempts` is dead, and `hasScheduledMonitor`
 * knows it; and a row carrying both an agent and a user assignee is operator
 * territory, which `reviewFinding` declines to report at all.
 */

/**
 * The two issue columns the gauge needs, looked up by id because
 * `IssueLivenessFinding` carries neither. Both are already in the projection
 * `collectIssueGraphLiveness` loads, so this costs no extra column — which
 * matters: PEN-3314 trimmed that scan precisely to stop it retaining columns
 * nothing read.
 */
export interface ColdInReviewIssueRow {
  assigneeAgentId?: string | null;
  /**
   * Last MEANINGFUL change to the row — status flip, comment, assignee change —
   * not `updated_at`, which metadata-only writes reset. This is the same clock
   * the escalation staleness gate reads, so the gauge and the thing it exists to
   * measure the absence of cannot disagree about how old a row is. `notNull()`
   * with a `defaultNow()` in the schema, so there is no missing-age case.
   */
  lastActivityAt: Date;
}

export interface ColdInReviewGaugeEntry {
  agentId: string | null;
  ageSeconds: number;
}

export function coldInReviewGaugeEntries(
  findings: ReadonlyArray<IssueLivenessFinding>,
  issuesById: ReadonlyMap<string, ColdInReviewIssueRow>,
  now: Date,
): ColdInReviewGaugeEntry[] {
  // One cold row can produce SEVERAL findings: `reviewFinding` is reached both
  // directly and once per blocked source whose dependency path ends on it. Dedupe
  // on the issue, not the finding, so the entry count stays a row count.
  const seen = new Set<string>();
  const entries: ColdInReviewGaugeEntry[] = [];
  for (const finding of findings) {
    if (finding.state !== "in_review_without_action_path") continue;
    if (seen.has(finding.recoveryIssueId)) continue;
    seen.add(finding.recoveryIssueId);
    // A finding whose row is absent from the snapshot is dropped rather than
    // published at a guessed age: the two are read from the same snapshot, so
    // this is unreachable short of a bug, and inventing an age would be worse
    // than under-reporting one row.
    const row = issuesById.get(finding.recoveryIssueId);
    if (!row) continue;
    entries.push({
      // `reviewFinding` reports unassigned rows too — those fold into the
      // single UNKNOWN_AGENT_ID bucket downstream, which is the honest place
      // for a cold row with nobody to attribute it to.
      agentId: row.assigneeAgentId ?? null,
      ageSeconds: Math.max(0, (now.getTime() - row.lastActivityAt.getTime()) / 1000),
    });
  }
  return entries;
}
