/**
 * Terminal-gate reconciler (BLO-27515).
 *
 * A monitor's declared `gateSignals` (BLO-18294) are opaque strings to the
 * server: they get normalized and hashed for the convergence fingerprint and
 * nothing else. Re-reading what they *mean* has therefore only ever happened
 * inside an assignee run. That is fine while the monitor is still polling, and
 * broken the moment polling stops:
 *
 *   - convergence-to-stall deliberately stops re-arming (BLO-18294), and
 *   - an outage strand kills the run that would have re-armed (BLO-27008),
 *
 * and *both* leave the gate in an **unknown** state, not an unsatisfied one.
 * Nothing distinguishes them, so a gate that resolves 16 minutes after the last
 * poll is never observed again. Worked example: BLO-24166's monitor last polled
 * `merged=NO` at 2026-08-12T23:20:27Z; Blockcast/paperclip#1281 merged at
 * 23:36:22Z; the issue then sat complete-but-open for 2d8h, cost a productivity
 * review and two Opus runs, and was closed by a human reading the PR.
 *
 * The asymmetry this closes: re-reading a PR gate is one cheap API call, while
 * waking an agent to re-read it is a full model run plus queue latency plus a
 * `long_active_duration` review if the queue is slow. Only the expensive path
 * existed.
 *
 * ## Scope, and what this deliberately does NOT do
 *
 * It posts a comment. It does not close the issue, does not clear the monitor,
 * and does not dispatch a run. A gate read proves the gate resolved; it proves
 * nothing about the issue's acceptance criteria, so closing stays a judgement
 * call for the assignee or a human — who can now make it in one cheap step
 * instead of re-deriving the whole thread. Not dispatching is load-bearing, not
 * incidental: waking an agent to announce the gate is the expense this exists
 * to remove, which is why the comment is written straight to `issue_comments`
 * rather than through `issuesSvc.addComment` (that path can enqueue a wake).
 *
 * ## Fail-closed rules
 *
 * - Only `merged` counts as satisfied. A PR closed *without* merging is equally
 *   terminal but the work did not land, which is a different situation needing
 *   a different response — it must not read as "done, go close the issue", and
 *   must not suppress oversight.
 * - Every declared signal must resolve. One unparseable token (`deploy:api`,
 *   `approval:board`) means the issue is still waiting on something this module
 *   cannot see, so the whole issue is left alone. Merge is strictly stronger
 *   than any PR sub-gate, so `:checks`/`:review` on a merged PR are moot and a
 *   merged PR satisfies whichever aspect was declared.
 * - Unresolved `blockedBy` edges fold into the gate set (BLO-18294 folds them
 *   into the fingerprint), so an issue with a live blocker is not resolved.
 *
 * Why this site rather than the restore sweep or the productivity-review
 * detector — and why each of those is wrong — is recorded in
 * `runbooks/terminal-gate-reconciler.md`.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments, issueWorkProducts, issues } from "@paperclipai/db";
import { logger as defaultLogger } from "../middleware/logger.js";
import { githubGetPullRequestGate, type PullRequestGateResult } from "./github-app-auth.js";
import { normalizeIssueMonitorGateSignals } from "./issue-execution-policy.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { listIssueDependencyReadinessMap } from "./issues.js";

/** Issues scanned per pass. The population is small by construction (a monitor with declared gates and no next check). */
const SCAN_LIMIT = 200;

/**
 * PR lookups per pass. `gateSignals` is already capped at 20 tokens per issue by
 * `issueExecutionMonitorPolicySchema`, so this only bounds the *fleet-wide* call
 * volume against the App installation's rate limit. Distinct PRs are read once
 * per pass regardless of how many issues cite them.
 */
const MAX_PULL_REQUEST_READS_PER_PASS = 100;

export const TERMINAL_GATE_RESOLVED_IDEMPOTENCY_PREFIX = "terminal-gate-resolved:";

/**
 * `normalizeGateToken` (issue-execution-policy.ts) lowercases every stored
 * signal, so this pattern is deliberately lowercase-only. GitHub repo paths are
 * case-insensitive, so the lowercased `owner/repo` still addresses the API.
 */
const PULL_REQUEST_GATE_PATTERN = /^pr:([a-z0-9._-]+\/[a-z0-9._-]+)#(\d{1,9}):([a-z0-9_-]+)$/;

