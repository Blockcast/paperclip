import type { KubeClients } from "./kube-client.js";
import type { SandboxOrchestrator, SandboxStatus } from "./sandbox-orchestrator.js";
import { assertManifestHasNoLiteralSensitiveEnv } from "./sensitive-env-guard.js";

export class JobTimeoutError extends Error {
  constructor(namespace: string, name: string, timeoutMs: number) {
    super(`Job ${namespace}/${name} did not complete within ${timeoutMs}ms`);
    this.name = "JobTimeoutError";
  }
}

// BLO-22454: createJob is the sole agent-Job create site and had no 409
// handling, so a retry landing inside the Foreground-deletion window of a
// just-released Job (deleteJob below) collided with its own prior Job and
// threw an opaque error the run never recovered from. This error names the
// run id and the pre-existing Job so the failure is attributable without
// hand-reading an agent's errorReason field.
export class JobAlreadyExistsError extends Error {
  constructor(
    namespace: string,
    name: string,
    runId: string | undefined,
    reason: "ownership-mismatch" | "terminating-timeout" | "unreadable" | "no-uid",
  ) {
    const runIdPart = runId ? ` (run ${runId})` : "";
    const reasonText =
      reason === "ownership-mismatch"
        ? "the existing Job does not have the expected Paperclip identity labels"
        : reason === "terminating-timeout"
          ? "the existing Job remained Terminating past the bounded retry window"
        : reason === "unreadable"
          ? "the existing Job could not be read to adopt its uid"
          : "the existing Job has no uid to adopt";
    super(`Job ${namespace}/${name}${runIdPart} already exists and cannot be adopted: ${reasonText}`);
    this.name = "JobAlreadyExistsError";
  }
}

export interface CreateJobOptions {
  conflictRetryTimeoutMs?: number;
  conflictRetryPollMs?: number;
}

const CONFLICT_RETRY_TIMEOUT_MS = 10_000;
const CONFLICT_RETRY_POLL_MS = 250;
const IDENTITY_LABELS = [
  "paperclip.io/run-id",
  "paperclip.io/company-id",
  "paperclip.io/managed-by",
  "paperclip.io/adapter",
] as const;

export async function createJob(
  clients: KubeClients,
  namespace: string,
  manifest: Record<string, unknown>,
  options: CreateJobOptions = {},
): Promise<{ uid: string }> {
  // Choke point: this accepts an arbitrary manifest, so re-check here rather
  // than trusting that it came from buildJobManifest.
  assertManifestHasNoLiteralSensitiveEnv(manifest, `Job in ${namespace}`);
  const meta = (manifest.metadata as { name?: string; labels?: Record<string, string> } | undefined) ?? {};
  const name = meta.name;
  const runId = meta.labels?.["paperclip.io/run-id"];
  const retryTimeoutMs = options.conflictRetryTimeoutMs ?? CONFLICT_RETRY_TIMEOUT_MS;
  const retryPollMs = options.conflictRetryPollMs ?? CONFLICT_RETRY_POLL_MS;

  for (;;) {
    try {
      const result = await clients.batch.createNamespacedJob({ namespace, body: manifest as never });
      const uid = (result as { metadata?: { uid?: string } }).metadata?.uid;
      if (!uid) throw new Error("Job created without a UID");
      return { uid };
    } catch (err) {
      if (!isAlreadyExists(err) || !name) throw err;
      const existing = await readExistingJob(clients, namespace, name, runId);
      if (!existing) continue;
      assertExpectedIdentity(existing, meta.labels, namespace, name, runId);
      const uid = existing.metadata?.uid;
      if (!uid) throw new JobAlreadyExistsError(namespace, name, runId, "no-uid");
      if (!existing.metadata?.deletionTimestamp) return { uid };

      await waitForJobDeletion(
        clients,
        namespace,
        name,
        runId,
        meta.labels,
        uid,
        retryTimeoutMs,
        retryPollMs,
      );
    }
  }
}

type ExistingJob = {
  metadata?: { uid?: string; deletionTimestamp?: string; labels?: Record<string, string> };
};

async function readExistingJob(
  clients: KubeClients,
  namespace: string,
  name: string,
  runId: string | undefined,
): Promise<ExistingJob | null> {
  try {
    return (await clients.batch.readNamespacedJob({ namespace, name })) as ExistingJob;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw new JobAlreadyExistsError(namespace, name, runId, "unreadable");
  }
}

function assertExpectedIdentity(
  existing: ExistingJob,
  expectedLabels: Record<string, string> | undefined,
  namespace: string,
  name: string,
  runId: string | undefined,
): void {
  const labels = existing.metadata?.labels;
  if (IDENTITY_LABELS.some((key) => !expectedLabels?.[key] || labels?.[key] !== expectedLabels[key])) {
    throw new JobAlreadyExistsError(namespace, name, runId, "ownership-mismatch");
  }
}

