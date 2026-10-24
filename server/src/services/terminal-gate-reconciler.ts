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
 *   `mq:drained`) means the issue is still waiting on something this module
 *   cannot see, so the whole issue is left alone. Merge is strictly stronger
 *   than any PR sub-gate, so `:checks`/`:review` on a merged PR are moot and a
 *   merged PR satisfies whichever aspect was declared.
 * - A token naming a *human* decision (`omar-go`, `approval:board`) is the one
 *   exception, and it is an exception to the silence, not to the fail-closed
 *   rule: such an issue is still never `satisfied`. When every other gate is
 *   merged it gets its own verdict and its own comment, because a gate only a
 *   person can clear is the one class where continuing to wait is not a
 *   strategy. See PEN-4545 in `runbooks/terminal-gate-reconciler.md`.
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
import {
  exhaustedMonitorClearReason,
  issueAllowsMonitor,
  normalizeIssueMonitorGateSignals,
} from "./issue-execution-policy.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { listIssueDependencyReadinessMap } from "./issues.js";

/** Issues scanned per pass. The population is small by construction (a monitor with declared gates that is not polling, or has not polled yet — see `listCandidateIssues`). */
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
 * Separate prefix for the human-gate announcement (PEN-4545), so the two
 * findings can never be mistaken for one another by the anti-join, by
 * `listResolvedTerminalGates`, or by an agent reading the thread. A resolved
 * gate says *go close this*; a human-only gate says *nothing on a timer will
 * ever clear this*. Those warrant opposite actions.
 */
export const TERMINAL_GATE_HUMAN_ONLY_IDEMPOTENCY_PREFIX = "terminal-gate-human-only:";

/**
 * Third prefix, for the *held-open* shape of the human-gate finding: a
 * declared pull request still open because a hold-protocol gate names it.
 *
 * It is separate from `TERMINAL_GATE_HUMAN_ONLY_IDEMPOTENCY_PREFIX` because
 * the two findings have opposite lifetimes, and sharing a key made the
 * documented post-merge transition unreachable (caught on #2974):
 *
 *   - the plain human-only finding is **terminal**. Every declared pull
 *     request has merged and a person still has not acted; no later sweep can
 *     read anything different, so it is announced once and the row is retired
 *     from the window for good.
 *   - the held finding is **provisional**. It is a statement about a pull
 *     request that is open *right now*, and the event that ends it — the
 *     merge — changes nothing in the database. Retiring the row on the same
 *     key as the terminal finding meant the row was never selected again, so
 *     the merged -> `satisfied`, verify-and-close transition the runbook
 *     promises could only ever fire for a row whose pull request merged
 *     before any sweep saw it open. For the population PEN-4545 measured
 *     (held open ~24h while actively polling) the held notice always comes
 *     first, so that transition was dead for exactly the rows it was for.
 *
 * A provisional finding is therefore re-examined on a cadence
 * (`HELD_GATE_RECHECK_INTERVAL_MS`) rather than never, and the comment itself
 * is still posted at most once by the idempotency index.
 */
export const TERMINAL_GATE_HELD_IDEMPOTENCY_PREFIX = "terminal-gate-human-only-held:";

/**
 * How long a held-open announcement keeps its row out of the scan window
 * before the sweep re-reads the pull request to see whether the go arrived.
 *
 * The two costs this trades between are both real and both already named in
 * this file. Never re-admitting the row loses the post-merge notice entirely.
 * Re-admitting it every pass spends a `SCAN_LIMIT` slot and a pull-request
 * read every 10 minutes, for a wait measured in days — the starvation vector
 * the resolved-side anti-join exists to remove, reached through a new door,
 * and the one the held row would camp on *ahead* of the stranded population
 * (`updatedAt ASC`).
 *
 * Six hours is deliberately far from both: ~4 reads per day per held row
 * against the ~144 a per-pass re-admission would cost, and the post-merge
 * notice lands within six hours of the merge. Nothing downstream is
 * time-critical — the notice says "verify the acceptance criteria and close",
 * which is not an outage response.
 */
const HELD_GATE_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * `normalizeGateToken` (issue-execution-policy.ts) lowercases every stored
 * signal, so this pattern is deliberately lowercase-only. GitHub repo paths are
 * case-insensitive, so the lowercased `owner/repo` still addresses the API.
 */
const PULL_REQUEST_GATE_PATTERN = /^pr:([a-z0-9._-]+\/[a-z0-9._-]+)#(\d{1,9}):([a-z0-9_-]+)$/;

/**
 * Tokens that name a **human decision** rather than a machine-observable state
 * (PEN-4545).
 *
 * These parse no better than `mq:` or `argo:` do — this module cannot read
 * whether a person has decided something. The distinction it draws is about
 * *who can ever clear the gate*, because that determines whether waiting is a
 * strategy:
 *
 *   - `deploy:landed` is unresolvable *here* but resolvable *in principle* by
 *     the assignee's next poll. Waiting is reasonable.
 *   - `omar-go:#2686` is resolvable by exactly one party, who is not watching
 *     this row and has nothing telling them it exists. Waiting is not a
 *     strategy; it is the failure.
 *
 * The second class is the one PEN-4545 measured, and it was invisible precisely
 * *because* it reached `unresolvable_signal` and was dropped in silence — the
 * same branch an infra token takes. Six `in_review` rows across three agents
 * sat ~24h behind a human go that no approval card named, each with an armed
 * `monitorNextCheckAt` making it read as attended on every dashboard. When the
 * go finally arrived (a blanket "go for all", 2026-10-23T12:16Z) nothing
 * connected it to the rows parked against it; five were found by an unrelated
 * errand, two were parked three and six days past the event they waited for.
 *
 * ## Why an allowlist rather than "anything unparseable"
 *
 * Treating every unparseable token as a human gate would announce over `mq:`,
 * `heap:`, `argo:`, `cron:`, `insync:` and `deploy:` — all of which the
 * assignee's own poll does resolve, and none of which a human is expected to
 * clear. The fleet census in `listCandidateIssues` observed exactly those six
 * machine prefixes alongside `approval:`, `cto-ruling:` and `hold:`, so the
 * split is drawn from measured tokens rather than guessed at.
 *
 * ## What this list still cannot see, stated rather than implied
 *
 * A human gate is visible here only when it is written as its own token. A row
 * declaring nothing but `pr:owner/repo#N:merged`, carrying "needs one human
 * approval" in `monitorNotes`, is indistinguishable from a row waiting on CI —
 * PEN-4410 is live in exactly that shape. Those rows keep today's silence,
 * which is the fail-safe direction, and reaching them means reading the pull
 * request's own review state rather than lengthening this list.
 *
 * Conservative in the safe direction: a human-gate token this list does not
 * know keeps today's behaviour exactly (silent `unresolvable_signal`), so the
 * worst case of an omission is the status quo, while a false *positive* would
 * post a wrong-headed comment. New prefixes should be added on evidence.
 *
 * ## Two classes, and only one of them is discharged by a merge
 *
 * The allowlist splits in two. Everything above is true of both halves; what
 * separates them is whether the token's content ties the person's decision to
 * the merge of a pull request. See `HOLD_PROTOCOL_TOKEN_PREFIXES`, which is
 * the half that does — the subject join reads that half and no other.
 */

