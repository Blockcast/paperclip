import type * as k8s from "@kubernetes/client-node";

import {
  type IsolationReclaimReport,
  type IsolationReclaimReportKind,
  parseIsolationReclaimReport,
} from "./isolation-reclaim-report.js";
import {
  type IsolationReclaimJobManifest,
  RECLAIM_JOB_CLAIM_ANNOTATION,
  RECLAIM_JOB_CONTAINER_NAME,
} from "./isolation-reclaim-job.js";
import { classifyAgentJobRunStatus } from "./k8s-job-liveness.js";

/**
 * Run one reclaim Job and recover its report (PEN-5151).
 *
 * The four pieces before this one are all pure: `buildIsolationReclaimPlan`
 * (#3184) decides, `collectIsolationWorkspaceInventory` /
 * `executeIsolationReclaimPlan` (#3186) are the executor's ends,
 * `isolation-reclaim-report.ts` + `cli/isolation-reclaim-executor.ts` (#3189)
 * are the wire and the entrypoint, and `isolation-reclaim-job.ts` (#3194) is
 * the manifest. Every one of them is a value a test can assert. **None of them
 * acts.** This module is the first that does: it creates the Job, waits for it
 * to reach a terminal phase, finds its pod, reads `pods/log`, and hands back
 * the one report that log carries.
 *
 * It still does not decide anything. It takes a manifest it did not build and
 * returns a report it does not interpret, so the inventory → plan → execute
 * orchestration stays above it and remains testable without a cluster.
 *
 * ## The cluster is behind a port, and that is not only for tests
 *
 * {@link ReclaimJobPort} is five methods with no Kubernetes error types in
 * their signatures. Translating a `409 AlreadyExists` or a `404` into a value
 * happens at the adapter, so the policy below — when an adoption is safe, when
 * a missing pod is fatal — reads as a decision rather than as a chain of
 * `instanceof` checks. It also means every branch here is reachable from a test
 * without a kube API, which matters because the branches that matter are the
 * failure ones.
 *
 * ## `deletionOutcomeUnknown` is the field this module exists to get right
 *
 * An `execute` Job unlinks directories. If anything goes wrong after it starts,
 * **the number of deletions that happened is unknown** — the pod may have
 * removed nothing, everything, or stopped halfway. Every failure result
 * therefore carries {@link ReclaimRunFailure.deletionOutcomeUnknown}, and a
 * caller must not treat an unknown as a zero:
 *
 * - Re-planning from the inventory that produced the plan would re-issue ids
 *   that are already gone. Harmless in itself (the executor reports `vanished`)
 *   but it masks the failure as an ordinary no-op tick.
 * - Reporting "reclaimed 0 bytes" is worse: it is a measurement that was never
 *   taken, and the ≈3.7-month ceiling this row exists to lift is tracked by
 *   exactly that number.
 *
 * It is `false` only when nothing could have run: an `inventory` Job (which
 * never unlinks), or a create that was refused before any pod existed.
 *
 * ## Why a failed Job's log is still read
 *
 * The executor writes its report and *then* exits, and it exits non-zero on
 * every refusal — a stale plan, an unusable one, a root that is not there. So
 * `Failed` is the normal outcome of a Job that reported correctly, and
 * returning early on the Job condition would throw away the structured reason
 * in favour of the exit code. Recovery is attempted on every terminal phase,
 * and the Job's own condition is only consulted when no report was recovered.
 *
 * The one phase where that does not help is `DeadlineExceeded`: exceeding
 * `activeDeadlineSeconds` makes the Job controller **delete the pod**, so the
 * log is gone before anything can read it. It gets its own failure kind because
 * its remedy is specific — lower `maxDeletes` so the unlink loop fits the
 * deadline — and because on `execute` it is the worst case of the paragraph
 * above: deletions certainly started and nothing recorded where they stopped.
 *
 * ## Exactly one pod, and more than one is refused
 *
 * The manifest sets `backoffLimit: 0` and `restartPolicy: Never`, so one Job is
 * one pod. Two pods means an assumption broke, and reading either log would
 * report one pod's deletions as the whole Job's. That is the same reasoning
 * `parseIsolationReclaimReport` applies to a second marker line on one log —
 * "take the last" is a guess about which process did what — raised one level to
 * the process itself.
 *
 * ## Adoption, and the name collision it can hide
 *
 * `reclaimJobName` truncates the *claim* to fit 63 characters, so two claims
 * sharing a long prefix produce the same Job name under the same invocation id.
 * A create would come back `AlreadyExists` and adopting it would read the wrong
 * volume's report — and on `execute`, would wait on a pod deleting from a
 * different claim. So an adoption is verified against the untruncated
 * `paperclip.io/reclaim-claim-name` annotation, which exists for precisely this
 * ("the label is for selecting and the annotation is for reading"). A
 * disagreement is refused, never resolved.
 */

