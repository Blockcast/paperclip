import * as k8s from "@kubernetes/client-node";

import { logger } from "../middleware/logger.js";
import { redactSensitiveText } from "../redaction.js";

// Namespace where the claude_k8s / opencode_k8s adapters create their agent
// Job pods. Matches the chart's deploy namespace; an explicit env override
// is supported for unusual deployments.
const PAPERCLIP_K8S_NAMESPACE = process.env.PAPERCLIP_K8S_NAMESPACE ?? "paperclip";
const ENABLE_K8S_JOB_LIVENESS_IN_TESTS =
  process.env.PAPERCLIP_ENABLE_K8S_JOB_LIVENESS_IN_TESTS === "true";
const IS_TEST_ENVIRONMENT = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
const K8S_JOB_LIVENESS_TIMEOUT_MS = Number(
  process.env.PAPERCLIP_K8S_JOB_LIVENESS_TIMEOUT_MS ??
    (IS_TEST_ENVIRONMENT ? "100" : "2000"),
);
const K8S_JOB_LIVENESS_TIMEOUT_SECONDS = Math.max(
  1,
  Math.ceil(K8S_JOB_LIVENESS_TIMEOUT_MS / 1000),
);

// Agent Job manifests carry app.kubernetes.io/managed-by=paperclip and a
// paperclip.io/run-id label that maps directly to heartbeat_runs.id. The
// adapters set both unconditionally; see paperclip-adapter-claude-k8s
// job-manifest.ts for the source of truth.
const AGENT_JOB_LABEL_SELECTOR = "app.kubernetes.io/managed-by=paperclip";
const RUN_ID_LABEL = "paperclip.io/run-id";
const AGENT_ID_LABEL = "paperclip.io/agent-id";
const ADAPTER_TYPE_LABEL_NAME = "paperclip.io/adapter-type";
export const ADAPTER_TYPE_LABEL = ADAPTER_TYPE_LABEL_NAME;

// Set by the Job controller on every pod it creates; the documented way to get
// from a Job name to its pods.
const JOB_NAME_LABEL = "job-name";

// Failure diagnostics are bounded on purpose: they land in a run record that is
// read back into agent context, so an unbounded transcript would be both a cost
// and a context-window problem.
const FAILURE_LOG_TAIL_LINES = Math.max(
  1,
  Number(process.env.PAPERCLIP_K8S_FAILURE_LOG_TAIL_LINES ?? "80"),
);
const FAILURE_LOG_TAIL_MAX_BYTES = Math.max(
  1024,
  Number(process.env.PAPERCLIP_K8S_FAILURE_LOG_TAIL_MAX_BYTES ?? "16384"),
);

export type AgentJobRunStatus = {
  phase: "active" | "succeeded" | "failed";
  reason?: string | null;
  message?: string | null;
  // The backing Job's metadata.name. Populated by listAgentJobRunStatuses so
  // callers can persist run→Job navigability onto the heartbeat_run record
  // (heartbeat_runs.external_run_id). classifyAgentJobRunStatus itself does not
  // set it — it only classifies phase.
  name?: string | null;
  uid?: string | null;
};

export type AgentJobRunStatusByName =
  | AgentJobRunStatus
  | {
      phase: "missing";
      reason: "NotFound";
      message?: string | null;
      name: string;
    };

export type ManagedAgentJob = AgentJobRunStatus & {
  runId: string | null;
  agentId: string | null;
  name: string;
  uid: string;
  createdAt: Date | null;
};

export type ManagedAgentPod = {
  name: string;
  uid: string;
  runId: string | null;
  agentId: string | null;
  adapterType: string | null;
  phase: string | null;
  isActiveOrTerminating: boolean;
  deletionTimestamp: Date | null;
  createdAt: Date | null;
};

export type ExactAgentJobIdentity = {
  runId: string;
  agentId: string;
  name: string;
  uid: string;
};

/**
 * Per-container terminal state for a failed agent Job.
 *
 * A Job's `Failed` condition only ever says "Job has reached the specified
 * backoff limit" — it names no container and carries no exit code, so
 * classifyAgentJobRunStatus alone cannot say what actually died. These fields
 * come from the pod's containerStatuses instead.
 */