/**
 * The hold-protocol subset: tokens whose *content* is "do not merge pull
 * request N until a person says go".
 *
 * This subset alone licenses the two inferences the join makes, and both of
 * them run backwards for any other prefix:
 *
 *   - **held open**: the named pull request is open *because* the gate holds
 *     it there, so the open state is the human wait rather than outstanding
 *     machine work; and
 *   - **discharged**: the merge could not have happened before the go, so the
 *     merge is itself the record that the go arrived.
 *
 * A `signoff:`, `approval:`, `card:` or `*-ruling:` token naming a pull
 * request says no such thing. It can perfectly well name a decision that
 * comes *after* the merge — `signoff:pr-2686:rollout`, `approval:prod-deploy`
 * — so discharging it on merge would convert a still-standing human gate into
 * a `satisfied` verdict and post "there is nothing left to chase" over a
 * decision nobody has made. That is the fail-open direction this module
 * exists to refuse, so those prefixes keep standing after their pull request
 * merges, and the row is announced as `human_gate_only` instead.
 *
 * The same asymmetry applies to the held-open branch: "this pull request is
 * open because a person has not released it" is a claim about *why* it is
 * open, and only the hold protocol establishes it. A non-hold gate beside an
 * open pull request therefore keeps the fail-closed
 * `unresolved/pull_request_open` it had before the join existed.
 */
const HOLD_PROTOCOL_TOKEN_PREFIXES = [
  "omar-go",
  // `hold:f35d6c:pr-2655:omar-go` — PEN-2619's live token, and the reason
  // `parseHumanGateSubject` reads `pr-2655` as well as `#2655`.
  "hold",
  "hold-lift",
  "hold-lifted",
  "human-go",
  "founder-go",
] as const;

/**
 * Human gates that are *not* the hold protocol: a person must act, but nothing
 * ties the timing of that act to the merge of any pull request the token
 * happens to name. These are announced and never discharged.
 */
const STANDING_HUMAN_GATE_TOKEN_PREFIXES = [
  "approval",
  "board-approval",
  "card",
  "signoff",
  "sign-off",
  "cto-ruling",
  "ceo-ruling",
] as const;

/** The whole allowlist: both halves, in one array, as the matchers below need it. */
const HUMAN_GATE_TOKEN_PREFIXES = [
  ...HOLD_PROTOCOL_TOKEN_PREFIXES,
  ...STANDING_HUMAN_GATE_TOKEN_PREFIXES,
] as const;

/**
 * Both the TS matcher and the SQL candidate predicate are generated from
 * `HUMAN_GATE_TOKEN_PREFIXES` rather than written twice. The two run in
 * different engines over the same contract, and a drift between them is
 * exactly the silent failure this module exists to stop: a prefix added here
 * but not there would be classified `human_gate` and never admitted to the
 * sweep, so it would read as supported and announce nothing.
 */
const HUMAN_GATE_TOKEN_ALTERNATION = HUMAN_GATE_TOKEN_PREFIXES.join("|");
const HUMAN_GATE_TOKEN_PATTERN = new RegExp(`^(${HUMAN_GATE_TOKEN_ALTERNATION})(:.*)?$`);

/**
 * Same shape, over the hold-protocol subset only. Deliberately a second
 * pattern rather than a membership test on the matched prefix: `hold` and
 * `hold-lift` are both in the list, so a longest-match question would have to
 * be answered by hand, and the alternation already answers it.
 */
const HOLD_PROTOCOL_TOKEN_PATTERN = new RegExp(
  `^(${HOLD_PROTOCOL_TOKEN_PREFIXES.join("|")})(:.*)?$`,
);

/**
 * The pull request a human-gate token names, in the two spellings the fleet
 * actually writes: `omar-go:#2686` (PEN-4475) and `hold:f35d6c:pr-2655:omar-go`
 * (PEN-2619). Both say the same thing — *a person must release pull request N*
 * — and which of the two a row uses is an accident of who armed the monitor.
 *
 * This is the join that was missing, and its absence is the whole of the
 * mis-ordering PEN-4545's review caught: without it the module cannot tell
 * `omar-go:#2686` sitting beside `pr:owner/repo#2686:merged` (the person gates
 * *this* pull request, so the wait is live while it is open and over once it
 * merges) from `omar-go:#2686` beside `pr:owner/repo#1281:merged` (unrelated
 * artifacts, so the machine half is genuinely outstanding).
 */