export type ParsedTerminalGateSignal =
  | { kind: "pull_request"; raw: string; repoFullName: string; prNumber: number; aspect: string }
  | { kind: "unresolvable"; raw: string };

export type TerminalGateVerdict =
  | { kind: "satisfied"; signals: string[]; mergedPullRequests: string[] }
  | { kind: "unresolved"; reason: string; detail?: string };

export interface TerminalGateReconcileResult {
  scanned: number;
  resolved: number;
  pullRequestReads: number;
}

export type TerminalGateReconcilerScheduler = {
  setInterval: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  clearInterval: (timer: ReturnType<typeof setInterval>) => void;
};

const defaultScheduler: TerminalGateReconcilerScheduler = { setInterval, clearInterval };

/** Injection seam so the resolver is unit-testable without network or credentials. */
export type ReadPullRequestGate = (input: {
  repoFullName: string;
  prNumber: number;
}) => Promise<PullRequestGateResult>;

export function parseTerminalGateSignal(raw: unknown): ParsedTerminalGateSignal | null {
  if (typeof raw !== "string") return null;
  const token = raw.trim();
  if (!token) return null;
  const match = PULL_REQUEST_GATE_PATTERN.exec(token);
  if (!match) return { kind: "unresolvable", raw: token };
  const prNumber = Number.parseInt(match[2]!, 10);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return { kind: "unresolvable", raw: token };
  return {
    kind: "pull_request",
    raw: token,
    repoFullName: match[1]!,
    prNumber,
    aspect: match[3]!,
  };
}

/** `owner/repo#123` — the identity a PR gate is read and cached under. */
function pullRequestKey(repoFullName: string, prNumber: number) {
  return `${repoFullName}#${prNumber}`;
}

/**
 * Stable per-signal-set identity. Re-arming the monitor with a different gate
 * set produces a different key, so a stale resolution can never be mistaken for
 * a current one — by the idempotency index here or by the productivity-review
 * suppression that reads it.
 */
export function terminalGateResolutionIdempotencyKey(signals: readonly string[]) {
  const material = [...signals].sort().join("\n");
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 32);
  return `${TERMINAL_GATE_RESOLVED_IDEMPOTENCY_PREFIX}${digest}`;
}

/** The monitor's declared gate signals, normalized the same way the guard stores them. */
export function readIssueMonitorGateSignals(executionState: unknown): string[] {
  if (!executionState || typeof executionState !== "object") return [];
  const monitor = (executionState as { monitor?: unknown }).monitor;
  if (!monitor || typeof monitor !== "object") return [];
  const signals = (monitor as { gateSignals?: unknown }).gateSignals;
  if (!Array.isArray(signals)) return [];
  return normalizeIssueMonitorGateSignals(signals);
}

/**
 * Re-read every declared gate and decide whether the issue's terminal gate is
 * satisfied. Fail-closed at every branch: any token this module cannot parse,
 * any PR it cannot read, and any PR that is not merged leaves the issue
 * unresolved. `readPullRequestGate` is called at most once per distinct PR.
 */
export async function resolveTerminalGate(input: {
  gateSignals: readonly string[];
  readPullRequestGate: ReadPullRequestGate;
  gateCache?: Map<string, PullRequestGateResult>;
  maxPullRequestReads?: number;
}): Promise<TerminalGateVerdict> {
  const signals = [...input.gateSignals].sort();
  if (signals.length === 0) return { kind: "unresolved", reason: "no_gate_signals" };

  const parsed: Array<Extract<ParsedTerminalGateSignal, { kind: "pull_request" }>> = [];
  for (const signal of signals) {
    const gate = parseTerminalGateSignal(signal);
    if (!gate || gate.kind !== "pull_request") {
      // One signal we cannot interpret means the issue is still waiting on
      // something outside this module's view. Never partially resolve.
      return { kind: "unresolved", reason: "unresolvable_signal", detail: signal };
    }
    parsed.push(gate);
  }

  const cache = input.gateCache ?? new Map<string, PullRequestGateResult>();
  const merged = new Set<string>();
  for (const gate of parsed) {
    const key = pullRequestKey(gate.repoFullName, gate.prNumber);
    let result = cache.get(key);
    if (!result) {
      if (
        input.maxPullRequestReads !== undefined &&
        cache.size >= Math.max(1, input.maxPullRequestReads)
      ) {
        return { kind: "unresolved", reason: "pull_request_read_cap" };
      }
      result = await input.readPullRequestGate({
        repoFullName: gate.repoFullName,
        prNumber: gate.prNumber,
      });
      cache.set(key, result);
    }
    if ("error" in result) {
      return { kind: "unresolved", reason: "gate_read_failed", detail: `${key}: ${result.error}` };
    }
    // Merge is the only satisfied state. `closed` without merge is terminal but
    // the work did not land, so it must not read as "resolved, go close this".
    if (!result.merged) {
      return {
        kind: "unresolved",
        reason: result.state === "closed" ? "pull_request_closed_unmerged" : "pull_request_open",
        detail: key,
      };
    }
    merged.add(key);
  }

  return { kind: "satisfied", signals, mergedPullRequests: [...merged].sort() };
}