/** How long a Job may take to get from `create` to a running pod. */
export const DEFAULT_RECLAIM_STARTUP_GRACE_MS = 10 * 60 * 1000;

/** Gap between Job reads while waiting. */
export const DEFAULT_RECLAIM_POLL_INTERVAL_MS = 5_000;

/**
 * The cluster, as the five operations this needs and nothing else.
 *
 * `readJob` returns `null` for a Job that is not there, and `createJob`
 * reports an existing name as a value rather than an error, so no caller of
 * this module has to know what a Kubernetes status error looks like.
 */
export interface ReclaimJobPort {
  /** `already_exists` is a value, not an error: see the header on adoption. */
  createJob(namespace: string, job: k8s.V1Job): Promise<"created" | "already_exists">;
  /** `null` means 404 — the Job is not there, which is distinct from "not finished". */
  readJob(namespace: string, name: string): Promise<k8s.V1Job | null>;
  /** Pods carrying this Job's `job-name` label. */
  listJobPods(namespace: string, jobName: string): Promise<k8s.V1Pod[]>;
  readPodLog(namespace: string, podName: string, container: string): Promise<string>;
}

/**
 * Why a run produced no report.
 *
 * Separate kinds rather than one `failed`, because each names a different thing
 * to go and look at, and two of them are not even about this Job:
 * `name_collision` is a caller choosing invocation ids badly, and
 * `report_unsupported_version` is a deploy skew between the server and the
 * image it launched.
 */
export type ReclaimRunFailureKind =
  /** The existing Job under this name mounts a different claim. Nothing was created. */
  | "name_collision"
  /** `activeDeadlineSeconds` elapsed; the controller deleted the pod and the log with it. */
  | "deadline_exceeded"
  /** Terminal `Failed`, and no report was recovered to explain it. */
  | "job_failed"
  /** The wait budget ran out with the Job still active. */
  | "wait_timeout"
  /** Terminal, but no pod carries the Job's label — evicted, or garbage-collected. */
  | "pod_absent"
  /** More than one pod for a `backoffLimit: 0` Job. See the header. */
  | "pod_ambiguous"
  /** `pods/log` itself failed. */
  | "log_unreadable"
  /** The log carried no marker line. */
  | "report_absent"
  /** The log carried two. */
  | "report_duplicate"
  /** A marker line that would not parse, or was clipped by a log rotation. */
  | "report_malformed"
  /** A report from an image this build cannot read. */
  | "report_unsupported_version"
  /** A well-formed report for the other mode — an adoption or a manifest bug. */
  | "report_mode_mismatch";

export interface ReclaimRunSuccess {
  ok: true;
  report: IsolationReclaimReport;
  jobName: string;
  namespace: string;
  mode: IsolationReclaimReportKind;
  claimName: string;
  podName: string;
  /** True when this run attached to a Job it did not create. */
  adopted: boolean;
}

export interface ReclaimRunFailure {
  ok: false;
  kind: ReclaimRunFailureKind;
  detail: string;
  jobName: string;
  namespace: string;
  mode: IsolationReclaimReportKind;
  claimName: string;
  podName: string | null;
  adopted: boolean;
  /**
   * The Job may have unlinked an unknown amount. See the header: a caller must
   * not read this as zero reclaimed.
   */
  deletionOutcomeUnknown: boolean;
}

export type ReclaimRunOutcome = ReclaimRunSuccess | ReclaimRunFailure;

