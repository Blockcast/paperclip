/**
 * The wire between the control plane and a reclaim executor (PEN-5151).
 *
 * PEN-5151 split the foreign-claim sweep across a process boundary: an executor
 * holding the agent's claim reports what it has, `buildIsolationReclaimPlan`
 * decides here, and the executor unlinks what it is given. Both halves landed
 * in `isolation-workspace-reaper.ts` (#3184, #3186) as plain functions. This
 * module is the thing between them — how a report crosses that boundary, and
 * how it is recovered on this side.
 *
 * ## Why a marker, and not just "parse the pod's stdout"
 *
 * The return channel is the container log, read through `pods/log` — the one
 * verb the server's Role already carries (`paperclip-k8s-adapters`), and the
 * only one that needs no credential on the volume being reclaimed. The
 * Kubernetes log API has **no stream selector**: `readNamespacedPodLog` serves
 * one interleaved view of fd 1 and fd 2. So a node warning, a runtime
 * deprecation notice, or anything the image prints on startup arrives mixed
 * into the same text as the report.
 *
 * `job-manifest.ts` already solved exactly this for the run transcript, with
 * `POD_LOG_STREAM_MARKER`. This is the same remedy for a different payload, and
 * the marker is deliberately a *different* string: a transcript line and a
 * reclaim report must never be recoverable by the same filter, or a run whose
 * transcript happened to contain one would be read as the other.
 *
 * ## Failing closed, in both directions
 *
 * Every failure here resolves toward "do nothing", because the consumer of a
 * parsed inventory is a function that decides what to delete:
 *
 * - **No report line** — the executor died before it could speak, or the image
 *   never ran. Distinct from a malformed one, because the remedies differ: this
 *   is a pod to look at, that is a format to fix.
 * - **More than one report line** — ambiguous. The obvious reading ("take the
 *   last") is a guess about which process wrote which, on a channel this module
 *   exists to say is shared. A second marker line means something other than
 *   the executor can produce one, and that is exactly the condition under which
 *   picking one is unsafe.
 * - **Malformed JSON, or a truncated line.** The kubelet rotates a container
 *   log (10 Mi by default) and a rotation can land mid-line, so a clipped report
 *   is a real outcome rather than a theoretical one. It surfaces as `malformed`,
 *   never as an empty inventory — an empty inventory is a *valid* report
 *   meaning "this claim has nothing to reclaim", and the two must not collapse.
 * - **An unknown schema version.** The executor image and the control plane
 *   deploy on different cadences, so a Job can legitimately be running an older
 *   build. A version this side does not know is refused rather than
 *   best-effort parsed.
 *
 * There is deliberately no "partial" outcome. A report is usable in full or not
 * at all; a half-read inventory would under-report directories, and under
 * `buildIsolationReclaimPlan` an absent entry is indistinguishable from a
 * directory that does not exist.
 */

import type {
  IsolationReclaimExecutionResult,
  IsolationReclaimStopReason,
  IsolationWorkspaceInventoryEntry,
} from "./isolation-workspace-reaper.js";

/**
 * Line prefix identifying a reclaim report on the executor's stdout.
 *
 * Distinct from `POD_LOG_STREAM_MARKER` (`@@PCLOG@@`) on purpose — see the
 * module header. Short for the same reason that one is: every byte is spent
 * against the kubelet's rotation bound, and it is not JSON-leading, so a report
 * that lost its prefix cannot be mistaken for a bare JSON line.
 */
export const ISOLATION_RECLAIM_REPORT_MARKER = "@@PCRECLAIM@@";

/**
 * Wire schema version, bumped on any change that an older reader would
 * mis-read rather than reject.
 *
 * It exists because the two sides are deployed independently: the control plane
 * rolls with the server image, the executor runs whatever image the Job names.
 * Skew is the normal case, not the failure case, so it is given an explicit
 * field rather than being inferred from which keys happen to be present.
 */
export const ISOLATION_RECLAIM_REPORT_VERSION = 1;

