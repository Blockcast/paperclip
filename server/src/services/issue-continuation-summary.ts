import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documents, issueDocuments, issues } from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY, type SourceTrustMetadata } from "@paperclipai/shared";
import { documentService } from "./documents.js";
import { truncateSectionText, truncateText } from "./truncate-text.js";

export { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY };
export const ISSUE_CONTINUATION_SUMMARY_TITLE = "Continuation Summary";
export const ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS = 8_000;
const SUMMARY_SECTION_MAX_CHARS = 1_200;
const BODY_ELISION_MARKER =
  "\n\n[... continuation summary elided to fit the body budget; read the issue description and run log for the full text ...]\n\n";
const STATUS_DERIVED_NEXT_ACTIONS = {
  done: "Review the completed issue output and close any remaining follow-up comments.",
  inReview: "Wait for reviewer feedback or approval before continuing executor work.",
  failed: "Inspect the failed run, fix the cause, and resume from the most recent concrete action above.",
  cancelled: "Confirm the cancellation reason before starting another run.",
  resume: "Resume implementation from the acceptance criteria, latest comments, and this summary.",
} as const;
const STATUS_DERIVED_NEXT_ACTION_VALUES: ReadonlySet<string> = new Set(Object.values(STATUS_DERIVED_NEXT_ACTIONS));

function isStatusDerivedNextAction(nextAction: string) {
  return STATUS_DERIVED_NEXT_ACTION_VALUES.has(nextAction.trim());
}
const PATH_CANDIDATE_RE = /(?:^|[\s`"'(])((?:server|ui|packages|doc|scripts|\.github)\/[A-Za-z0-9._/-]+)/g;
const WAITING_FOR_REVIEW_OR_APPROVAL_RE =
  /\bwait(?:ing)? for\b.{0,160}\b(?:review(?:er)?(?: feedback)?|approval|board|human|user|operator)\b/i;

type IssueSummaryInput = {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
};

type RunSummaryInput = {
  id: string;
  status: string;
  error: string | null;
  errorCode?: string | null;
  resultJson?: Record<string, unknown> | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
  finishedAt?: Date | null;
};

type AgentSummaryInput = {
  id: string;
  name: string;
  adapterType: string | null;
};

export type IssueContinuationSummaryDocument = {
  key: typeof ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY;
  title: string | null;
  body: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  sourceTrust: SourceTrustMetadata | null;
  updatedAt: Date;
};

function asNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readResultSummary(resultJson: Record<string, unknown> | null | undefined) {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return null;
  return (
    asNonEmptyString(resultJson.summary) ??
    asNonEmptyString(resultJson.result) ??
    asNonEmptyString(resultJson.message) ??
    asNonEmptyString(resultJson.error) ??
    null
  );
}

function extractMarkdownSection(markdown: string | null | undefined, heading: string) {
  if (!markdown) return null;
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, "im");
  const match = re.exec(markdown);
  const section = match?.[1]?.trim();
  return section ? truncateSectionText(section, SUMMARY_SECTION_MAX_CHARS) : null;
}

function extractPathCandidates(...texts: Array<string | null | undefined>) {
  const seen = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(PATH_CANDIDATE_RE)) {
      const path = match[1]?.replace(/[),.;:]+$/, "");
      if (path) seen.add(path);
      if (seen.size >= 12) break;
    }
    if (seen.size >= 12) break;
  }
  return [...seen];
}

function inferMode(issue: IssueSummaryInput, run: RunSummaryInput) {
  if (issue.status === "done" || issue.status === "in_review") return "review";
  if (run.status === "failed" || run.status === "timed_out" || run.status === "cancelled" || run.status === "interrupted") return "implementation";
  if (issue.status === "backlog" || issue.status === "todo") return "plan";
  return "implementation";
}

function inferNextAction(issue: IssueSummaryInput, run: RunSummaryInput, previousNextAction: string | null) {
  if (issue.status === "done") return STATUS_DERIVED_NEXT_ACTIONS.done;
  if (issue.status === "in_review") return STATUS_DERIVED_NEXT_ACTIONS.inReview;
  if (run.status === "failed" || run.status === "timed_out") return STATUS_DERIVED_NEXT_ACTIONS.failed;
  if (run.status === "cancelled") return STATUS_DERIVED_NEXT_ACTIONS.cancelled;
  // A status-derived line is a statement about the run and issue state that produced it, so it
  // expires with that state. Carrying one forward is how a document records a `succeeded` run and
  // then tells the next run to inspect the failed one, and how a row that has left `in_review`
  // keeps re-minting the park line `continuationSummaryParksExecutor` cancels runs on (PEN-4311).
  // Anything else in that section was not written by this function, so it still carries forward.
  if (previousNextAction && !isStatusDerivedNextAction(previousNextAction)) return previousNextAction;
  return STATUS_DERIVED_NEXT_ACTIONS.resume;
}

function bulletList(items: string[], empty: string) {
  if (items.length === 0) return `- ${empty}`;
  return items.map((item) => `- ${item}`).join("\n");
}

function extractPreviousNextAction(previousBody: string | null | undefined) {
  const section = extractMarkdownSection(previousBody, "Next Action");
  if (!section) return null;
  return section
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .find(Boolean) ?? null;
}

export function extractContinuationSummaryNextAction(body: string | null | undefined) {
  return extractPreviousNextAction(body);
}

export function continuationSummaryParksExecutor(body: string | null | undefined) {
  const nextAction = extractContinuationSummaryNextAction(body);
  if (!nextAction) return false;
  return WAITING_FOR_REVIEW_OR_APPROVAL_RE.test(nextAction);
}

export function buildContinuationSummaryMarkdown(input: {
  issue: IssueSummaryInput;
  run: RunSummaryInput;
  agent: AgentSummaryInput;
  previousSummaryBody?: string | null;
}) {
  const { issue, run, agent } = input;
  const resultSummary = readResultSummary(run.resultJson);
  const recentActions = [
    `Run \`${run.id}\` finished with status \`${run.status}\`${run.finishedAt ? ` at ${run.finishedAt.toISOString()}` : ""}.`,
    resultSummary
      ? truncateSectionText(resultSummary, SUMMARY_SECTION_MAX_CHARS, "the run log")
      : "No adapter-provided result summary was captured for this run.",
  ];
  if (run.error) {
    recentActions.push(
      `Latest run error${run.errorCode ? ` (${run.errorCode})` : ""}: ${truncateText(run.error, 500, "[truncated]", "\n")}`,
    );
  }

  const paths = extractPathCandidates(resultSummary, run.stdoutExcerpt, run.stderrExcerpt, input.previousSummaryBody);
  const objective = extractMarkdownSection(issue.description, "Objective") ?? issue.description?.trim() ?? "No objective captured.";
  const acceptanceCriteria = extractMarkdownSection(issue.description, "Acceptance Criteria") ?? "No explicit acceptance criteria captured.";
  const mode = inferMode(issue, run);
  const nextAction = inferNextAction(issue, run, extractPreviousNextAction(input.previousSummaryBody));

  const body = [
    "# Continuation Summary",
    "",
    `- Issue: ${issue.identifier ?? issue.id} — ${issue.title}`,
    `- Status: ${issue.status}`,
    `- Priority: ${issue.priority}`,
    `- Current mode: ${mode}`,
    `- Last updated by run: ${run.id}`,
    `- Agent: ${agent.name} (${agent.adapterType ?? "unknown"})`,
    "",
    "## Objective",
    "",
    truncateSectionText(objective, SUMMARY_SECTION_MAX_CHARS),
    "",
    "## Acceptance Criteria",
    "",
    acceptanceCriteria,
    "",
    "## Recent Concrete Actions",
    "",
    bulletList(recentActions, "No recent actions captured."),
    "",
    "## Files / Routes Touched",
    "",
    bulletList(paths.map((path) => `\`${path}\``), "No file or route paths were detected in the captured run summary."),
    "",
    "## Commands Run",
    "",
    bulletList(
      [
        `Heartbeat run \`${run.id}\` invoked adapter \`${agent.adapterType ?? "unknown"}\`.`,
        "Detailed shell/tool commands remain in the run log and transcript.",
      ],
      "No command metadata captured.",
    ),
    "",
    "## Blockers / Decisions",
    "",
    bulletList(
      run.error
        ? [`Latest run ended with \`${run.status}\`; inspect the error before continuing.`]
        : ["No new blocker was recorded by the latest run."],
      "No blockers or decisions captured.",
    ),
    "",
    "## Next Action",
    "",
    `- ${nextAction}`,
  ].join("\n");

  // The whole-body cap keeps the head/tail shape on purpose: `## Next Action` is the last
  // section, and both `extractPreviousNextAction` and `continuationSummaryParksExecutor` read it.
  // A head-only cut here would silently delete the one section the next run acts on. The marker
  // is explicit so an over-budget body cannot read as continuous prose (PEN-4311).
  return truncateText(body, ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS, BODY_ELISION_MARKER);
}