const HUMAN_GATE_SUBJECT_PATTERN = /(?:^|[:_-])(?:#|pr-|pr#)(\d{1,9})(?=$|[:_-])/g;

/**
 * Fail closed on anything ambiguous. A token naming two different numbers, or
 * none, yields `null` and every branch downstream then takes the behaviour it
 * had before this join existed — silence — rather than guessing which pull
 * request a person meant.
 */
export function parseHumanGateSubject(token: string): number | null {
  const found = new Set<number>();
  for (const match of token.matchAll(HUMAN_GATE_SUBJECT_PATTERN)) {
    const parsed = Number.parseInt(match[1]!, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) found.add(parsed);
  }
  return found.size === 1 ? [...found][0]! : null;
}

export type ParsedTerminalGateSignal =
  | { kind: "pull_request"; raw: string; repoFullName: string; prNumber: number; aspect: string }
  | {
      kind: "human_gate";
      raw: string;
      subjectPullRequestNumber: number | null;
      /**
       * True only for `HOLD_PROTOCOL_TOKEN_PREFIXES`. Gates the two inferences
       * the subject join feeds — "held open by this gate" and "discharged by
       * the merge" — neither of which holds for a standing human gate.
       */
      holdProtocol: boolean;
    }
  | { kind: "unresolvable"; raw: string };

export type TerminalGateVerdict =
  | {
      kind: "satisfied";
      signals: string[];
      mergedPullRequests: string[];
      /**
       * *Hold-protocol* gates discharged by the merge of the very pull
       * request they named — never a standing one, which can name a decision
       * due after the merge and so is reported rather than discharged. The
       * hold protocol these tokens encode is "do not merge until the go
       * arrives", so the merge is itself the evidence the go arrived —
       * and telling the owner to chase it would be asking for a decision
       * already made. Named in the comment so the inference is auditable
       * rather than silent.
       */
      dischargedHumanGates: string[];
    }
  /**
   * Nothing a re-check could change is outstanding, and what remains is a
   * person. That covers two shapes, and conflating them was the defect review
   * caught on #2974:
   *
   *   - every declared pull request merged and a human gate still stands; and
   *   - a declared pull request is *open because a human gate on this same
   *     issue holds it there* (`heldPullRequests`), which is the live wait in
   *     the hold-protocol shape and used to resolve to a silent
   *     `unresolved/pull_request_open`.
   *
   * Deliberately NOT `satisfied` in either shape: the issue's gate is not met,
   * so this must never suppress oversight or read as "go close this". It
   * exists to be *announced* — the row's owner is the one party who can
   * escalate the human gate, and before PEN-4545 nothing told them.
   */
  | {
      kind: "human_gate_only";
      signals: string[];
      humanGates: string[];
      /** Declared pull requests open because a listed human gate holds them. */
      heldPullRequests: string[];
      mergedPullRequests: string[];
    }
  | { kind: "unresolved"; reason: string; detail?: string };

export interface TerminalGateReconcileResult {
  scanned: number;
  resolved: number;
  /** Rows announced as waiting on a human and nothing else (PEN-4545). */
  humanGateOnly: number;
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
  if (!match) {
    // Classify before giving up. A human-gate token is no more *readable* than
    // any other unparseable one — the difference is that nobody on a timer can
    // ever clear it, which is a different disposition, not a weaker one.
    if (HUMAN_GATE_TOKEN_PATTERN.test(token)) {
      return {
        kind: "human_gate",
        raw: token,
        subjectPullRequestNumber: parseHumanGateSubject(token),
        holdProtocol: HOLD_PROTOCOL_TOKEN_PATTERN.test(token),
      };
    }
    return { kind: "unresolvable", raw: token };
  }
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
  return `${TERMINAL_GATE_RESOLVED_IDEMPOTENCY_PREFIX}${gateSignalDigest(signals)}`;
}

/** The digest every announcement key shares, so a re-arm invalidates all three at once. */
function gateSignalDigest(signals: readonly string[]) {
  const material = [...signals].sort().join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/**
 * Same digest over the same signal set, under the human-only prefix. Sharing
 * the digest across all three keys is deliberate: every announcement must be
 * invalidated by exactly the same event (a monitor re-armed on different
 * gates), and the SQL anti-join computes that digest once for all of them.
 */
export function terminalGateHumanOnlyIdempotencyKey(signals: readonly string[]) {
  return `${TERMINAL_GATE_HUMAN_ONLY_IDEMPOTENCY_PREFIX}${gateSignalDigest(signals)}`;
}

/**
 * Same digest again, under the held-open prefix. See
 * `TERMINAL_GATE_HELD_IDEMPOTENCY_PREFIX` for why this finding cannot share a
 * key with the terminal one: it is provisional, and the event that ends it is
 * invisible to the database.
 */
export function terminalGateHeldIdempotencyKey(signals: readonly string[]) {
  return `${TERMINAL_GATE_HELD_IDEMPOTENCY_PREFIX}${gateSignalDigest(signals)}`;
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
 * The monitor's declared bounds, in the shape `exhaustedMonitorClearReason` reads.
 *
 * Read off `executionState.monitor` — where `monitorMetadataFromPolicy`
 * (issue-execution-policy.ts) copies them at arm time — rather than re-parsing
 * `executionPolicy` with `normalizeIssueExecutionPolicy`. That helper *throws*
 * on a policy it cannot parse, which on this sweep would abort the whole pass
 * over one malformed row; this module fails closed per row everywhere else
 * (see the CASE expression in `listCandidateIssues` for the same reasoning).
 * Anything unreadable here therefore reads as "no bound declared", which is the
 * same verdict the bound-less majority already gets.
 */
export function readIssueMonitorBounds(
  executionState: unknown,
): { timeoutAt: string | null; maxAttempts: number | null } {
  const monitor =
    executionState && typeof executionState === "object"
      ? (executionState as { monitor?: unknown }).monitor
      : null;
  if (!monitor || typeof monitor !== "object") return { timeoutAt: null, maxAttempts: null };
  const { timeoutAt, maxAttempts } = monitor as { timeoutAt?: unknown; maxAttempts?: unknown };
  return {
    timeoutAt: typeof timeoutAt === "string" ? timeoutAt : null,
    maxAttempts: typeof maxAttempts === "number" ? maxAttempts : null,
  };
}

/**
 * Re-read every declared gate and decide whether the issue's terminal gate is
 * satisfied. Fail-closed at every branch: any token this module cannot parse,
 * any PR it cannot read, and any PR that is not merged leaves the issue
 * unresolved. `readPullRequestGate` is called at most once per distinct PR.
 *
 * PEN-4545 adds one verdict between "satisfied" and "unresolved" —
 * `human_gate_only`, for a gate set whose machine half is fully satisfied and
 * whose remainder is a person. It does not weaken any fail-closed rule: such an
 * issue is still *not* satisfied, and is reported under its own verdict rather
 * than folded into the satisfied path.
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
  const humanGates: Array<Extract<ParsedTerminalGateSignal, { kind: "human_gate" }>> = [];
  for (const signal of signals) {
    const gate = parseTerminalGateSignal(signal);
    if (gate?.kind === "human_gate") {
      humanGates.push(gate);
      continue;
    }
    if (!gate || gate.kind !== "pull_request") {
      // One signal we cannot interpret means the issue is still waiting on
      // something outside this module's view. Never partially resolve. This
      // runs to completion before any read, so an unresolvable token still
      // costs zero network calls.
      return { kind: "unresolved", reason: "unresolvable_signal", detail: signal };
    }
    parsed.push(gate);
  }

  // Join each human gate to the declared pull request it names. A bare
  // `#2686` carries no repository, so a number two different repos both
  // declare is ambiguous; such a gate is left unjoined and every branch below
  // then behaves exactly as it did before this join existed.
  const declaredKeysByNumber = new Map<number, Set<string>>();
  for (const gate of parsed) {
    const keys = declaredKeysByNumber.get(gate.prNumber) ?? new Set<string>();
    keys.add(pullRequestKey(gate.repoFullName, gate.prNumber));
    declaredKeysByNumber.set(gate.prNumber, keys);
  }
  /**
   * Hold-protocol token -> the one declared pull request it unambiguously
   * names. Restricted to the hold protocol because the join's only two
   * consumers are inferences that subset alone licenses: a non-hold gate
   * naming a pull request establishes neither that the pull request is open
   * *because of it* nor that its merge discharges the gate. See
   * `HOLD_PROTOCOL_TOKEN_PREFIXES`.
   */
  const subjectKeyByGate = new Map<string, string>();
  /** The inverse: a declared pull request -> the hold-protocol gates holding it. */
  const gatedPullRequestKeys = new Set<string>();
  for (const gate of humanGates) {
    if (!gate.holdProtocol) continue;
    if (gate.subjectPullRequestNumber == null) continue;
    const keys = declaredKeysByNumber.get(gate.subjectPullRequestNumber);
    if (!keys || keys.size !== 1) continue;
    const key = [...keys][0]!;
    subjectKeyByGate.set(gate.raw, key);
    gatedPullRequestKeys.add(key);
  }

  const cache = input.gateCache ?? new Map<string, PullRequestGateResult>();
  const merged = new Set<string>();
  /**
   * Open, and open *because* a human gate on this issue holds it. Collecting
   * these rather than returning at the first one is the only place this costs
   * an extra read, and it is bounded to rows that declare a human gate naming
   * a declared pull request — a row with no human gate still short-circuits on
   * its first open pull request exactly as before.
   */
  const heldOpen = new Set<string>();
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
      // An open pull request a declared human gate names is not an outstanding
      // machine gate — it is the human wait itself, wearing a `pr:` token.
      // Before this branch that row resolved to `unresolved/pull_request_open`
      // and was skipped in silence for the entire time it was blocked on a
      // person, and the notice arrived only after the merge, by which point it
      // was telling the owner to chase a go that had necessarily already
      // arrived. A *closed-unmerged* pull request is excluded deliberately:
      // the work did not land, which is not a thing to announce as "a person
      // is holding this open".
      if (result.state !== "closed" && gatedPullRequestKeys.has(key)) {
        heldOpen.add(key);
        continue;
      }
      return {
        kind: "unresolved",
        reason: result.state === "closed" ? "pull_request_closed_unmerged" : "pull_request_open",
        detail: key,
      };
    }
    merged.add(key);
  }

  // Reached when every declared pull request either merged or is held open by
  // a hold-protocol gate on this issue. A *hold-protocol* gate whose named
  // pull request merged is discharged — the merge cannot precede the go, so
  // the merge is the evidence the go arrived. Nothing else is: a standing
  // human gate (`signoff:`, `approval:`, `card:`, `*-ruling:`) can name a
  // decision due *after* the merge, so `subjectKeyByGate` never holds one and
  // it survives its pull request landing. Anything that still stands means
  // the issue is not satisfied but is also not *waiting on anything a
  // re-check could change*, which is the distinction worth announcing.
  const standingHumanGates: string[] = [];
  const dischargedHumanGates: string[] = [];
  for (const gate of humanGates) {
    const subjectKey = subjectKeyByGate.get(gate.raw);
    if (subjectKey && merged.has(subjectKey)) dischargedHumanGates.push(gate.raw);
    else standingHumanGates.push(gate.raw);
  }

  // Every held-open pull request is held by a hold-protocol gate naming it,
  // and such a gate is discharged only by that pull request's *merge*, so it
  // necessarily still stands here: a non-empty `heldOpen` always lands below.
  if (standingHumanGates.length > 0) {
    return {
      kind: "human_gate_only",
      signals,
      humanGates: standingHumanGates.sort(),
      heldPullRequests: [...heldOpen].sort(),
      mergedPullRequests: [...merged].sort(),
    };
  }

  return {
    kind: "satisfied",
    signals,
    mergedPullRequests: [...merged].sort(),
    dischargedHumanGates: dischargedHumanGates.sort(),
  };
}