export function buildTerminalGateResolvedComment(input: {
  signals: readonly string[];
  mergedPullRequests: readonly string[];
}) {
  const prLines = input.mergedPullRequests.map((pr) => `- \`${pr}\` — **merged**`).join("\n");
  const signalLines = input.signals.map((signal) => `\`${signal}\``).join(", ");
  return [
    "**Terminal gate resolved — this issue's monitor gate is satisfied, but nothing is polling it.**",
    "",
    "The monitor stopped re-checking (converged to a stall, was cleared, or its run was killed) while its declared gate was still unsatisfied. A board-side re-read now finds it satisfied:",
    "",
    prLines,
    "",
    `Declared gate signals: ${signalLines}`,
    "",
    "No run was dispatched to produce this — re-reading a pull request is one API call, and waking an agent to do it is not. Nothing here closes the issue: a merged gate proves the gate resolved, not that the acceptance criteria are met. Verify the acceptance criteria against the merged artifact and close, or re-arm the monitor on whatever is genuinely still outstanding.",
    "",
    "_Posted by the terminal-gate reconciler (BLO-27515)._",
  ].join("\n");
}

type CandidateRow = {
  id: string;
  companyId: string;
  identifier: string | null;
  executionState: unknown;
};

/**
 * Issues whose monitor declared gates and whose polling has stopped.
 *
 * Deliberately NOT restricted to `in_progress`/`in_review`. A monitor can only
 * be *armed* on those statuses, but the population this exists for is precisely
 * the one an outage moved to `blocked` (and a restore sweep then moved to
 * `todo`) with the monitor state left behind in the JSONB. Restricting to the
 * armable statuses would exclude the worked example that motivated this module.
 */
async function listCandidateIssues(db: Pick<Db, "select">, limit: number): Promise<CandidateRow[]> {
  return db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      executionState: issues.executionState,
    })
    .from(issues)
    .where(and(
      notInArray(issues.status, ["done", "cancelled"]),
      isNull(issues.monitorNextCheckAt),
      visibleIssueCondition(),
      sql`jsonb_typeof(${issues.executionState} -> 'monitor' -> 'gateSignals') = 'array'`,
      sql`jsonb_array_length(${issues.executionState} -> 'monitor' -> 'gateSignals') > 0`,
      sql`not exists (
        select 1 from issue_comments resolved_comment
        where resolved_comment.issue_id = ${issues.id}
          and resolved_comment.idempotency_key like ${`${TERMINAL_GATE_RESOLVED_IDEMPOTENCY_PREFIX}%`}
          and resolved_comment.author_agent_id is null
          and resolved_comment.author_user_id is null
          and resolved_comment.deleted_at is null
          and resolved_comment.created_at >= ${issues.updatedAt}
      )`,
    ))
    .orderBy(issues.updatedAt, issues.id)
    .limit(limit);
}

/** Idempotency keys already recorded for these issues, so a resolved gate is announced once. */
async function listExistingResolutionKeys(
  db: Pick<Db, "select">,
  candidates: Array<{ id: string; key: string }>,
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const rows = await db
    .select({ issueId: issueComments.issueId, idempotencyKey: issueComments.idempotencyKey })
    .from(issueComments)
    .where(and(
      inArray(issueComments.issueId, candidates.map((c) => c.id)),
      inArray(issueComments.idempotencyKey, candidates.map((c) => c.key)),
      isNull(issueComments.authorAgentId),
      isNull(issueComments.authorUserId),
      isNull(issueComments.deletedAt),
    ));
  return new Set(rows.map((row) => `${row.issueId} ${row.idempotencyKey ?? ""}`));
}