/**
 * Env var carrying the plan on the `execute` path — the INBOUND half of this
 * wire.
 *
 * Lives here, beside the report, because both directions of one boundary are
 * one contract: the Job manifest writes this variable, the executor reads it,
 * and a disagreement about its name or shape is the same class of defect as a
 * disagreement about the marker. It was first declared in
 * `cli/isolation-reclaim-executor.ts` (#3189) and moved here when the manifest
 * builder needed it too — a long-lived server service importing a CLI
 * entrypoint for a string constant would drag that module's import-time
 * `pino.destination` into the API server for nothing.
 */
export const RECLAIM_PLAN_ENV = "PAPERCLIP_RECLAIM_PLAN_JSON";

/**
 * The plan as it crosses into the pod.
 *
 * Carried in the environment rather than a ConfigMap because the server's Role
 * (`paperclip-k8s-adapters`) has **no** `configmaps` verb in any form —
 * verified against the live Role, which holds only `batch/jobs`, `pods`,
 * `pods/log`, `metrics.k8s.io/pods`, `secrets` and
 * `persistentvolumeclaims` — so a ConfigMap would need an RBAC change in
 * `onprem-k8s` ahead of this. And it buys nothing: `maxDeletes` already bounds
 * `eligibleIds` to a few hundred uuids, ~7 KB, far inside the kernel's 128 KiB
 * limit on a single environment string (`MAX_ARG_STRLEN`). That bound is
 * enforced at manifest-build time by `isolation-reclaim-job.ts` rather than
 * left to the kubelet, where exceeding it surfaces as an opaque container
 * create failure.
 */
export interface ReclaimPlanEnvelope {
  planBuiltAtMs: number;
  eligibleIds: string[];
  maxDeletes?: number;
  maxPlanAgeMs?: number;
  dryRun?: boolean;
}

/** What the executor was asked to do, and therefore how to read its payload. */
export type IsolationReclaimReportKind = "inventory" | "execute";

/** A successful report, carrying the payload for its kind. */
export type IsolationReclaimReport =
  | { v: number; kind: "inventory"; ok: true; inventory: IsolationWorkspaceInventoryEntry[] }
  | { v: number; kind: "execute"; ok: true; result: IsolationReclaimExecutionResult }
  | { v: number; kind: IsolationReclaimReportKind; ok: false; error: string };

/**
 * Why a report could not be recovered. Kept apart rather than folded into one
 * "bad report" case because each names a different thing to go and look at:
 * `absent` is a pod, `duplicate` is something else writing to the channel,
 * `malformed` is a format or a rotation, `unsupported_version` is a deploy skew.
 */
export type IsolationReclaimReportParseFailure =
  | "absent"
  | "duplicate"
  | "malformed"
  | "unsupported_version";

export type IsolationReclaimReportParse =
  | { ok: true; report: IsolationReclaimReport }
  | { ok: false; failure: IsolationReclaimReportParseFailure; detail: string };

/**
 * Every numeric counter an execution result carries.
 *
 * Spelled out rather than derived from the object's own keys, because the
 * question this list answers is whether the *expected* fields arrived — and an
 * object's own keys can only describe what it happens to contain, which is the
 * thing in doubt.
 *
 * The exhaustiveness that matters is checked below rather than by `satisfies`.
 * `as const satisfies ReadonlyArray<keyof ...>` rejects a listed name that is
 * not a key — the direction that was never in doubt — and says nothing at all
 * about a key added to the interface and left off the list, which is the
 * direction that silently stops being validated. (Ally, review of #3189.)
 */
const EXECUTION_RESULT_COUNTERS = [
  "requested",
  "deleted",
  "wouldDelete",
  "skippedUnsafeName",
  "skippedLayout",
  "retainedNestedCheckout",
  "vanished",
  "failed",
  "notAttempted",
] as const;

/** The closed set of `stopReason` values this build knows how to read. */
const EXECUTION_STOP_REASONS = [
  "complete",
  "capped",
  "plan_stale",
  "plan_unusable",
] as const;