export function buildTerminalGateResolvedComment(input: {
  signals: readonly string[];
  mergedPullRequests: readonly string[];
  /**
   * Human gates discharged by the merge of the pull request they named. Spelt
   * out in the comment because it is an *inference* — merge implies the go,
   * under the hold protocol these tokens encode — and an inference a reader
   * cannot see is one nobody can check.
   */
  dischargedHumanGates?: readonly string[];
  /**
   * The monitor's pending first check, for a row admitted by the never-polled
   * arm (BLO-36289). Non-null means the monitor is **armed** — it has a live
   * wake path and simply has not reached its first check — which is the
   * opposite of the stranded case this module was built for.
   *
   * The branch is not cosmetic. This comment is system-authored and read by
   * agents deciding whether a row is stranded, and the documented repair for a
   * stranded row *destroys* the wake path it already had. Asserting "nothing is
   * polling it" over an armed monitor is the same false signal as the
   * 86%-false-positive strand detector, so the two populations must not share
   * copy.
   */
  armedNextCheckAt?: Date | null;
}) {
  const armed = input.armedNextCheckAt != null;
  const prLines = input.mergedPullRequests.map((pr) => `- \`${pr}\` — **merged**`).join("\n");
  const signalLines = input.signals.map((signal) => `\`${signal}\``).join(", ");
  const discharged = input.dischargedHumanGates ?? [];
  return [
    armed
      ? "**Terminal gate resolved — this issue's gate was already satisfied when its monitor was armed.**"
      : "**Terminal gate resolved — this issue's monitor gate is satisfied, but nothing is polling it.**",
    "",
    armed
      ? `The monitor is armed and scheduled; its first check is not due until \`${input.armedNextCheckAt!.toISOString()}\`. A board-side re-read finds the declared gate already satisfied, so that wait buys nothing:`
      : "The monitor stopped re-checking (converged to a stall, was cleared, or its run was killed) while its declared gate was still unsatisfied. A board-side re-read now finds it satisfied:",
    "",
    prLines,
    "",
    ...(discharged.length > 0
      ? [
          "This issue also declared a human gate naming one of those pull requests. A hold of that shape cannot be merged through until the go arrives, so the merge is itself the record that it did — there is nothing left to chase:",
          "",
          ...discharged.map(
            (gate) => `- \`${gate}\` — **discharged** by the merge of the pull request it names`,
          ),
          "",
        ]
      : []),
    `Declared gate signals: ${signalLines}`,
    "",
    armed
      ? "No run was dispatched to produce this — re-reading a pull request is one API call, and waking an agent to do it is not. Nothing here closes the issue: a merged gate proves the gate resolved, not that the acceptance criteria are met. Verify the acceptance criteria against the merged artifact and close. **The monitor is still armed, so this issue has a live wake path — do not treat it as stranded and do not repair it as one.**"
      : "No run was dispatched to produce this — re-reading a pull request is one API call, and waking an agent to do it is not. Nothing here closes the issue: a merged gate proves the gate resolved, not that the acceptance criteria are met. Verify the acceptance criteria against the merged artifact and close, or re-arm the monitor on whatever is genuinely still outstanding.",
    "",
    "_Posted by the terminal-gate reconciler (BLO-27515)._",
  ].join("\n");
}

/**
 * The human-gate announcement (PEN-4545).
 *
 * Says one thing the row cannot say for itself: *the waiting is over as far as
 * any machine is concerned, and the remainder is a person who does not know
 * this row exists.* It names the gate tokens verbatim so the owner can escalate
 * the specific ask, and it states plainly that a re-check will return the same
 * answer forever — because an armed `monitorNextCheckAt` is exactly what made
 * these rows read as attended while nothing could move them.
 *
 * It does not close, clear, dispatch, or file a card. Picking the escalation
 * route is the owner's call: a card, a named owner on the row, or accepting the
 * row as frozen are all correct answers depending on the ask, and guessing
 * between them from here would be the "detector with nobody to tell" failure
 * one level further out.
 */