export type AgentJobContainerDiagnostic = {
  container: string;
  kind: "init" | "app";
  exitCode: number | null;
  reason: string | null;
  signal: number | null;
  /**
   * The container's /dev/termination-log, redacted. For containers that die
   * before producing any stdout — the exit-128 class, which terminates ~4s in,
   * before the adapter's `claude | tee` pipeline ever opens its target — this
   * is the *only* failure detail that exists anywhere.
   */
  terminationMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type AgentJobFailureDiagnostics = {
  jobName: string;
  podName: string | null;
  podPhase: string | null;
  containers: AgentJobContainerDiagnostic[];
  /**
   * Redacted tail of the pod's own log stream. Routinely empty for claude_k8s:
   * that adapter's wrapper discards container stdout (`… | awk … > /dev/null`)
   * and tees the real transcript to the data PVC. An empty tail is therefore
   * normal, not evidence that the logs were lost to pod GC.
   */
  logTail: string | null;
  logTailTruncated: boolean;
};

type ClientState =
  | { kind: "uninitialized" }
  | { kind: "unavailable"; reason: string }
  | { kind: "ready"; batchApi: k8s.BatchV1Api; coreApi: k8s.CoreV1Api };

let clientState: ClientState = { kind: "uninitialized" };

function requestOptionsWithTimeout() {
  return {
    middlewareMergeStrategy: "append" as const,
    promiseMiddleware: [
      {
        async pre(context: { setSignal(signal: AbortSignal): void }) {
          context.setSignal(AbortSignal.timeout(K8S_JOB_LIVENESS_TIMEOUT_MS));
          return context;
        },
        async post<T>(context: T) {
          return context;
        },
      },
    ],
  };
}

function initClient(): ClientState {
  if (clientState.kind !== "uninitialized") return clientState;
  try {
    const kc = new k8s.KubeConfig();
    if (IS_TEST_ENVIRONMENT && !ENABLE_K8S_JOB_LIVENESS_IN_TESTS) {
      clientState = { kind: "unavailable", reason: "disabled in test environment" };
      return clientState;
    }
    // In-cluster (mounted SA token) is the production path. For local dev
    // we deliberately don't fall back to loadFromDefault — the reaper would
    // otherwise hit the developer's personal kubeconfig and list Jobs in
    // a cluster it has nothing to do with.
    if (process.env.KUBERNETES_SERVICE_HOST) {
      kc.loadFromCluster();
    } else {
      clientState = { kind: "unavailable", reason: "not running in a kubernetes pod" };
      return clientState;
    }
    const batchApi = kc.makeApiClient(k8s.BatchV1Api);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    clientState = { kind: "ready", batchApi, coreApi };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn({ error: reason }, "k8s job-liveness client init failed; falling back to staleness heuristic");
    clientState = { kind: "unavailable", reason };
  }
  return clientState;
}

const RUN_ID_LABEL_FILTER_PREFIX = `${RUN_ID_LABEL}=`;

function conditionIsTrue(condition: k8s.V1JobCondition | undefined) {
  return condition?.status === "True";
}

function readNumericField(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" ? candidate : null;
}

function isKubernetesNotFoundError(error: unknown) {
  if (readNumericField(error, "code") === 404 || readNumericField(error, "statusCode") === 404) {
    return true;
  }
  const response = error && typeof error === "object"
    ? (error as Record<string, unknown>).response
    : null;
  return readNumericField(response, "statusCode") === 404 ||
    readNumericField(response, "status") === 404;
}

export function classifyAgentJobRunStatus(job: k8s.V1Job): AgentJobRunStatus {
  const conditions = job.status?.conditions ?? [];
  const failedCondition = conditions.find((condition) => condition.type === "Failed");
  if (conditionIsTrue(failedCondition)) {
    return {
      phase: "failed",
      reason: failedCondition?.reason ?? null,
      message: failedCondition?.message ?? null,
    };
  }

  const completeCondition = conditions.find((condition) => condition.type === "Complete");
  const active = job.status?.active ?? 0;
  const succeeded = job.status?.succeeded ?? 0;
  const expectedCompletions = job.spec?.completions ?? 1;
  if (conditionIsTrue(completeCondition) || (active <= 0 && succeeded >= expectedCompletions)) {
    return {
      phase: "succeeded",
      reason: completeCondition?.reason ?? "Complete",
      message: completeCondition?.message ?? null,
    };
  }

  return { phase: "active", reason: null, message: null };
}

/**
 * Reads one persisted backing Job by name. A successful namespace-wide list can
 * still miss a just-deleted Job, so callers use this exact lookup to
 * distinguish "not in the list yet" from "the recorded Job is actually gone".
 */
export async function readAgentJobRunStatusByName(
  name: string,
): Promise<AgentJobRunStatusByName | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const state = initClient();
  if (state.kind !== "ready") return null;
  try {
    const job = await state.batchApi.readNamespacedJob(
      {
        name: trimmed,
        namespace: PAPERCLIP_K8S_NAMESPACE,
      },
      requestOptionsWithTimeout(),
    );
    return {
      ...classifyAgentJobRunStatus(job),
      name: job.metadata?.name ?? trimmed,
      uid: job.metadata?.uid ?? null,
    };
  } catch (error) {
    if (isKubernetesNotFoundError(error)) {
      return {
        phase: "missing",
        reason: "NotFound",
        message: `Kubernetes Job ${trimmed} was not found`,
        name: trimmed,
      };
    }
    logger.warn(
      { jobName: trimmed, error: error instanceof Error ? error.message : String(error) },
      "k8s job-liveness exact Job lookup failed; falling back to staleness heuristic",
    );
    return null;
  }
}