/**
 * The `number`-typed keys of an execution result — the ones the loop below can
 * meaningfully check with `Number.isFinite`. `capped` (boolean) and
 * `stopReason` (a string union) are excluded by construction rather than by
 * being remembered, and each is checked on its own terms further down.
 */
type NumericResultKey = {
  [K in keyof IsolationReclaimExecutionResult]-?: IsolationReclaimExecutionResult[K] extends number
    ? K
    : never;
}[keyof IsolationReclaimExecutionResult];

/**
 * Build-time exhaustiveness, in both directions and as two separate
 * assertions so the compiler error names which way it broke.
 *
 * A failure is a `true` assigned to `never`, i.e. a TS2322 at this line. The
 * second of each pair is the one that earns its place: without it, adding a
 * counter to `IsolationReclaimExecutionResult` or a value to
 * `IsolationReclaimStopReason` leaves this module quietly validating a subset.
 * For a counter that is a silent fail-OPEN — the new field is never checked,
 * so a report carrying `undefined` for it parses `ok: true`. For a stop reason
 * it fails closed but only at runtime, where every report from a newer image
 * reads `malformed`; a build-time guarantee is the entire point of this block.
 */
const _everyListedCounterIsANumericKey: (typeof EXECUTION_RESULT_COUNTERS)[number] extends NumericResultKey
  ? true
  : never = true;
const _everyNumericKeyIsListed: NumericResultKey extends (typeof EXECUTION_RESULT_COUNTERS)[number]
  ? true
  : never = true;
const _everyListedStopReasonIsReal: (typeof EXECUTION_STOP_REASONS)[number] extends IsolationReclaimStopReason
  ? true
  : never = true;
const _everyStopReasonIsListed: IsolationReclaimStopReason extends (typeof EXECUTION_STOP_REASONS)[number]
  ? true
  : never = true;
void _everyListedCounterIsANumericKey;
void _everyNumericKeyIsListed;
void _everyListedStopReasonIsReal;
void _everyStopReasonIsListed;

/**
 * Render a report as the single line the executor writes to stdout.
 *
 * One line, not pretty-printed, because the recovery rule on the other side is
 * "exactly one line carries the marker" — an embedded newline would split one
 * report into a marked line and an unmarked remainder, and the remainder would
 * be silently dropped as someone else's output. `JSON.stringify` without a
 * replacer cannot emit a literal newline inside a string (it escapes them), so
 * this holds for any payload.
 */
export function encodeIsolationReclaimReport(report: IsolationReclaimReport): string {
  return `${ISOLATION_RECLAIM_REPORT_MARKER}${JSON.stringify(report)}`;
}

/**
 * Recover the one report from an interleaved pod log.
 *
 * `logText` is the whole `pods/log` body, warnings and all. Scans every line
 * rather than stopping at the first match, because detecting a second marker is
 * the point: see the module header on why "take the last" is not available.
 */
