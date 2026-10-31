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
    // `trimStart` only. A trailing `\r` from a CRLF writer is left on the
    // payload and handled by `JSON.parse`, which tolerates trailing
    // whitespace; trimming the end here would also silently repair a line the
    // kubelet clipped mid-token, which is the one case that must stay visible.
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

  if (typeof candidate.result !== "object" || candidate.result === null) {
    return { ok: false, failure: "malformed", detail: "execute report carries no result object" };
  }
  return { ok: true, report: candidate as unknown as IsolationReclaimReport };
}