export function buildTerminalGateHumanOnlyComment(input: {
  signals: readonly string[];
  humanGates: readonly string[];
  /**
   * Declared pull requests that are open *because* one of `humanGates` holds
   * them there. This is the live wait in the hold-protocol shape, and the
   * notice has to read differently for it: the go has not arrived, so chasing
   * it is exactly right — whereas the same words after the merge were telling
   * the owner to chase a decision already made.
   */
  heldPullRequests?: readonly string[];
  mergedPullRequests: readonly string[];
  /** See `buildTerminalGateResolvedComment` — same armed/stranded distinction, same reason. */
  armedNextCheckAt?: Date | null;
}) {
  const armed = input.armedNextCheckAt != null;
  const humanLines = input.humanGates.map((gate) => `- \`${gate}\` — **waiting on a person**`);
  const prLines = input.mergedPullRequests.map((pr) => `- \`${pr}\` — merged`);
  const held = input.heldPullRequests ?? [];
  const heldLines = held.map((pr) => `- \`${pr}\` — **open, and held open by the gate below**`);
  // With no PR gates declared, "every machine-checkable gate is satisfied" is
  // vacuously true and reads as a claim about landed work that nothing here
  // checked. Say what was actually established instead: the declared gate is
  // a person, start to finish.
  const anyMachineGate = prLines.length > 0;
  const anyHeld = heldLines.length > 0;
  return [
    anyHeld
      ? "**Human gate — a pull request this issue declares is open because a person has not released it. That wait is the whole of the gate.**"
      : anyMachineGate
        ? "**Human gate — every machine-checkable gate on this issue is satisfied; what is left is a person.**"
        : "**Human gate — every gate this issue declares names a person. Nothing here is machine-checkable.**",
    "",
    ...(anyHeld
      ? [
          "A board-side re-read finds these declared pull requests still open — not because work or CI is outstanding, but because a human gate declared on this same issue names them:",
          "",
          ...heldLines,
          "",
        ]
      : []),
    ...(anyMachineGate
      ? [
          anyHeld
            ? "The other declared pull-request gates are already satisfied:"
            : "A board-side re-read finds the declared pull-request gates already satisfied:",
          "",
          ...prLines,
          "",
        ]
      : []),
    anyMachineGate || anyHeld
      ? "The remaining declared gates name a human decision, which nothing on a timer can clear:"
      : "The declared gates name a human decision, which nothing on a timer can clear:",
    "",
    ...humanLines,
    "",
    `Declared gate signals: ${input.signals.map((signal) => `\`${signal}\``).join(", ")}`,
    "",
    armed
      ? `The monitor is armed and its next check is due \`${input.armedNextCheckAt!.toISOString()}\`. That check will return this same answer: polling cannot move a human gate, and three unchanged re-checks converge to a stall (BLO-18294). **The monitor still gives this issue a live wake path — do not treat it as stranded and do not repair it as one** — but the wake has no gate left to read.`
      : "The monitor has stopped re-checking (converged to a stall, was cleared, or its run was killed). Nothing is scheduled to look at this issue again, and the gate it stopped on is one no re-check could ever have cleared.",
    "",
    anyHeld
      ? "**This is not a resolution and nothing here closes the issue.** It is the notice that the pull request is waiting on a person and nothing else, which is the one thing an armed monitor makes invisible: the row reads as attended on every dashboard while no mechanism on the owner's side can answer. Escalate the ask — extend a pending approval card, record a named owner and the exact action on the row, or accept the row as frozen and stop re-checking — rather than re-arming against the same gate. Once the named pull request merges this gate is discharged: no further notice will ask you to chase it, and the sweep posts the verify-and-close notice instead."
      : anyMachineGate
      ? "**This is not a resolution and nothing here closes the issue.** It is the notice that the wait is now entirely on a named human, which is the one thing an armed monitor makes invisible: the row reads as attended on every dashboard while no mechanism on the owner's side can answer. Escalate the ask — extend a pending approval card, record a named owner and the exact action on the row, or accept the row as frozen and stop re-checking — rather than re-arming against the same gate."
      : "**This is not a resolution, says nothing about whether the work is finished, and nothing here closes the issue.** No pull-request gate was declared, so this notice is only about the gate: it is one a person must clear, which is the thing an armed monitor makes invisible — the row reads as attended on every dashboard while no mechanism on the owner's side can answer. Escalate the ask — extend a pending approval card, record a named owner and the exact action on the row, or accept the row as frozen and stop re-checking — rather than re-arming against the same gate.",
    "",
    "_Posted by the terminal-gate reconciler (PEN-4545)._",
  ].join("\n");
}

/**
 * `terminalGateResolutionIdempotencyKey`'s digest, computed in SQL so the
 * already-announced anti-join can test the *exact* current signal set rather
 * than approximating it.
 *
 * Why an exact key and not a timestamp: the previous form correlated a
 * `terminal-gate-resolved:%` prefix match against `created_at >=
 * issues.updated_at`. Migration `0076`'s AFTER INSERT trigger on
 * `issue_comments` bumps `last_activity_at` only — never `updated_at` — so the
 * announcement suppressed the row until any *later* write (a restore sweep
 * flipping `blocked`->`todo`, a priority or assignee change) advanced
 * `updated_at` past the comment. That inverted the comparison permanently: the
 * row became a candidate on every pass, could never be re-announced (the exact
 * key filter drops it, and the idempotency index would reject the insert), and
 * so camped on a SCAN_LIMIT slot forever. `updatedAt ASC` ages those rows to
 * the front, so they starve real candidates. The timestamp could not simply be
 * dropped either — a monitor re-armed on *new* signals yields a new key and
 * must stay re-announceable, which a bare prefix match would forbid.
 *
 * Mirrors the TS: sha256 over the distinct signals sorted and joined by "\n",
 * lowercase hex, first 32 chars. The separator is `chr(10)` rather than an
 * `E'\n'` literal on purpose — this is a JS template literal, so a backslash-n
 * written here would be collapsed to a real newline before PostgreSQL ever
 * parsed it. `chr(10)` means the same thing at both layers.
 *
 * `collate "C"` is load-bearing for the same reason: the TS sorts with JS
 * `.sort()`, i.e. code-unit order, while a bare `order by` sorts under the
 * database collation. Those agree under `C`/`C.UTF-8` and for most token pairs
 * under glibc, but a non-`C` collation weights punctuation below alphanumerics,
 * so a pair differing in punctuation position can sort oppositely
 * (`deploy:paperclip-zzz` vs `deploy:paperclipapi`). The consequence is not a
 * missed announcement — the digests differ, the row is admitted and the JS key
 * filter drops it — but a permanently-consumed SCAN_LIMIT slot, which is the
 * starvation vector this anti-join exists to remove, reached through a narrower
 * door. No fixture can discriminate this on a `C`-collation test database,
 * which is exactly why it has to be pinned here rather than asserted.
 *
 * The pin does not make the two orders identical, and this enumeration would
 * read as exhaustive if that were left unsaid: `collate "C"` is code-point
 * order while JS `.sort()` is UTF-16 code-unit order, and those diverge above
 * the BMP — a U+10000+ character leads with a high surrogate (0xD800..0xDBFF),
 * so it sorts before U+E000..U+FFFF in JS and after in PostgreSQL.
 * `normalizeGateToken` does not constrain the charset, so an emoji or a
 * supplementary-plane CJK character in a gate token reaches both sorts.
 * Deliberately not closed: the consequence is the same wasted window slot
 * described above, not a missed announcement, and a real gate token is
 * `pr:owner/repo#123:merged`.
 *
 * `normalizeIssueMonitorGateSignals` already
 * lowercases, trims and sorts on write (issue-execution-policy.ts), so the
 * stored array is in that form and no normalization is restated here. If a
 * legacy row's stored form ever disagrees, the digests differ, the row is
 * *admitted* and the authoritative JS key filter drops it — degrading to a
 * wasted window slot, never to a missed announcement. The `scanned` assertions
 * in the reconciler tests fail if this drifts from the TS.
 *
 * The CASE is the same guard as the candidate predicate above, for the same
 * reason: PostgreSQL does not promise to evaluate this conjunct only after its
 * neighbour, so `jsonb_array_elements_text` must not see a malformed
 * object/scalar `gateSignals` — that raises and aborts the whole pass.
 */