/**
 * Returns the current Kubernetes Job phase by heartbeat run ID for managed
 * external-lifecycle agent Jobs, or null when the kube API cannot be queried.
 */
export async function listManagedAgentJobs(): Promise<ManagedAgentJob[] | null> {
  const state = initClient();
  if (state.kind !== "ready") return null;
  try {
    const list = await state.batchApi.listNamespacedJob(
      {
        namespace: PAPERCLIP_K8S_NAMESPACE,
        labelSelector: AGENT_JOB_LABEL_SELECTOR,
        timeoutSeconds: K8S_JOB_LIVENESS_TIMEOUT_SECONDS,
      },
      requestOptionsWithTimeout(),
    );
    const jobs: ManagedAgentJob[] = [];
    for (const job of list.items ?? []) {
      const name = job.metadata?.name?.trim();
      const uid = job.metadata?.uid?.trim();
      if (!name || !uid) continue;
      const runId = job.metadata?.labels?.[RUN_ID_LABEL]?.trim() || null;
      const agentId = job.metadata?.labels?.[AGENT_ID_LABEL]?.trim() || null;
      const createdAtRaw = job.metadata?.creationTimestamp;
      const createdAt = createdAtRaw ? new Date(createdAtRaw) : null;
      jobs.push({
        ...classifyAgentJobRunStatus(job),
        runId,
        agentId,
        name,
        uid,
        createdAt: createdAt && Number.isFinite(createdAt.getTime()) ? createdAt : null,
      });
    }
    return jobs;
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "k8s job-liveness status list failed; falling back to staleness heuristic",
    );
    return null;
  }
}

export async function listManagedAgentPods(): Promise<ManagedAgentPod[] | null> {
  const state = initClient();
  if (state.kind !== "ready") return null;
  try {
    const list = await state.coreApi.listNamespacedPod(
      {
        namespace: PAPERCLIP_K8S_NAMESPACE,
        labelSelector: AGENT_JOB_LABEL_SELECTOR,
        timeoutSeconds: K8S_JOB_LIVENESS_TIMEOUT_SECONDS,
      },
      requestOptionsWithTimeout(),
    );
    const pods: ManagedAgentPod[] = [];
    for (const pod of list.items ?? []) {
      const classified = classifyManagedAgentPod(pod);
      if (classified) pods.push(classified);
    }
    return pods;
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "k8s managed-pod list failed; skipping orphaned-pod reap this tick",
    );
    return null;
  }
}