async function waitForJobDeletion(
  clients: KubeClients,
  namespace: string,
  name: string,
  runId: string | undefined,
  expectedLabels: Record<string, string> | undefined,
  deletingUid: string,
  timeoutMs: number,
  pollMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await readExistingJob(clients, namespace, name, runId);
    if (!current) return;
    assertExpectedIdentity(current, expectedLabels, namespace, name, runId);
    if (current.metadata?.uid !== deletingUid || !current.metadata?.deletionTimestamp) return;
    if (Date.now() >= deadline) {
      throw new JobAlreadyExistsError(namespace, name, runId, "terminating-timeout");
    }
    await sleep(pollMs);
  }
}

function isAlreadyExists(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; statusCode?: number };
  return e.code === 409 || e.statusCode === 409;
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; statusCode?: number };
  return e.code === 404 || e.statusCode === 404;
}

export type JobStatus = SandboxStatus;

export async function getJobStatus(
  clients: KubeClients,
  namespace: string,
  name: string,
): Promise<JobStatus> {
  const result = await clients.batch.readNamespacedJobStatus({ namespace, name });
  const body = (result as Record<string, unknown>) ?? {};
  const status = (body.status as Record<string, unknown>) ?? {};
  const active = (status.active as number) ?? 0;
  const succeeded = (status.succeeded as number) ?? 0;
  const failed = (status.failed as number) ?? 0;
  const conditions = (status.conditions as { type: string; status: string; reason?: string; message?: string }[]) ?? [];
  const completed = conditions.find((c) => c.type === "Complete" && c.status === "True");
  const failedCond = conditions.find((c) => c.type === "Failed" && c.status === "True");
  if (failedCond || failed > 0) {
    return { phase: "Failed", complete: false, active, succeeded, failed, reason: failedCond?.reason, message: failedCond?.message };
  }
  if (completed || succeeded > 0) {
    return { phase: "Succeeded", complete: true, active, succeeded, failed };
  }
  if (active > 0) {
    return { phase: "Running", complete: false, active, succeeded, failed };
  }
  return { phase: "Pending", complete: false, active, succeeded, failed };
}

export async function findPodForJob(
  clients: KubeClients,
  namespace: string,
  jobName: string,
): Promise<string | null> {
  const result = await clients.core.listNamespacedPod({
    namespace,
    labelSelector: `job-name=${jobName}`,
  });
  const items = ((result as { items?: { metadata?: { name?: string }; status?: { phase?: string } }[] }).items) ?? [];
  const running = items.find((p) => p.status?.phase === "Running");
  return (running ?? items[0])?.metadata?.name ?? null;
}

export async function streamPodLogs(
  clients: KubeClients,
  namespace: string,
  podName: string,
  onChunk: (stream: "stdout" | "stderr", text: string) => Promise<void>,
): Promise<void> {
  // V1 limitation: readNamespacedPodLog returns combined stdout (the kubectl-style
  // log view). stderr is not separately exposed via this API path — agent
  // containers that need stderr/stdout separation should use a sidecar log
  // scraper or wrap their CLI to emit structured output on stdout. We always
  // emit chunks as "stdout"; the "stderr" callback slot in SandboxOrchestrator
  // is unused by the Job-backed implementation.
  const result = await clients.core.readNamespacedPodLog({ namespace, name: podName });
  const text = (result as string) ?? "";
  if (text.length > 0) await onChunk("stdout", text);
}

export async function deleteJob(
  clients: KubeClients,
  namespace: string,
  name: string,
): Promise<void> {
  await clients.batch.deleteNamespacedJob({
    namespace,
    name,
    propagationPolicy: "Foreground",
  });
}

export async function waitForJobCompletion(
  clients: KubeClients,
  namespace: string,
  name: string,
  opts: { timeoutMs: number; pollMs?: number } = { timeoutMs: 120_000, pollMs: 2000 },
): Promise<JobStatus> {
  const deadline = Date.now() + opts.timeoutMs;
  const pollMs = opts.pollMs ?? 2000;
  while (Date.now() < deadline) {
    const status = await getJobStatus(clients, namespace, name);
    if (status.phase === "Succeeded" || status.phase === "Failed") return status;
    await sleep(pollMs);
  }
  throw new JobTimeoutError(namespace, name, opts.timeoutMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Job-backed conformance to SandboxOrchestrator. Plugin.ts imports THIS value
 * (the swap point) — to use a different backend, swap this import for another
 * module exposing a SandboxOrchestrator-shaped default export.
 */
export const jobOrchestrator: SandboxOrchestrator = {
  claim: createJob,
  getStatus: getJobStatus,
  findPod: findPodForJob,
  streamLogs: streamPodLogs,
  release: deleteJob,
  waitForCompletion: waitForJobCompletion,
};