export interface RunIsolationReclaimJobOptions {
  manifest: IsolationReclaimJobManifest;
  claimName: string;
  mode: IsolationReclaimReportKind;
  port: ReclaimJobPort;
  /** Added to the Job's own `activeDeadlineSeconds` to bound the wait. */
  startupGraceMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The wall-clock budget for the wait, derived from the Job being waited on.
 *
 * `activeDeadlineSeconds` is read off the manifest rather than restated as a
 * constant here, so the two cannot drift: a caller that raises the Job's
 * deadline for a large claim gets a wait that still outlasts it. The grace is
 * added because `activeDeadlineSeconds` is measured from **pod start** —
 * admission, scheduling and the image pull all happen outside it, so a budget
 * equal to the deadline would abandon a Job that had not begun to be measured.
 */
export function reclaimWaitBudgetMs(
  manifest: IsolationReclaimJobManifest,
  startupGraceMs: number,
): number {
  const deadlineSeconds = manifest.job.spec?.activeDeadlineSeconds;
  // A Job with no deadline is not a Job to wait on forever; the grace alone is
  // the budget, and the caller learns it timed out rather than hanging a tick.
  const deadlineMs =
    typeof deadlineSeconds === "number" && Number.isFinite(deadlineSeconds) && deadlineSeconds > 0
      ? deadlineSeconds * 1000
      : 0;
  return startupGraceMs + deadlineMs;
}

/** The untruncated claim this Job says it mounts, or `null` if it does not say. */
function claimAnnotationOf(job: k8s.V1Job): string | null {
  const raw = job.metadata?.annotations?.[RECLAIM_JOB_CLAIM_ANNOTATION];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * Create the Job, wait for it, and recover the one report its pod log carries.
 *
 * Returns a value for every outcome; the only throws are from the port itself,
 * which the caller owns.
 */
export async function runIsolationReclaimJob(
  options: RunIsolationReclaimJobOptions,
): Promise<ReclaimRunOutcome> {
  const {
    manifest,
    claimName,
    mode,
    port,
    startupGraceMs = DEFAULT_RECLAIM_STARTUP_GRACE_MS,
    pollIntervalMs = DEFAULT_RECLAIM_POLL_INTERVAL_MS,
    now = Date.now,
    sleep = defaultSleep,
  } = options;

  const { jobName, namespace } = manifest;
  // `execute` is the only mode that unlinks, so it is the only mode where a
  // failure leaves an unknown behind. Captured once, here, rather than decided
  // at each `fail` call site where one omission would silently report an
  // unknown as a zero.
  const couldHaveDeleted = mode === "execute";

  let adopted = false;
  const fail = (
    kind: ReclaimRunFailureKind,
    detail: string,
    podName: string | null,
    deletionOutcomeUnknown: boolean,
  ): ReclaimRunFailure => ({
    ok: false,
    kind,
    detail,
    jobName,
    namespace,
    mode,
    claimName,
    podName,
    adopted,
    deletionOutcomeUnknown,
  });

  const created = await port.createJob(namespace, manifest.job);
  if (created === "already_exists") {
    adopted = true;
    const existing = await port.readJob(namespace, jobName);
    if (!existing) {
      // Created-then-gone between two calls: a TTL expiry or an operator
      // delete. Nothing of ours ran, and nothing of ours is running.
      return fail(
        "job_failed",
        `Job ${jobName} reported AlreadyExists but is not readable; it was deleted between the create and the read`,
        null,
        false,
      );
    }
    const existingClaim = claimAnnotationOf(existing);
    // Refused, not resolved. An absent annotation is refused too: it means the
    // Job under this name was not built by this module, so there is no evidence
    // it mounts the claim we were asked about.
    if (existingClaim !== claimName) {
      return fail(
        "name_collision",
        `Job ${jobName} already exists and mounts ${
          existingClaim === null ? "an unrecorded claim" : JSON.stringify(existingClaim)
        }, not ${JSON.stringify(claimName)}; pick a different invocationId`,
        null,
        false,
      );
    }
  }

  const budgetMs = reclaimWaitBudgetMs(manifest, startupGraceMs);
  const deadlineAt = now() + budgetMs;
  let lastPhase: ReturnType<typeof classifyAgentJobRunStatus> | null = null;

  // `classifyAgentJobRunStatus` is reused rather than copied: it reads the
  // `Failed`/`Complete` conditions off a `batch/v1` Job and knows nothing about
  // agents despite its name. A second implementation of the same three-line
  // rule is a second thing to keep correct.
  for (;;) {
    const job = await port.readJob(namespace, jobName);
    if (!job) {
      // A Job we just created, or adopted and read, is gone. On `execute` its
      // pod may have been part-way through the unlink loop.
      return fail(
        "job_failed",
        `Job ${jobName} disappeared while being waited on`,
        null,
        couldHaveDeleted,
      );
    }
    lastPhase = classifyAgentJobRunStatus(job);
    if (lastPhase.phase !== "active") break;
    if (now() >= deadlineAt) break;
    await sleep(pollIntervalMs);
  }

  // The deadline path is checked before recovery because the pod is already
  // gone: `activeDeadlineSeconds` termination deletes it, so there is no log to
  // read and a `pod_absent` here would name the wrong cause.
  if (lastPhase?.phase === "failed" && lastPhase.reason === "DeadlineExceeded") {
    return fail(
      "deadline_exceeded",
      `Job ${jobName} exceeded activeDeadlineSeconds (${
        manifest.job.spec?.activeDeadlineSeconds ?? "unset"
      }s); its pod and log were deleted by the Job controller${
        couldHaveDeleted ? ", and how far the unlink loop got is unrecorded" : ""
      }`,
      null,
      couldHaveDeleted,
    );
  }

  const timedOut = lastPhase?.phase === "active";
  const pods = await port.listJobPods(namespace, jobName);
  if (pods.length === 0) {
    return fail(
      "pod_absent",
      timedOut
        ? `Job ${jobName} was still active after ${budgetMs}ms and has no pod`
        : `Job ${jobName} is terminal (${lastPhase?.phase}) but no pod carries its job-name label`,
      null,
      couldHaveDeleted,
    );
  }
  if (pods.length > 1) {
    const names = pods.map((pod) => pod.metadata?.name ?? "<unnamed>").sort();
    return fail(
      "pod_ambiguous",
      `Job ${jobName} has ${pods.length} pods (${names.join(", ")}) but backoffLimit is 0; ` +
        `one pod's log cannot speak for the Job`,
      null,
      couldHaveDeleted,
    );
  }

  const podName = pods[0]?.metadata?.name ?? null;
  if (!podName) {
    return fail("pod_absent", `Job ${jobName} has a pod with no name`, null, couldHaveDeleted);
  }

  // Attempted even on a timeout. The last poll can land microseconds before the
  // executor's final write, and a report that is there is the answer regardless
  // of what the Job condition said when it was last read.
  let logText: string;
  try {
    logText = await port.readPodLog(namespace, podName, RECLAIM_JOB_CONTAINER_NAME);
  } catch (error) {
    return fail(
      "log_unreadable",
      `reading ${podName}/${RECLAIM_JOB_CONTAINER_NAME} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      podName,
      couldHaveDeleted,
    );
  }

  const parsed = parseIsolationReclaimReport(logText);
  if (!parsed.ok) {
    // A Job that failed *and* produced no readable report is reported as the
    // Job failure, because that is the fact with a reason attached; the parse
    // failure on an empty log of a crashed pod only restates it.
    if (lastPhase?.phase === "failed" && parsed.failure === "absent") {
      return fail(
        "job_failed",
        `Job ${jobName} failed (${lastPhase.reason ?? "no reason"}: ${
          lastPhase.message ?? "no message"
        }) and its pod log carries no report`,
        podName,
        couldHaveDeleted,
      );
    }
    if (timedOut && parsed.failure === "absent") {
      return fail(
        "wait_timeout",
        `Job ${jobName} was still active after ${budgetMs}ms and its pod log carries no report yet`,
        podName,
        couldHaveDeleted,
      );
    }
    const kind: ReclaimRunFailureKind =
      parsed.failure === "absent"
        ? "report_absent"
        : parsed.failure === "duplicate"
          ? "report_duplicate"
          : parsed.failure === "malformed"
            ? "report_malformed"
            : "report_unsupported_version";
    return fail(kind, parsed.detail, podName, couldHaveDeleted);
  }

  // Cheap cross-check on the adoption above: a report for the other mode means
  // the pod we read is not running the Job we think it is. Refused rather than
  // returned, because an `inventory` payload read as an `execute` result — or
  // the reverse — is exactly the confusion that produces a wrong plan.
  if (parsed.report.kind !== mode) {
    return fail(
      "report_mode_mismatch",
      `Job ${jobName} was launched in mode ${mode} but its pod reported kind ${parsed.report.kind}`,
      podName,
      couldHaveDeleted,
    );
  }

  return {
    ok: true,
    report: parsed.report,
    jobName,
    namespace,
    mode,
    claimName,
    podName,
    adopted,
  };
}