const gateSignalDigestSql = sql`substr(encode(sha256(convert_to((
  select coalesce(string_agg(distinct signal collate "C", chr(10) order by signal collate "C"), '')
  from jsonb_array_elements_text(
    case when jsonb_typeof(${issues.executionState} -> 'monitor' -> 'gateSignals') = 'array'
      then ${issues.executionState} -> 'monitor' -> 'gateSignals'
      else '[]'::jsonb end
  ) as t(signal)
), 'UTF8')), 'hex'), 1, 32)`;

/**
 * "Does this row declare at least one human-gate signal?", in SQL (PEN-4545).
 *
 * Generated from `HUMAN_GATE_TOKEN_PREFIXES`, the same array behind
 * `HUMAN_GATE_TOKEN_PATTERN`, so the two matchers cannot drift. The prefixes
 * are a fixed literal list of `[a-z-]` tokens, so the interpolated alternation
 * carries no user input and nothing needs escaping; a prefix containing a
 * regex metacharacter would break this, which is why the list is `as const`
 * and not configuration.
 *
 * The POSIX `~` pattern mirrors the JS regex exactly, including the optional
 * `:suffix`, so `cardinality` does not match `card` and `approvals` does not
 * match `approval`.
 *
 * `btrim` because `parseTerminalGateSignal` classifies `raw.trim()`. Without
 * it a signal stored with surrounding whitespace classifies as `human_gate` in
 * TS and is never admitted here — fail-closed, but precisely the drift the
 * shared array exists to prevent. `normalizeIssueMonitorGateSignals` trims on
 * write, so this only covers a legacy or hand-edited row; that is the case
 * worth covering, since it is the one nobody would think to check.
 *
 * Wrapped in the same `CASE` as the other JSONB predicates, for the same
 * reason: PostgreSQL does not promise to evaluate a conjunct only after its
 * neighbour, so `jsonb_array_elements_text` must never see a malformed
 * object/scalar `gateSignals` — that raises and aborts the whole pass rather
 * than skipping the one bad row.
 */
const humanGateSignalExistsSql = sql`case
  when jsonb_typeof(${issues.executionState} -> 'monitor' -> 'gateSignals') = 'array'
    then exists (
      select 1
      from jsonb_array_elements_text(${issues.executionState} -> 'monitor' -> 'gateSignals') as t(signal)
      where btrim(t.signal) ~ ${`^(${HUMAN_GATE_TOKEN_ALTERNATION})(:.*)?$`}
    )
  else false end`;

type CandidateRow = {
  id: string;
  companyId: string;
  identifier: string | null;
  executionState: unknown;
  /**
   * Non-null means the monitor has a next check scheduled. Before PEN-4545
   * that implied "admitted by the never-polled arm"; the human-gate arm also
   * admits actively-polling rows, so it no longer does. Armed only if it can
   * also fire — see `armedMonitorNextCheckAt`.
   */
  monitorNextCheckAt: Date | null;
  /** Real attempt count. The human-gate arm admits rows where this is > 0. */
  monitorAttemptCount: number | null;
  /** The scheduler's eligibility tuple (`issueAllowsMonitor`); this query does not filter on it. */
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

/**
 * Issues whose monitor declared gates and is either no longer polling or has
 * not polled yet.
 *
 * Deliberately NOT restricted to `in_progress`/`in_review`. A monitor can only
 * be *armed* on those statuses, but the population this exists for is precisely
 * the one an outage moved to `blocked` (and a restore sweep then moved to
 * `todo`) with the monitor state left behind in the JSONB. Restricting to the
 * armable statuses would exclude the worked example that motivated this module.
 *
 * ## Why the never-polled arm exists (BLO-36289)
 *
 * `monitorNextCheckAt IS NULL` alone means "polling stopped", so a monitor
 * armed on a gate that was *already satisfied at arm time* was invisible here
 * until its whole window elapsed. Worked example: BLO-28908's monitor was armed
 * at 02:00 with `notes: "checks=pending, review=none"` while both check runs had
 * finished at 01:12:50Z — 47 minutes earlier. It waited a full day and cleared
 * `timeout_exceeded`.
 *
 * `attemptCount = 0 AND lastTriggeredAt IS NULL` is "armed and never evaluated",
 * which is exactly that population and no more. It is self-limiting: a row
 * leaves the set the first time the monitor fires, and leaves it earlier if the
 * gate resolves (the announcement anti-join above drops it). Re-arming preserves
 * `attemptCount`, so a re-armed monitor is not readmitted — deliberate, since
 * the harm being closed is the *first* window, and readmitting every re-arm is
 * the unbounded variant BLO-29856 rejected.
 *
 * Cost, measured 2026-09-25 against the live fleet rather than estimated: 47
 * armed monitors, of which 9 never-triggered. All 9 declare gates; 8 declare at
 * least one token `parseTerminalGateSignal` cannot parse (`mq:`, `heap:`,
 * `argo:`, `approval:`, `cron:`, `insync:`, `deploy:`, `cto-ruling:`), and
 * `resolveTerminalGate` runs its parse loop to completion *before* its read
 * loop, so those cost zero network calls. Added GitHub reads per pass: **1**
 * (`blockcast/onprem-k8s#3823`, deduped per pass by `gateCache`).
 *
 * ⚠ That census predates PEN-4545 and its bottom line has moved. Two of the
 * eight prefixes it counts as free — `approval:` and `cto-ruling:` — are now
 * classified `human_gate` rather than `unresolvable`, so a row declaring one
 * no longer bails at parse time: it reads its PR tokens like any other
 * candidate. The parse-before-read ordering is unchanged and still makes a
 * genuinely unparseable token free, so the increase is confined to the
 * human-gate class, bounded by `MAX_PULL_REQUEST_READS_PER_PASS` and deduped
 * per pass by `gateCache`. The "**1** added read per pass" figure should be
 * re-measured before it is cited again.
 *
 * No network call is added to `PATCH /api/issues/{id}` — the evaluation stays
 * here, on the sweep, off the monitor-write transaction.
 */
async function listCandidateIssues(
  db: Pick<Db, "select">,
  limit: number,
  /**
   * A held-open announcement older than this stops suppressing its row, so
   * the sweep re-reads the pull request and can post the post-merge notice.
   * See `HELD_GATE_RECHECK_INTERVAL_MS`.
   */
  heldRecheckCutoff: Date,
): Promise<CandidateRow[]> {
  return db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      executionState: issues.executionState,
      monitorNextCheckAt: issues.monitorNextCheckAt,
      monitorAttemptCount: issues.monitorAttemptCount,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
    })
    .from(issues)
    .where(and(
      notInArray(issues.status, ["done", "cancelled"]),
      // Three arms. The first two are "the monitor is not polling": terminated,
      // or armed and not yet evaluated.
      //
      // The third (PEN-4545) is the opposite population and is the whole point
      // of that fix: a monitor that IS actively re-checking, on a gate only a
      // human can clear. Those rows have `monitorAttemptCount > 0` and a future
      // `monitorNextCheckAt`, so the first two arms exclude them by
      // construction — and they are precisely the six rows PEN-4545 measured,
      // the ones that "politely re-check a gate on a timer while nothing on the
      // owner's side can ever answer". Without this arm the notice would fire
      // only before the first poll or after the monitor had already converged
      // to a stall (~3 polls later, BLO-18294), i.e. only once the row was
      // already stranded — never in the "reads as actively attended" state that
      // is the reported defect.
      //
      // It is narrow by construction: it admits a row only when a stored gate
      // signal matches the human-gate allowlist, so an actively-polling row
      // with only `pr:`/`deploy:`/`mq:` gates is not readmitted and its polling
      // cadence is untouched. Re-announcement is bounded by the anti-join
      // below, once per signal set. The cost it does add is a PR read per pass
      // for an actively-polling human-gate row whose PRs have not all merged
      // (it reaches `resolveTerminalGate` and fails closed there); that is
      // bounded by `MAX_PULL_REQUEST_READS_PER_PASS` and deduped by `gateCache`.
      //
      // ⚠ Known, accepted, and worth re-reading if the class grows: such a row
      // is never announced, so the anti-join never retires it, and under
      // `updatedAt ASC` the oldest of them sit at the head of both the
      // `SCAN_LIMIT` window and the read budget — ahead of the stranded
      // population this module was built for. A *held-open* row joins that
      // head of the list too, but only once per `HELD_GATE_RECHECK_INTERVAL_MS`
      // rather than on every pass, which is the whole reason that interval
      // exists instead of a plain re-admission. That is the same starvation
      // shape the anti-join's own comment describes, reached by a row that is
      // legitimately unresolvable rather than by a bookkeeping bug. At the six
      // rows PEN-4545 measured it is noise. If this class reaches a scale
      // where it can crowd out the other two arms, give it its own share of
      // the budget or order it last, rather than widening the caps.
      sql`(${issues.monitorNextCheckAt} is null
            or (${issues.monitorAttemptCount} = 0 and ${issues.monitorLastTriggeredAt} is null)
            or ${humanGateSignalExistsSql})`,
      visibleIssueCondition(),
      // One CASE, not two ANDed predicates: PostgreSQL does not promise to
      // evaluate a WHERE conjunct only after its neighbour, so a separate
      // `jsonb_typeof(...) = 'array'` guard does not stop the planner from
      // calling `jsonb_array_length` on a malformed object/scalar `gateSignals`
      // — and that raises, aborting the whole pass rather than skipping the one
      // bad row. CASE is the documented construct that does guarantee it.
      sql`case when jsonb_typeof(${issues.executionState} -> 'monitor' -> 'gateSignals') = 'array'
            then jsonb_array_length(${issues.executionState} -> 'monitor' -> 'gateSignals')
            else 0 end > 0`,
      // The two terminal findings retire a row for good; the provisional
      // held-open one retires it only until `heldRecheckCutoff`. Expressing
      // that as one `not exists` with an OR rather than two is deliberate:
      // the row must stay out of the window while ANY suppressing
      // announcement applies, and a second `not exists` would have to repeat
      // the whole correlated subquery and its digest.
      sql`not exists (
        select 1 from issue_comments resolved_comment
        where resolved_comment.issue_id = ${issues.id}
          and (
            resolved_comment.idempotency_key in (
              ${TERMINAL_GATE_RESOLVED_IDEMPOTENCY_PREFIX}::text || ${gateSignalDigestSql},
              ${TERMINAL_GATE_HUMAN_ONLY_IDEMPOTENCY_PREFIX}::text || ${gateSignalDigestSql}
            )
            or (
              resolved_comment.idempotency_key
                = ${TERMINAL_GATE_HELD_IDEMPOTENCY_PREFIX}::text || ${gateSignalDigestSql}
              and resolved_comment.created_at > ${heldRecheckCutoff.toISOString()}::timestamptz
            )
          )
          and resolved_comment.author_agent_id is null
          and resolved_comment.author_user_id is null
          and resolved_comment.deleted_at is null
      )`,
    ))
    .orderBy(issues.updatedAt, issues.id)
    .limit(limit);
}