export async function getIssueContinuationSummaryDocument(
  db: Db,
  issueId: string,
): Promise<IssueContinuationSummaryDocument | null> {
  const row = await db
    .select({
      key: issueDocuments.key,
      title: documents.title,
      body: documents.latestBody,
      latestRevisionId: documents.latestRevisionId,
      latestRevisionNumber: documents.latestRevisionNumber,
      sourceTrust: documents.sourceTrust,
      updatedAt: documents.updatedAt,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY)))
    .then((rows) => rows[0] ?? null);

  if (!row) return null;
  return {
    key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    title: row.title,
    body: row.body,
    latestRevisionId: row.latestRevisionId,
    latestRevisionNumber: row.latestRevisionNumber,
    sourceTrust: row.sourceTrust ?? null,
    updatedAt: row.updatedAt,
  };
}

export async function refreshIssueContinuationSummary(input: {
  db: Db;
  issueId: string;
  run: RunSummaryInput;
  agent: AgentSummaryInput;
}) {
  const { db, issueId, run, agent } = input;
  const [issue, existing] = await Promise.all([
    db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        description: issues.description,
        status: issues.status,
        priority: issues.priority,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null),
    getIssueContinuationSummaryDocument(db, issueId),
  ]);

  if (!issue) return null;
  const body = buildContinuationSummaryMarkdown({
    issue,
    run,
    agent,
    previousSummaryBody: existing?.body ?? null,
  });
  const result = await documentService(db).upsertIssueDocument({
    issueId,
    key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    title: ISSUE_CONTINUATION_SUMMARY_TITLE,
    format: "markdown",
    body,
    baseRevisionId: existing?.latestRevisionId ?? null,
    changeSummary: `Refresh continuation summary after run ${run.id}`,
    createdByAgentId: agent.id,
    createdByRunId: run.id,
  });
  return result.document;
}
