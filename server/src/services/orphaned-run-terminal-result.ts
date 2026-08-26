import { promises as fs } from "node:fs";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

/**
 * Recovers an orphaned run's own terminal verdict from the artifact its pod
 * wrote, so the vanished-Job reconciler stops recording successes as failures.
 *
 * Background. An external-lifecycle (k8s) agent Job carries
 * `ttlSecondsAfterFinished`, so the Job object is *correctly* garbage-collected
 * shortly after the agent exits. `reapOrphanedRuns` infers liveness from the
 * presence of that object, so a run whose adapter owner died before finalizing
 * is swept after GC, finds no Job, and is recorded `failed` / `job_missing`
 * ("External lifecycle Job is missing while heartbeat run is still running")
 * even when the agent had finished successfully. The run's `resultJson` column
 * cannot help: it is only ever written together with the terminal status
 * transition, so a still-`running` orphan's row carries no agent verdict.
 *
 * The verdict does survive on disk. The claude_k8s Job command tees the agent's
 * stream-json to `<run>.pod.ndjson` under the shared data PVC, in the same
 * `data/run-logs` tree this server's own run-log store owns, and the adapter
 * unlinks it from its cleanup `finally`. So a *surviving* artifact means the
 * adapter owner never completed cleanup -- precisely the orphan case this reads.
 *
 * Fail-closed: an absent, empty, unreadable, or truncated artifact yields
 * `absent`, leaving the caller's `job_missing` verdict untouched. Only an
 * explicit terminal `result` event can change an outcome. This preserves the
 * BLO-18106 invariant that generic run artifacts (comments, documents, work
 * products) never count as success proof -- what is trusted here is not a proxy
 * for progress but the agent process's own structured self-report.
 */

/** Cap the tail read so a large transcript cannot balloon reconciler memory.
 *  The terminal `result` event is the last line, so a tail always suffices. */
const TERMINAL_RESULT_TAIL_BYTES = 256 * 1024;

/** Pod-written sibling of the server's own `<runId>.ndjson` run log. */
const POD_LOG_SUFFIX = ".pod.ndjson";

export type OrphanedRunTerminalResult =
  | { outcome: "absent"; reason: "no_artifact" | "empty_artifact" | "no_result_event" | "unreadable" }
  | { outcome: "found"; succeeded: boolean; subtype: string | null; artifactPath: string };

function runLogBasePath() {
  return process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
}

/**
 * Locates the pod-written artifact for a run. An isolated run nests under
 * `isolated/<isolationKey>/`, and the isolation key is adapter-side state the
 * server does not persist -- so the nested case is resolved by scanning that
 * one directory level for the run-scoped filename rather than by reconstructing
 * the adapter's path layout. Run ids are unique, so at most one file matches.
 */
async function locatePodLogArtifact(companyId: string, agentId: string, runId: string) {
  const agentDir = path.join(runLogBasePath(), companyId, agentId);
  const fileName = `${runId}${POD_LOG_SUFFIX}`;

  const direct = path.join(agentDir, fileName);
  try {
    const stat = await fs.stat(direct);
    if (stat.isFile()) return direct;
  } catch {
    // fall through to the isolated layout
  }

  const isolatedRoot = path.join(agentDir, "isolated");
  let isolationKeys: string[];
  try {
    isolationKeys = await fs.readdir(isolatedRoot);
  } catch {
    return null;
  }
  for (const isolationKey of isolationKeys) {
    const candidate = path.join(isolatedRoot, isolationKey, fileName);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * True only when the agent's own terminal event reports success.
 *
 * Deliberately NOT `isSuccessfulAdapterResult`: that helper accepts
 * `(exitCode ?? 0) === 0` as sufficient, and an artifact carries no process exit
 * code -- so passing one through would score *every* recovered result as a
 * success, including `is_error: true`. Recovering from a transcript means the
 * only trustworthy signal is the agent's explicit structured verdict, so this
 * mirrors just the structured clause of that helper and requires both halves.
 */
function resultEventReportsSuccess(event: Record<string, unknown>) {
  return event.subtype === "success" && event.is_error !== true;
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Reads the last `{"type":"result"}` event from a run's pod-written artifact.
 *
 * Never throws and never surfaces transcript content: callers get the structured
 * verdict only, so a recovered outcome cannot leak agent output into logs or run
 * records.
 */
export async function readOrphanedRunTerminalResult(input: {
  companyId: string;
  agentId: string;
  runId: string;
}): Promise<OrphanedRunTerminalResult> {
  let artifactPath: string | null;
  try {
    artifactPath = await locatePodLogArtifact(input.companyId, input.agentId, input.runId);
  } catch {
    return { outcome: "absent", reason: "unreadable" };
  }
  if (!artifactPath) return { outcome: "absent", reason: "no_artifact" };

  let tail: string;
  try {
    const handle = await fs.open(artifactPath, "r");
    try {
      const { size } = await handle.stat();
      if (size === 0) return { outcome: "absent", reason: "empty_artifact" };
      const length = Math.min(size, TERMINAL_RESULT_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      tail = buffer.toString("utf-8");
    } finally {
      await handle.close();
    }
  } catch {
    return { outcome: "absent", reason: "unreadable" };
  }

  // Scan backwards: the terminal result is the last event, and a tail read may
  // have sliced the first line mid-way (which simply fails to parse).
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (!line.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const record = event as Record<string, unknown>;
    if (record.type !== "result") continue;
    return {
      outcome: "found",
      succeeded: resultEventReportsSuccess(record),
      subtype: readOptionalString(record.subtype),
      artifactPath,
    };
  }
  return { outcome: "absent", reason: "no_result_event" };
}