/**
 * Announcement keys already recorded for these issues, with the time each was
 * posted, so each finding is reported once per signal set. Callers pass every
 * key an issue could be suppressed by — resolved, human-only and held-open —
 * because any of them means this signal set has already been announced.
 *
 * The timestamp is returned rather than folded into a boolean here because
 * only one of the three keys is time-bounded, and the caller is the layer that
 * knows which: see `HELD_GATE_RECHECK_INTERVAL_MS`.
 */
async function listExistingResolutionKeys(
  db: Pick<Db, "select">,
  candidates: Array<{ id: string; key: string }>,
): Promise<Map<string, Date>> {
  if (candidates.length === 0) return new Map();
  const rows = await db
    .select({
      issueId: issueComments.issueId,
      idempotencyKey: issueComments.idempotencyKey,
      createdAt: issueComments.createdAt,
    })
    .from(issueComments)
    .where(and(
      inArray(issueComments.issueId, candidates.map((c) => c.id)),
      inArray(issueComments.idempotencyKey, candidates.map((c) => c.key)),
      isNull(issueComments.authorAgentId),
      isNull(issueComments.authorUserId),
      isNull(issueComments.deletedAt),
    ));
  return new Map(
    rows.map((row) => [`${row.issueId}\u0000${row.idempotencyKey ?? ""}`, row.createdAt]),
  );
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
  //
  // The `kind === "pull_request"` test is also what keeps a `human_gate` token
  // (PEN-4545) out of this map, and that is load-bearing rather than
  // incidental. A human-only announcement states the issue is *not* resolved
  // and is waiting on a person who has not been told — the case where
  // oversight is most warranted, not least. It is also keyed under its own
  // prefix, so the lookup below cannot match it even if this filter changed.
  // Do not relax either guard to "every gate this module understands".
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
    `${row.issueId}\u0000${row.idempotencyKey ?? ""}`,
    row.createdAt,
  ]));
  const resolved = new Map<string, { signals: string[]; idempotencyKey: string; createdAt: Date }>();
  for (const entry of ownedKeyed) {
    const createdAt = existing.get(`${entry.id}\u0000${entry.key}`);
    if (!createdAt) continue;
    resolved.set(entry.id, { signals: entry.signals, idempotencyKey: entry.key, createdAt });
  }
  return resolved;
}

