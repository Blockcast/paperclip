import * as k8s from "@kubernetes/client-node";

import type { ReclaimJobPort } from "./isolation-reclaim-runner.js";

/**
 * The Kubernetes half of {@link ReclaimJobPort} (PEN-5151).
 *
 * `runIsolationReclaimJob` is written against four methods with no Kubernetes
 * error types in their signatures, so that its policy — when an adoption is
 * safe, when a missing pod is fatal — reads as a decision rather than a chain
 * of `instanceof` checks, and so that every branch of it is reachable from a
 * test with no kube API. This module is the other side of that line: it does
 * the translation and nothing else.
 *
 * ## It translates, it does not decide, and it does not retry
 *
 * Two statuses become values rather than throws, and only those two:
 *
 * - **`409 Conflict` on create ⇒ `"already_exists"`.** The runner treats that
 *   as a possible adoption and verifies the existing Job's mounted claim before
 *   attaching, so turning it into a value here is what lets that check exist.
 * - **`404` on read ⇒ `null`.** "The Job is not there" is a different fact from
 *   "the Job is not finished", and the runner branches on it.
 *
 * Everything else throws, including every 5xx and every timeout. That is
 * deliberate: the sweep above the runner records a thrown port error on the
 * `execute` phase as `deletionOutcomeUnknown`, and swallowing an apiserver
 * failure into a tidy value here would convert an unknown into a confident
 * wrong answer. Retry belongs in the runner's poll loop, which already has a
 * budget derived from the Job's own `activeDeadlineSeconds`; a retry here would
 * be a second, undeclared budget inside it.
 *
 * ## The pod log is read WHOLE, with no `limitBytes`
 *
 * The executor writes its report as the **last** line it emits. `limitBytes`
 * truncates from the START of what is read, so setting it without `tailLines`
 * returns the head of the log and drops the marker entirely — the parse would
 * come back `absent`, which says "look at the pod" about a pod that said
 * exactly what was wrong. `tailLines` keeps the end but can clip the marker
 * line itself, which parses as `malformed` and sends the reader after a format
 * bug that is really a log length.
 *
 * Neither is needed: the executor's output is bounded by `maxDeletes`, which
 * the manifest builder already caps, so the log is a few hundred lines. If that
 * ever stops being true the fix is a smaller `maxDeletes`, not a truncation
 * that silently changes which failure the operator is told about.
 *
 * ## `job-name`, not `batch.kubernetes.io/job-name`
 *
 * Both labels are applied by the Job controller on current Kubernetes, and the
 * unprefixed one is the form the rest of this server already selects on
 * (`k8s-job-liveness.ts`). Matching it keeps one convention rather than two,
 * and the prefixed label is the newer of the pair, so selecting on it would
 * narrow the clusters this works on for no gain.
 */

/** Per-request deadline for Job reads and creates. */
export const RECLAIM_PORT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Per-request deadline for `pods/log`. Longer than the rest: this is the one
 * call whose size scales with how much the executor did.
 */
export const RECLAIM_PORT_LOG_TIMEOUT_MS = 120_000;

/** The label the Job controller stamps on its pods. See the header. */
export const RECLAIM_JOB_NAME_LABEL = "job-name";

export interface IsolationReclaimJobPortClients {
  batchApi: k8s.BatchV1Api;
  coreApi: k8s.CoreV1Api;
}

/**
 * Re-derived rather than imported from `k8s-job-liveness.ts`, where the
 * equivalent helper is module-private.
 *
 * The shape is checked in four places because the client has reported the
 * status in each of them across versions, and a check that misses the one in
 * use fails in the direction that matters: a 404 read as "some other error"
 * aborts a sweep, and a 409 read as "some other error" turns a safe adoption
 * into a failed tick.
 */