/**
 * Look up recorded terminal-gate resolutions for a set of issues. Consumed by
 * the productivity-review detector so it can suppress a review for an issue
 * whose gate is already satisfied, without paying for a GitHub read of its own.
 *
 * Keyed on the issue's *current* signal set: a monitor re-armed on new gates
 * produces a different key, so an old resolution stops matching and oversight
 * resumes.
 */
export async function listResolvedTerminalGates(
  db: Pick<Db, "select">,
  candidates: ReadonlyArray<{ id: string; executionState: unknown }>,
): Promise<Map<string, { signals: string[]; idempotencyKey: string; createdAt: Date }>> {
  const keyed = candidates
    .map((candidate) => {
      const signals = readIssueMonitorGateSignals(candidate.executionState);
      if (signals.length === 0) return null;
      return { id: candidate.id, signals, key: terminalGateResolutionIdempotencyKey(signals) };
    })
    .filter((entry): entry is { id: string; signals: string[]; key: string } => entry !== null);
  if (keyed.length === 0) return new Map();

  // A declared PR gate is not ownership evidence: an assignee can point it at
  // any merged PR. Suppression is only valid when every declared PR is also a
  // trusted GitHub work product of this issue. The reconciler itself may still
  // announce an unbound gate, but the productivity detector must not let that
  // announcement retire accountability.
  const workProductRows = await db
    .select({ issueId: issueWorkProducts.issueId, externalId: issueWorkProducts.externalId })
    .from(issueWorkProducts)
    .where(and(
      inArray(issueWorkProducts.issueId, keyed.map((entry) => entry.id)),
      eq(issueWorkProducts.provider, "github"),
      eq(issueWorkProducts.type, "pull_request"),
      sql`${issueWorkProducts.metadata}->>'source' = 'github_pull_request_webhook'`,
      sql`${issueWorkProducts.sourceTrust}->>'promotedByActorType' = 'system'`,
      sql`${issueWorkProducts.sourceTrust}->>'promotedByActorId' = 'github_pull_request_webhook'`,
    ));
  const ownedPullRequests = new Set(
    workProductRows.map((row) => `${row.issueId}\u0000${(row.externalId ?? "").toLowerCase()}`),
  );
  const ownedKeyed = keyed.filter((entry) => {
    const parsed = entry.signals.map(parseTerminalGateSignal);
    return parsed.every((gate) =>
      gate?.kind === "pull_request" &&
      ownedPullRequests.has(`${entry.id}\u0000${pullRequestKey(gate.repoFullName, gate.prNumber).toLowerCase()}`),
    );
  });
  if (ownedKeyed.length === 0) return new Map();

  const rows = await db
    .select({
      issueId: issueComments.issueId,
      idempotencyKey: issueComments.idempotencyKey,
      createdAt: issueComments.createdAt,
    })
    .from(issueComments)
    .where(and(
      inArray(issueComments.issueId, ownedKeyed.map((entry) => entry.id)),
      inArray(issueComments.idempotencyKey, ownedKeyed.map((entry) => entry.key)),
      isNull(issueComments.authorAgentId),
      isNull(issueComments.authorUserId),
      isNull(issueComments.deletedAt),
    ));
  const existing = new Map(rows.map((row) => [
    `${row.issueId} ${row.idempotencyKey ?? ""}`,
    row.createdAt,
  ]));
  const resolved = new Map<string, { signals: string[]; idempotencyKey: string; createdAt: Date }>();
  for (const entry of ownedKeyed) {
    const createdAt = existing.get(`${entry.id} ${entry.key}`);
    if (!createdAt) continue;
    resolved.set(entry.id, { signals: entry.signals, idempotencyKey: entry.key, createdAt });
  }
  return resolved;
}

/**
 * One reconciler pass. Safe to run from every worker replica: the comment
 * insert is guarded by `issue_comments_issue_system_idempotency_idx` (unique on
 * `(issue_id, idempotency_key)` for system-authored rows) with
 * `onConflictDoNothing`, so a concurrent pass loses the race harmlessly rather
 * than double-posting.
 */