/**
 * The monitor's next check when — and only when — that check is a wake that
 * will actually happen. `null` means "treat this row as stranded".
 *
 * Only a check still in the FUTURE is a live wake path. A non-null
 * `monitorNextCheckAt` here always means the row came in via the never-polled
 * arm (the other arm requires it to be null), but an *overdue* first check is
 * by definition a wake that did not happen — so claiming "live wake path, do
 * not treat as stranded" over it would be the mirror of the false signal this
 * branch exists to avoid. The stranded copy, including its re-arm advice, is
 * the true one there.
 *
 * A future check is necessary but not sufficient, on two independent counts.
 * First, the scheduler only ever selects rows `issueAllowsMonitor` admits, and
 * `listCandidateIssues` admits every status but done/cancelled by design (the
 * blocked -> todo restore population). Second, selection is not the same
 * question as whether the monitor has any road left:
 * `exhaustedMonitorClearReason` returns `timeout_exceeded` off `timeoutAt`
 * alone, and nothing constrains `nextCheckAt <= timeoutAt` — "check in 6h, give
 * up after 2h" arms fine, and the scheduler's next evaluation clears it rather
 * than firing it. Either way a future check is a wake that will never happen,
 * so it gets the stranded copy too.
 *
 * The row's REAL `monitorAttemptCount` is passed, not a literal `0`. Before
 * PEN-4545 the two were the same thing — a non-null `monitorNextCheckAt` could
 * only have come in via the never-polled arm, whose predicate *is*
 * `monitorAttemptCount = 0` — but the human-gate arm admits actively-polling
 * rows, where hardcoding `0` would under-report `max_attempts_exhausted` and
 * promise a live wake path to a monitor that has none. `defaultMaxAttempts`
 * stays omitted: an issue-level `maxAttempts` is a declared bound this module
 * should honour, while the scheduler's fleet-wide ceiling is its own business.
 */
function armedMonitorNextCheckAt(candidate: CandidateRow, now: Date): Date | null {
  if (candidate.monitorNextCheckAt === null) return null;
  if (candidate.monitorNextCheckAt.getTime() <= now.getTime()) return null;
  if (!issueAllowsMonitor(candidate.status, candidate.assigneeAgentId, candidate.assigneeUserId)) {
    return null;
  }
  const exhausted = exhaustedMonitorClearReason({
    monitor: readIssueMonitorBounds(candidate.executionState),
    attemptCount: candidate.monitorAttemptCount ?? 0,
    now,
  });
  return exhausted === null ? candidate.monitorNextCheckAt : null;
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

  const heldRecheckCutoff = new Date(now.getTime() - HELD_GATE_RECHECK_INTERVAL_MS);
  const candidates = await listCandidateIssues(
    db,
    Math.max(1, options.scanLimit ?? SCAN_LIMIT),
    heldRecheckCutoff,
  );
  if (candidates.length === 0) {
    return { scanned: 0, resolved: 0, humanGateOnly: 0, pullRequestReads: 0 };
  }

  const withSignals = candidates
    .map((candidate) => ({ candidate, signals: readIssueMonitorGateSignals(candidate.executionState) }))
    .filter((entry) => entry.signals.length > 0)
    .map((entry) => ({
      ...entry,
      key: terminalGateResolutionIdempotencyKey(entry.signals),
      humanOnlyKey: terminalGateHumanOnlyIdempotencyKey(entry.signals),
      heldKey: terminalGateHeldIdempotencyKey(entry.signals),
    }));

  // Drop anything already announced — under any of the three findings — before
  // spending a single API call. This mirrors the SQL anti-join exactly,
  // including the held key's cutoff: the SQL is the cheap filter and this is
  // the authoritative one, and a disagreement between them would either
  // re-announce or silently starve.
  const alreadyResolved = await listExistingResolutionKeys(
    db,
    withSignals.flatMap((entry) => [
      { id: entry.candidate.id, key: entry.key },
      { id: entry.candidate.id, key: entry.humanOnlyKey },
      { id: entry.candidate.id, key: entry.heldKey },
    ]),
  );
  const pending = withSignals.filter((entry) => {
    if (alreadyResolved.has(`${entry.candidate.id}\u0000${entry.key}`)) return false;
    if (alreadyResolved.has(`${entry.candidate.id}\u0000${entry.humanOnlyKey}`)) return false;
    // Provisional: a held-open announcement suppresses its row only until the
    // cutoff, so the merge of the pull request it named can still be seen.
    const heldAt = alreadyResolved.get(`${entry.candidate.id}\u0000${entry.heldKey}`);
    return !(heldAt && heldAt.getTime() > heldRecheckCutoff.getTime());
  });
  if (pending.length === 0) {
    return { scanned: candidates.length, resolved: 0, humanGateOnly: 0, pullRequestReads: 0 };
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
  let humanGateOnly = 0;
  let readCapped = 0;
  for (const entry of pending) {
    if (!dependencyReady.has(entry.candidate.id)) continue;

    const verdict = await resolveTerminalGate({
      gateSignals: entry.signals,
      readPullRequestGate,
      gateCache,
      maxPullRequestReads: maxReads,
    });
    if (verdict.kind === "unresolved") {
      if (verdict.reason === "pull_request_read_cap") readCapped += 1;
      continue;
    }

    const armedNextCheckAt = armedMonitorNextCheckAt(entry.candidate, now);
    const isHumanOnly = verdict.kind === "human_gate_only";
    // Three findings, three keys. A held-open row re-admitted past its cutoff
    // and still held lands back here, conflicts on the held key, and inserts
    // nothing — so the re-check costs a pull-request read and never a second
    // comment. Once that pull request merges the verdict changes and so does
    // the key, which is the whole point of separating them.
    const isHeld = isHumanOnly && verdict.heldPullRequests.length > 0;
    const idempotencyKey = isHeld ? entry.heldKey : isHumanOnly ? entry.humanOnlyKey : entry.key;

    const inserted = await db
      .insert(issueComments)
      .values({
        companyId: entry.candidate.companyId,
        issueId: entry.candidate.id,
        authorType: "system",
        idempotencyKey,
        idempotencyProcessedAt: now,
        body: isHumanOnly
          ? buildTerminalGateHumanOnlyComment({
              signals: verdict.signals,
              humanGates: verdict.humanGates,
              heldPullRequests: verdict.heldPullRequests,
              mergedPullRequests: verdict.mergedPullRequests,
              armedNextCheckAt,
            })
          : buildTerminalGateResolvedComment({
              signals: verdict.signals,
              mergedPullRequests: verdict.mergedPullRequests,
              dischargedHumanGates: verdict.dischargedHumanGates,
              armedNextCheckAt,
            }),
      })
      .onConflictDoNothing()
      .returning({ id: issueComments.id });
    if (inserted.length === 0) continue;

    if (isHumanOnly) {
      humanGateOnly += 1;
      log.info(
        {
          issueId: entry.candidate.id,
          identifier: entry.candidate.identifier,
          assigneeAgentId: entry.candidate.assigneeAgentId,
          humanGates: verdict.humanGates,
          mergedPullRequests: verdict.mergedPullRequests,
          gateSignals: verdict.signals,
        },
        "terminal-gate reconciler announced an issue whose only remaining gate is a human decision (PEN-4545)",
      );
      continue;
    }

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

  // The read budget fails closed, so a capped issue is simply left alone and is
  // otherwise indistinguishable from "nothing to resolve". Say so out loud:
  // `updatedAt ASC` is a stable order, so without this the same head-of-list
  // issues would consume the budget every pass and anything behind them would
  // stay unannounced silently rather than diagnosably.
  if (readCapped > 0) {
    log.warn(
      { readCapped, pullRequestReads: gateCache.size, scanned: candidates.length, maxReads },
      "terminal-gate reconciler exhausted its per-pass pull-request read budget; issues past the cap were left unresolved this pass (BLO-27515)",
    );
  }

  return { scanned: candidates.length, resolved, humanGateOnly, pullRequestReads: gateCache.size };
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