export function parseIsolationReclaimReport(logText: string): IsolationReclaimReportParse {
  const marked: string[] = [];
  for (const line of logText.split("\n")) {
    // `trimStart` only, and nothing rests on that. A trailing `\r` from a CRLF
    // writer is left on the payload because `JSON.parse` treats it as trailing
    // whitespace and accepts it, so stripping it would buy nothing. Trimming
    // the end would not endanger a clipped line either: a line the kubelet cut
    // mid-token is invalid JSON with or without trailing whitespace, and
    // `trimEnd` cannot supply the `}` it lost. What keeps a clip visible is
    // `JSON.parse` below, reported as `malformed`. (Ally, review of #3189.)
    const trimmed = line.trimStart();
    if (trimmed.startsWith(ISOLATION_RECLAIM_REPORT_MARKER)) {
      marked.push(trimmed.slice(ISOLATION_RECLAIM_REPORT_MARKER.length));
    }
  }

  if (marked.length === 0) {
    return { ok: false, failure: "absent", detail: "no line carried the reclaim report marker" };
  }
  if (marked.length > 1) {
    return {
      ok: false,
      failure: "duplicate",
      detail: `${marked.length} lines carried the reclaim report marker; refusing to choose`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(marked[0] as string);
  } catch (err) {
    return {
      ok: false,
      failure: "malformed",
      detail: `report line is not valid JSON: ${(err as Error).message}`,
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, failure: "malformed", detail: "report is not a JSON object" };
  }
  const candidate = parsed as Record<string, unknown>;

  // Version before shape. A future version may legitimately have a shape this
  // build would call malformed, and reporting it that way would send the next
  // reader after a serialization bug that does not exist.
  if (candidate.v !== ISOLATION_RECLAIM_REPORT_VERSION) {
    return {
      ok: false,
      failure: "unsupported_version",
      detail: `report schema v${String(candidate.v)}; this build reads v${ISOLATION_RECLAIM_REPORT_VERSION}`,
    };
  }
  if (candidate.kind !== "inventory" && candidate.kind !== "execute") {
    return { ok: false, failure: "malformed", detail: `unknown report kind ${String(candidate.kind)}` };
  }

  if (candidate.ok === false) {
    if (typeof candidate.error !== "string") {
      return { ok: false, failure: "malformed", detail: "failure report carries no error string" };
    }
    return { ok: true, report: candidate as unknown as IsolationReclaimReport };
  }
  if (candidate.ok !== true) {
    return { ok: false, failure: "malformed", detail: "report carries no boolean ok" };
  }

  if (candidate.kind === "inventory") {
    // Each entry is checked, not just the array. An entry with a non-finite
    // `mtimeMs` would be refused downstream as `skippedMalformed`, but one with
    // a non-string `name` reaches `UUID_PATTERN` as a non-string and the
    // failure would read as an unsafe name rather than a broken transport.
    if (!Array.isArray(candidate.inventory)) {
      return { ok: false, failure: "malformed", detail: "inventory report carries no inventory array" };
    }
    for (const entry of candidate.inventory) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof (entry as IsolationWorkspaceInventoryEntry).name !== "string" ||
        typeof (entry as IsolationWorkspaceInventoryEntry).mtimeMs !== "number"
      ) {
        return { ok: false, failure: "malformed", detail: "inventory entry is not {name, mtimeMs}" };
      }
    }
    return { ok: true, report: candidate as unknown as IsolationReclaimReport };
  }

  // Checked field by field, for the reason the inventory entries above are.
  // This payload never drives a deletion — by the time it is read the executor
  // has finished — but it is the whole of what an operator and every downstream
  // counter learn about what happened. Accepting any object at all lets
  // `{"result":{}}` through as `ok:true`, after which `deleted` and
  // `stopReason` are `undefined`, and a report that says nothing becomes
  // indistinguishable from one that says "considered the plan, deleted
  // nothing". That is the same collapse the header refuses for an empty
  // inventory, one level down. (Ally, review of #3189.)
  //
  // Note what is deliberately *not* checked here: that `kind` matches the mode
  // the Job was asked to run. This function is handed a log, not an
  // invocation, and has nothing to compare against — the driver that chose the
  // mode is the only thing that can, and must.
  if (typeof candidate.result !== "object" || candidate.result === null || Array.isArray(candidate.result)) {
    return { ok: false, failure: "malformed", detail: "execute report carries no result object" };
  }
  const result = candidate.result as Record<string, unknown>;
  for (const counter of EXECUTION_RESULT_COUNTERS) {
    if (!Number.isFinite(result[counter])) {
      return {
        ok: false,
        failure: "malformed",
        detail: `execute result field '${counter}' is not a finite number`,
      };
    }
  }
  if (typeof result.capped !== "boolean") {
    return { ok: false, failure: "malformed", detail: "execute result carries no boolean capped" };
  }
  if (!EXECUTION_STOP_REASONS.includes(result.stopReason as IsolationReclaimStopReason)) {
    return {
      ok: false,
      failure: "malformed",
      detail: `execute result carries unknown stopReason ${String(result.stopReason)}`,
    };
  }
  return { ok: true, report: candidate as unknown as IsolationReclaimReport };
}