export async function reconcileTerminalGates(
  db: Db,
  options: {
    scanLimit?: number;
    maxPullRequestReads?: number;
    readPullRequestGate?: ReadPullRequestGate;
    logger?: typeof defaultLogger;
    now?: Date;
  } = {},
): Promise<TerminalGateReconcileResult> {
  const log = options.logger ?? defaultLogger;
  const readPullRequestGate = options.readPullRequestGate ?? githubGetPullRequestGate;
  const maxReads = Math.max(1, options.maxPullRequestReads ?? MAX_PULL_REQUEST_READS_PER_PASS);
  const now = options.now ?? new Date();

  const candidates = await listCandidateIssues(db, Math.max(1, options.scanLimit ?? SCAN_LIMIT));
  if (candidates.length === 0) return { scanned: 0, resolved: 0, pullRequestReads: 0 };

  const withSignals = candidates
    .map((candidate) => ({ candidate, signals: readIssueMonitorGateSignals(candidate.executionState) }))
    .filter((entry) => entry.signals.length > 0)
    .map((entry) => ({ ...entry, key: terminalGateResolutionIdempotencyKey(entry.signals) }));

  // Drop anything already announced before spending a single API call.
  const alreadyResolved = await listExistingResolutionKeys(
    db,
    withSignals.map((entry) => ({ id: entry.candidate.id, key: entry.key })),
  );
  const pending = withSignals.filter(
    (entry) => !alreadyResolved.has(`${entry.candidate.id} ${entry.key}`),
  );
  if (pending.length === 0) {
    return { scanned: candidates.length, resolved: 0, pullRequestReads: 0 };
  }

  // A live blocker edge is part of the gate set (BLO-18294 folds unresolved
  // blockers into the fingerprint), so an issue with one is not resolved
  // however its PRs read.
  const byCompany = new Map<string, string[]>();
  for (const entry of pending) {
    const ids = byCompany.get(entry.candidate.companyId) ?? [];
    ids.push(entry.candidate.id);
    byCompany.set(entry.candidate.companyId, ids);
  }
  const dependencyReady = new Set<string>();
  for (const [companyId, issueIds] of byCompany) {
    const readiness = await listIssueDependencyReadinessMap(db, companyId, issueIds);
    for (const issueId of issueIds) {
      if ((readiness.get(issueId)?.unresolvedBlockerCount ?? 0) === 0) dependencyReady.add(issueId);
    }
  }

  const gateCache = new Map<string, PullRequestGateResult>();
  let resolved = 0;
  for (const entry of pending) {
    if (!dependencyReady.has(entry.candidate.id)) continue;

    const verdict = await resolveTerminalGate({
      gateSignals: entry.signals,
      readPullRequestGate,
      gateCache,
      maxPullRequestReads: maxReads,
    });
    if (verdict.kind !== "satisfied") continue;

    const inserted = await db
      .insert(issueComments)
      .values({
        companyId: entry.candidate.companyId,
        issueId: entry.candidate.id,
        authorType: "system",
        idempotencyKey: entry.key,
        idempotencyProcessedAt: now,
        body: buildTerminalGateResolvedComment({
          signals: verdict.signals,
          mergedPullRequests: verdict.mergedPullRequests,
        }),
      })
      .onConflictDoNothing()
      .returning({ id: issueComments.id });
    if (inserted.length === 0) continue;

    resolved += 1;
    log.info(
      {
        issueId: entry.candidate.id,
        identifier: entry.candidate.identifier,
        mergedPullRequests: verdict.mergedPullRequests,
        gateSignals: verdict.signals,
      },
      "terminal-gate reconciler recorded a satisfied monitor gate without dispatching a run (BLO-27515)",
    );
  }

  return { scanned: candidates.length, resolved, pullRequestReads: gateCache.size };
}

/**
 * Start a periodic sweep. Mirrors `startStrandedBlockedIssueReconciler`: one
 * pass immediately so an already-stranded backlog is announced without waiting
 * a full interval, then on the configured cadence.
 */
export function startTerminalGateReconciler(
  db: Db,
  intervalMs: number,
  options: Parameters<typeof reconcileTerminalGates>[1] = {},
  scheduler: TerminalGateReconcilerScheduler = defaultScheduler,
): () => void {
  let inFlight: Promise<void> | null = null;
  const runTick = () => {
    if (inFlight) return;
    inFlight = reconcileTerminalGates(db, options)
      .catch((err) => {
        defaultLogger.error({ err }, "terminal-gate reconciler sweep failed");
      })
      .then(() => undefined)
      .finally(() => {
        inFlight = null;
      });
  };

  runTick();
  const timer = scheduler.setInterval(runTick, intervalMs);
  return () => scheduler.clearInterval(timer);
}