function kubernetesStatusIs(error: unknown, status: number): boolean {
  const numeric = (value: unknown, key: string): number | null => {
    if (!value || typeof value !== "object") return null;
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "number" ? candidate : null;
  };
  if (numeric(error, "code") === status || numeric(error, "statusCode") === status) return true;
  const response =
    error && typeof error === "object" ? (error as Record<string, unknown>).response : null;
  return numeric(response, "statusCode") === status || numeric(response, "status") === status;
}

function requestOptions(timeoutMs: number) {
  return {
    middlewareMergeStrategy: "append" as const,
    promiseMiddleware: [
      {
        async pre(context: { setSignal(signal: AbortSignal): void }) {
          context.setSignal(AbortSignal.timeout(timeoutMs));
          return context;
        },
        async post<T>(context: T) {
          return context;
        },
      },
    ],
  };
}

/** Build the port over an already-constructed pair of API clients. */
export function createIsolationReclaimJobPort(
  clients: IsolationReclaimJobPortClients,
): ReclaimJobPort {
  return {
    async createJob(namespace, job) {
      try {
        await clients.batchApi.createNamespacedJob(
          { namespace, body: job },
          requestOptions(RECLAIM_PORT_REQUEST_TIMEOUT_MS),
        );
        return "created";
      } catch (error) {
        // A value, not an error: the runner verifies the existing Job's mounted
        // claim before adopting it. See the header.
        if (kubernetesStatusIs(error, 409)) return "already_exists";
        throw error;
      }
    },

    async readJob(namespace, name) {
      try {
        return await clients.batchApi.readNamespacedJob(
          { name, namespace },
          requestOptions(RECLAIM_PORT_REQUEST_TIMEOUT_MS),
        );
      } catch (error) {
        // `null` means 404 specifically, which the runner reads as "not there"
        // — distinct from "not finished". Any other failure throws.
        if (kubernetesStatusIs(error, 404)) return null;
        throw error;
      }
    },

    async listJobPods(namespace, jobName) {
      const list = await clients.coreApi.listNamespacedPod(
        { namespace, labelSelector: `${RECLAIM_JOB_NAME_LABEL}=${jobName}` },
        requestOptions(RECLAIM_PORT_REQUEST_TIMEOUT_MS),
      );
      // An empty list is a VALUE here, not a 404: the runner distinguishes
      // "terminal with no pod" (evicted, garbage-collected) from "the Job is
      // gone", and collapsing them would report a pod_absent as a missing Job.
      return list.items ?? [];
    },

    async readPodLog(namespace, podName, container) {
      // Whole log, no `limitBytes` and no `tailLines`. See the header: the
      // report is the last line, so a head truncation drops it and a tail
      // truncation can clip it, and each parses as a different wrong diagnosis.
      const raw = await clients.coreApi.readNamespacedPodLog(
        { name: podName, namespace, container },
        requestOptions(RECLAIM_PORT_LOG_TIMEOUT_MS),
      );
      return typeof raw === "string" ? raw : "";
    },
  };
}

/**
 * Construct the in-cluster clients, or report why not.
 *
 * In-cluster only, on the same reasoning as `k8s-job-liveness.ts`: falling back
 * to `loadFromDefault` would point a sweep that launches recursive unlinks at
 * whatever cluster a developer's personal kubeconfig happens to name. There is
 * no safe default for that, so the absence of a mounted service-account token
 * is an answer rather than a reason to look elsewhere.
 *
 * Returns a reason instead of throwing, so the caller can log one line and
 * leave the sweep unstarted rather than failing server startup over an optional
 * subsystem.
 */
export function createInClusterIsolationReclaimJobPort():
  | { ok: true; port: ReclaimJobPort }
  | { ok: false; reason: string } {
  if (!process.env.KUBERNETES_SERVICE_HOST) {
    return { ok: false, reason: "not running in a kubernetes pod" };
  }
  try {
    const kc = new k8s.KubeConfig();
    kc.loadFromCluster();
    return {
      ok: true,
      port: createIsolationReclaimJobPort({
        batchApi: kc.makeApiClient(k8s.BatchV1Api),
        coreApi: kc.makeApiClient(k8s.CoreV1Api),
      }),
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