function toIsoOrNull(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

export function readContainerDiagnostic(
  status: k8s.V1ContainerStatus,
  kind: "init" | "app",
): AgentJobContainerDiagnostic | null {
  // Prefer the current terminal state; fall back to lastState so a container
  // that was restarted still reports why the previous attempt died.
  const terminated = status.state?.terminated ?? status.lastState?.terminated;
  if (!terminated) return null;
  const message = typeof terminated.message === "string" ? terminated.message.trim() : "";
  return {
    container: status.name,
    kind,
    exitCode: typeof terminated.exitCode === "number" ? terminated.exitCode : null,
    reason: terminated.reason ?? null,
    signal: typeof terminated.signal === "number" ? terminated.signal : null,
    terminationMessage: message ? redactSensitiveText(message) : null,
    startedAt: toIsoOrNull(terminated.startedAt),
    finishedAt: toIsoOrNull(terminated.finishedAt),
  };
}

/**
 * Picks the pod that best explains a Job failure: a Failed pod first, then the
 * most recently started one. A Job at its backoff limit can leave several pods
 * behind, and the successful earlier attempts explain nothing.
 */
export function pickDiagnosticPod(pods: readonly k8s.V1Pod[]): k8s.V1Pod | null {
  if (pods.length === 0) return null;
  const startedAtMs = (pod: k8s.V1Pod) => {
    const started = toIsoOrNull(pod.status?.startTime) ?? toIsoOrNull(pod.metadata?.creationTimestamp);
    return started ? new Date(started).getTime() : 0;
  };
  const ranked = [...pods].sort((a, b) => {
    const aFailed = a.status?.phase === "Failed" ? 1 : 0;
    const bFailed = b.status?.phase === "Failed" ? 1 : 0;
    if (aFailed !== bFailed) return bFailed - aFailed;
    return startedAtMs(b) - startedAtMs(a);
  });
  return ranked[0] ?? null;
}

/**
 * Reads the terminal container state and a bounded, redacted log tail for a
 * failed agent Job, so the failure survives pod GC in the run record.
 *
 * Motivation: the Job `Failed` condition is generic ("backoff limit"), and the
 * pod that carries the real exit code is deleted by GC shortly after. Capturing
 * at failure-detection time is what makes an exit-128 recurrence falsifiable
 * rather than a dead end.
 *
 * Never throws: diagnostics are best-effort and must not break liveness
 * reconciliation. Returns null only when the kube API is unusable.
 */
export async function captureAgentJobFailureDiagnostics(
  jobName: string,
): Promise<AgentJobFailureDiagnostics | null> {
  const trimmed = jobName.trim();
  if (!trimmed) return null;
  const state = initClient();
  if (state.kind !== "ready") return null;

  let pod: k8s.V1Pod | null = null;
  try {
    const list = await state.coreApi.listNamespacedPod(
      {
        namespace: PAPERCLIP_K8S_NAMESPACE,
        labelSelector: `${JOB_NAME_LABEL}=${trimmed}`,
        timeoutSeconds: K8S_JOB_LIVENESS_TIMEOUT_SECONDS,
      },
      requestOptionsWithTimeout(),
    );
    pod = pickDiagnosticPod(list.items ?? []);
  } catch (error) {
    logger.warn(
      { jobName: trimmed, error: error instanceof Error ? error.message : String(error) },
      "k8s failure-diagnostics pod lookup failed; recording Job-level failure only",
    );
    return null;
  }

  if (!pod) {
    // Pod already GC'd. Report the absence explicitly rather than null so the
    // caller can distinguish "nothing to capture" from "capture unavailable".
    return {
      jobName: trimmed,
      podName: null,
      podPhase: null,
      containers: [],
      logTail: null,
      logTailTruncated: false,
    };
  }

  const containers: AgentJobContainerDiagnostic[] = [];
  for (const status of pod.status?.initContainerStatuses ?? []) {
    const diagnostic = readContainerDiagnostic(status, "init");
    if (diagnostic) containers.push(diagnostic);
  }
  for (const status of pod.status?.containerStatuses ?? []) {
    const diagnostic = readContainerDiagnostic(status, "app");
    if (diagnostic) containers.push(diagnostic);
  }

  const podName = pod.metadata?.name ?? null;
  const logTarget =
    containers.find((entry) => entry.kind === "app" && (entry.exitCode ?? 0) !== 0) ??
    containers.find((entry) => entry.kind === "app") ??
    null;

  let logTail: string | null = null;
  let logTailTruncated = false;
  if (podName && logTarget) {
    try {
      const raw = await state.coreApi.readNamespacedPodLog(
        {
          name: podName,
          namespace: PAPERCLIP_K8S_NAMESPACE,
          container: logTarget.container,
          tailLines: FAILURE_LOG_TAIL_LINES,
          limitBytes: FAILURE_LOG_TAIL_MAX_BYTES,
        },
        requestOptionsWithTimeout(),
      );
      const text = typeof raw === "string" ? raw : "";
      if (text.trim()) {
        const redacted = redactSensitiveText(text);
        logTailTruncated = redacted.length > FAILURE_LOG_TAIL_MAX_BYTES;
        logTail = logTailTruncated ? redacted.slice(-FAILURE_LOG_TAIL_MAX_BYTES) : redacted;
      }
    } catch (error) {
      // A GC'd or never-started container has no readable log. That is an
      // expected outcome, so keep the container-status diagnostics we already
      // collected instead of discarding the whole capture.
      logger.debug(
        { jobName: trimmed, podName, error: error instanceof Error ? error.message : String(error) },
        "k8s failure-diagnostics log read failed; keeping container statuses",
      );
    }
  }

  return {
    jobName: trimmed,
    podName,
    podPhase: pod.status?.phase ?? null,
    containers,
    logTail,
    logTailTruncated,
  };
}

/**
 * Compatibility view for callers that consume one status per run. Duplicate
 * run labels are intentionally omitted: ambiguity is not a liveness signal.
 */
export async function listAgentJobRunStatuses(): Promise<Map<string, AgentJobRunStatus> | null> {
  const jobs = await listManagedAgentJobs();
  if (jobs === null) return null;
  return indexUniqueAgentJobRunStatuses(jobs);
}

export function indexUniqueAgentJobRunStatuses(
  jobs: readonly ManagedAgentJob[],
): Map<string, AgentJobRunStatus> {
  const byRun = new Map<string, ManagedAgentJob[]>();
  for (const job of jobs) {
    if (!job.runId) continue;
    const candidates = byRun.get(job.runId) ?? [];
    candidates.push(job);
    byRun.set(job.runId, candidates);
  }
  const statuses = new Map<string, AgentJobRunStatus>();
  for (const [runId, candidates] of byRun) {
    if (candidates.length !== 1) {
      logger.error(
        { runId, jobs: candidates.map(({ name, uid }) => ({ name, uid })) },
        "k8s Job inventory contains duplicate run labels; refusing to select a Job",
      );
      continue;
    }
    statuses.set(runId, candidates[0]);
  }
  return statuses;
}

export function matchExactAgentJob(
  jobs: readonly ManagedAgentJob[],
  identity: ExactAgentJobIdentity,
): { kind: "exact"; job: ManagedAgentJob } | { kind: "missing" } | { kind: "ambiguous"; jobs: ManagedAgentJob[] } {
  const candidates = jobs.filter((job) => job.runId === identity.runId);
  const exact = candidates.filter((job) =>
    job.agentId === identity.agentId && job.name === identity.name && job.uid === identity.uid
  );
  if (candidates.length === 1 && exact.length === 1) return { kind: "exact", job: exact[0] };
  if (candidates.length === 0) return { kind: "missing" };
  return { kind: "ambiguous", jobs: candidates };
}

/**
 * Returns the set of heartbeat run IDs that currently have a live Job in the
 * paperclip namespace. Runs whose Job has completed or failed are absent from
 * the set so callers that only understand liveness don't treat terminal Jobs
 * as still running.
 *
 * Returns null when the kube API is unavailable (not in cluster, RBAC missing,
 * transient API error). Callers fall back to the time-based staleness window
 * in that case.
 */
export async function listLiveAgentJobRunIds(): Promise<Set<string> | null> {
  const statuses = await listAgentJobRunStatuses();
  if (statuses === null) return null;
  const runIds = new Set<string>();
  for (const [runId, status] of statuses) {
    if (status.phase === "active") runIds.add(runId);
  }
  return runIds;
}

/**
 * Cascade-delete the Job(s) whose `paperclip.io/run-id` label matches the given
 * run, propagating to the Pod (Background propagation = the Job controller
 * cleans up child Pods asynchronously). Used by the reaper when an
 * external-lifecycle run is being marked `process_lost` so its dispatch lock
 * unwedges; without this the next dispatch precondition check finds the live
 * Job and rejects with "Concurrent run blocked".
 *
 * Returns the number of Jobs deleted, or null when the kube API is unavailable
 * or fails. Caller should treat null as best-effort (the run still gets the
 * status flip; the operator may have to clean the Job by hand).
 */
export async function deleteAgentJobsForRun(runId: string): Promise<number | null> {
  if (!runId) return 0;
  const state = initClient();
  if (state.kind !== "ready") return null;
  try {
    const list = await state.batchApi.listNamespacedJob(
      {
        namespace: PAPERCLIP_K8S_NAMESPACE,
        labelSelector: `${AGENT_JOB_LABEL_SELECTOR},${RUN_ID_LABEL_FILTER_PREFIX}${runId}`,
        timeoutSeconds: K8S_JOB_LIVENESS_TIMEOUT_SECONDS,
      },
      requestOptionsWithTimeout(),
    );
    let deleted = 0;
    for (const job of list.items ?? []) {
      const name = job.metadata?.name;
      if (!name) continue;
      try {
        await state.batchApi.deleteNamespacedJob(
          {
            name,
            namespace: PAPERCLIP_K8S_NAMESPACE,
            propagationPolicy: "Background",
          },
          requestOptionsWithTimeout(),
        );
        deleted += 1;
      } catch (error) {
        logger.warn(
          { runId, jobName: name, error: error instanceof Error ? error.message : String(error) },
          "k8s deleteAgentJobsForRun: per-job delete failed",
        );
      }
    }
    return deleted;
  } catch (error) {
    logger.warn(
      { runId, error: error instanceof Error ? error.message : String(error) },
      "k8s deleteAgentJobsForRun: list failed",
    );
    return null;
  }
}

export async function deleteAgentJobExact(
  identity: ExactAgentJobIdentity,
): Promise<"deleted" | "missing" | "mismatch" | null> {
  const state = initClient();
  if (state.kind !== "ready") return null;
  try {
    const job = await state.batchApi.readNamespacedJob(
      { name: identity.name, namespace: PAPERCLIP_K8S_NAMESPACE },
      requestOptionsWithTimeout(),
    );
    const labels = job.metadata?.labels;
    if (
      job.metadata?.uid !== identity.uid
      || labels?.[RUN_ID_LABEL] !== identity.runId
      || labels?.[AGENT_ID_LABEL] !== identity.agentId
    ) {
      logger.error(
        {
          identity,
          observed: {
            uid: job.metadata?.uid ?? null,
            runId: labels?.[RUN_ID_LABEL] ?? null,
            agentId: labels?.[AGENT_ID_LABEL] ?? null,
          },
        },
        "refusing to delete k8s Job whose persisted identity does not match",
      );
      return "mismatch";
    }
    await state.batchApi.deleteNamespacedJob(
      {
        name: identity.name,
        namespace: PAPERCLIP_K8S_NAMESPACE,
        propagationPolicy: "Background",
        body: { preconditions: { uid: identity.uid } },
      },
      requestOptionsWithTimeout(),
    );
    return "deleted";
  } catch (error) {
    if (isKubernetesNotFoundError(error)) return "missing";
    logger.warn(
      { identity, error: error instanceof Error ? error.message : String(error) },
      "exact k8s Job deletion failed",
    );
    return null;
  }
}

export async function deleteAgentPodExact(identity: {
  name: string;
  uid: string;
  runId: string;
  agentId: string;
}): Promise<"deleted" | "missing" | "mismatch" | null> {
  const state = initClient();
  if (state.kind !== "ready") return null;
  try {
    const pod = await state.coreApi.readNamespacedPod(
      { name: identity.name, namespace: PAPERCLIP_K8S_NAMESPACE },
      requestOptionsWithTimeout(),
    );
    const labels = pod.metadata?.labels;
    if (
      pod.metadata?.uid !== identity.uid
      || labels?.[RUN_ID_LABEL] !== identity.runId
      || labels?.[AGENT_ID_LABEL] !== identity.agentId
    ) {
      logger.error(
        {
          identity,
          observed: {
            uid: pod.metadata?.uid ?? null,
            runId: labels?.[RUN_ID_LABEL] ?? null,
            agentId: labels?.[AGENT_ID_LABEL] ?? null,
          },
        },
        "refusing to delete k8s Pod whose persisted identity does not match",
      );
      return "mismatch";
    }
    await state.coreApi.deleteNamespacedPod(
      {
        name: identity.name,
        namespace: PAPERCLIP_K8S_NAMESPACE,
        gracePeriodSeconds: 0,
        body: { preconditions: { uid: identity.uid } },
      },
      requestOptionsWithTimeout(),
    );
    return "deleted";
  } catch (error) {
    if (isKubernetesNotFoundError(error)) return "missing";
    logger.warn(
      { identity, error: error instanceof Error ? error.message : String(error) },
      "exact k8s Pod deletion failed",
    );
    return null;
  }
}

// Verified against production Job pod labels (kubectl get pods -l app.kubernetes.io/managed-by=paperclip)
// and adapter sources at paperclip-adapter-{claude,opencode}-k8s/src/server/job-manifest.ts
// which set "paperclip.io/agent-id" (hyphen) on every agent Job.
export function isActiveOrTerminatingAgentPod(pod: k8s.V1Pod): boolean {
  if (pod.metadata?.deletionTimestamp) return true;
  const phase = pod.status?.phase;
  return phase !== "Succeeded" && phase !== "Failed";
}

export function classifyManagedAgentPod(pod: k8s.V1Pod): ManagedAgentPod | null {
  const name = pod.metadata?.name?.trim();
  const uid = pod.metadata?.uid?.trim();
  if (!name || !uid) return null;
  const labels = pod.metadata?.labels;
  const deletionRaw = pod.metadata?.deletionTimestamp;
  const deletionTimestamp = deletionRaw ? new Date(deletionRaw) : null;
  const createdAtRaw = pod.metadata?.creationTimestamp;
  const createdAt = createdAtRaw ? new Date(createdAtRaw) : null;
  return {
    name,
    uid,
    runId: labels?.[RUN_ID_LABEL]?.trim() || null,
    agentId: labels?.[AGENT_ID_LABEL]?.trim() || null,
    adapterType: labels?.[ADAPTER_TYPE_LABEL_NAME]?.trim() || null,
    phase: pod.status?.phase ?? null,
    isActiveOrTerminating: isActiveOrTerminatingAgentPod(pod),
    deletionTimestamp:
      deletionTimestamp && Number.isFinite(deletionTimestamp.getTime()) ? deletionTimestamp : null,
    createdAt: createdAt && Number.isFinite(createdAt.getTime()) ? createdAt : null,
  };
}

/**
 * BLO-20801: `hasActiveJobForAgent`'s Job-status check is agent-scoped only
 * (no run-id awareness), so a Job that survives a worker crash after its run
 * was already stamped terminal in the DB blocks dispatch for the full
 * `EXTERNAL_LIFECYCLE_HARD_STALE_MS` reaper ceiling. A Job whose `runId`
 * label is in `terminalRunIds` is known-terminal at the DB layer and must not
 * count as active, regardless of its own (possibly stale/zeroed/missing)
 * status subresource. Jobs with no run-id label, or whose run-id is not in
 * `terminalRunIds` (live, unknown, or the caller opted out of the lookup),
 * fall through to the original status-counter heuristic unchanged.
 */
export function jobBlocksDispatch(job: k8s.V1Job, terminalRunIds: ReadonlySet<string>): boolean {
  const runId = job.metadata?.labels?.[RUN_ID_LABEL]?.trim() || null;
  if (runId && terminalRunIds.has(runId)) return false;
  const status = job.status;
  if (!status) return true;
  const active = status.active ?? 0;
  const succeeded = status.succeeded ?? 0;
  const failed = status.failed ?? 0;
  return active > 0 || (succeeded === 0 && failed === 0);
}

export type HasActiveJobForAgentOptions = {
  /**
   * Given the distinct, non-null run-id labels found on this agent's Jobs,
   * returns the subset whose heartbeat_runs row is already terminal in the
   * DB. Omit to preserve the pre-BLO-20801 behavior of never excluding a Job
   * by run-id (every candidate Job counts purely on its k8s status).
   */
  isRunTerminal?: (runIds: readonly string[]) => Promise<ReadonlySet<string>>;
};

/**
 * Returns true when there is at least one active (not yet completed) Job for
 * the given agent in the paperclip namespace. Returns false when the kube API
 * is unavailable (not in cluster, RBAC missing, transient error) so the
 * caller can degrade to DB-only in-flight detection.
 */
export async function hasActiveJobForAgent(
  agentId: string,
  options?: HasActiveJobForAgentOptions,
): Promise<boolean> {
  const state = initClient();
  if (state.kind !== "ready") return false;
  try {
    const res = await state.batchApi.listNamespacedJob(
      {
        namespace: PAPERCLIP_K8S_NAMESPACE,
        labelSelector: `${AGENT_JOB_LABEL_SELECTOR},${AGENT_ID_LABEL}=${agentId}`,
        timeoutSeconds: K8S_JOB_LIVENESS_TIMEOUT_SECONDS,
      },
      requestOptionsWithTimeout(),
    );
    const items = res.items ?? [];
    const candidateRunIds = [
      ...new Set(
        items
          .map((job) => job.metadata?.labels?.[RUN_ID_LABEL]?.trim() || null)
          .filter((runId): runId is string => Boolean(runId)),
      ),
    ];
    // The DB lookup is deliberately isolated from the outer try/catch below:
    // that catch means "the kube API is unreachable" and fails OPEN (dispatch
    // proceeds). A rejected isRunTerminal after Kubernetes already returned an
    // active Job is the opposite situation -- kube is fine, we just can't
    // confirm the run is terminal -- so it must fail CLOSED (treat every
    // candidate Job as non-terminal, i.e. still blocking) instead of being
    // swallowed into the fail-open path.
    let terminalRunIds: ReadonlySet<string> = new Set<string>();
    if (candidateRunIds.length > 0 && options?.isRunTerminal) {
      try {
        terminalRunIds = await options.isRunTerminal(candidateRunIds);
      } catch (error) {
        logger.warn(
          {
            agentId,
            runIds: candidateRunIds,
            error: error instanceof Error ? error.message : String(error),
          },
          "k8s job-liveness isRunTerminal callback failed; treating all candidate Jobs as non-terminal",
        );
        terminalRunIds = new Set<string>();
      }
    }
    const hasActiveJob = items.some((job) => jobBlocksDispatch(job, terminalRunIds));
    if (hasActiveJob) {
      return true;
    }

    // A just-deleted Job can already look terminal while its Pod is still
    // terminating and holding a ReadWriteOnce agent PVC on the old node. This
    // probe is deliberately NOT filtered by terminalRunIds/run-id: a run
    // being terminal in the DB says nothing about whether its pod has
    // released the PVC yet, and folding the two gates together would let a
    // new pod dispatch into a multi-attach wedge.
    const podRes = await state.coreApi.listNamespacedPod(
      {
        namespace: PAPERCLIP_K8S_NAMESPACE,
        labelSelector: `${AGENT_JOB_LABEL_SELECTOR},${AGENT_ID_LABEL}=${agentId}`,
        timeoutSeconds: K8S_JOB_LIVENESS_TIMEOUT_SECONDS,
      },
      requestOptionsWithTimeout(),
    );
    return (podRes.items ?? []).some(isActiveOrTerminatingAgentPod);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn({ agentId, error: reason }, "k8s in-flight check failed; falling back to DB-only");
    return false;
  }
}

/** Test-only hook to force re-init (e.g. after env changes). */
export function __resetK8sJobLivenessClient() {
  clientState = { kind: "uninitialized" };
}
