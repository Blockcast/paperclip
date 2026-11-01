/**
 * The Job that mounts a claim this process cannot walk (PEN-5151).
 *
 * PEN-4932 moves an opted-in agent's runs onto a per-agent PVC, and an
 * operator/environment `workspaceVolumeClaim` does the same one slot higher in
 * `resolveDataClaimName`'s precedence. Either way the isolation tree is
 * materialized on a volume the server has no mount on, so the mounted sweep in
 * `isolation-workspace-reaper.ts` cannot see it — and the miss is silent,
 * because that sweep's enumeration is directory-driven. `unreachableAgents` is
 * the standing record of it.
 *
 * Four pieces of the remedy already landed as plain functions:
 * `buildIsolationReclaimPlan` (#3184) decides, `collectIsolationWorkspaceInventory`
 * and `executeIsolationReclaimPlan` (#3186) are the executor's two ends, and
 * `isolation-reclaim-report.ts` + `cli/isolation-reclaim-executor.ts` (#3189)
 * are the wire and the entrypoint. **What was missing is a pod that mounts the
 * claim**, and that is this module: the manifest, as a pure function.
 *
 * It builds the manifest and nothing else — no API call, no waiting, no log
 * read. The driver that creates these Jobs and recovers their reports is a
 * separate concern and is deliberately not here, so that every property below
 * is stated as a value a test can assert rather than as the behaviour of a
 * call against a cluster.
 *
 * ## One manifest, two modes — and why that is load-bearing
 *
 * `inventory` and `execute` are the same pod spec, differing only in the
 * container's `args` and in whether the plan env var is set. That is not
 * economy; it is what makes the executor's root check meaningful. A root that
 * does not exist reports as a *valid empty result* in both modes (see the
 * hoisted `fs.stat` in `cli/isolation-reclaim-executor.ts`), so the two Jobs
 * have to be aimed at the same path by construction rather than by two call
 * sites agreeing. Ally's non-blocking note on #3189 made the dependency
 * explicit — the inventory tick catches an `execute` misconfiguration "only if
 * the two Jobs share a manifest" — and this is the function that settles it.
 *
 * ## Credential-free, and structurally so
 *
 * The pod mounts a volume it is about to delete from, so anything secret
 * reachable from it is exposed to exactly the tree under reclamation. The
 * executor needs no API access at all — it reads argv and one env var and
 * writes one line to stdout — so:
 *
 * - `automountServiceAccountToken: false`. Not a hardening nicety: the default
 *   is `true`, and the server's own ServiceAccount carries `secrets: get,list`
 *   plus `jobs: create`. Projecting that token into this pod would put the
 *   namespace's secrets one `curl` away from a process whose whole job is
 *   recursive deletion.
 * - No `envFrom`, no secret volumes, no `DATABASE_URL`. The plan arrives as
 *   one JSON env var and carries only workspace uuids.
 *
 * ## `PAPERCLIP_HOME` is pointed at an emptyDir, and that closes a named leak
 *
 * #3189's header left one side effect open: importing the reaper pulls
 * `middleware/logger.ts`, which at IMPORT time resolves a log directory,
 * `mkdirSync`s it and opens `server.log` for writing. `resolveDefaultLogsDir`
 * is `PAPERCLIP_HOME`-relative, so a pod with `PAPERCLIP_HOME` on the mounted
 * claim would have the reclaimer writing into the tree it is reclaiming,
 * before `main` runs.
 *
 * Two independent things close it here, and both are deliberate:
 *
 *  1. The claim is mounted at {@link RECLAIM_CLAIM_MOUNT_PATH} (`/reclaim`),
 *     NOT at `/paperclip`. The server mounts its own PVC at `/paperclip`
 *     (`SELF_POD_DATA_MOUNT_PATH`), and reusing that path here would make
 *     `--root` identical to `DEFAULT_ISOLATION_WORKSPACE_ROOT` — convenient,
 *     and precisely the confusion the executor refuses to allow by having no
 *     default root. A distinct mount path means no home-relative resolution
 *     can land on the claim by accident.
 *  2. `PAPERCLIP_HOME` is set explicitly to {@link RECLAIM_HOME_MOUNT_PATH},
 *     backed by an `emptyDir`. Container-local, dies with the pod, and is
 *     writable by the uid below without an init container.
 *
 * ## Why uid 1000, and not root
 *
 * Unlinking an entry needs write permission on its PARENT directory, so the
 * reclaimer's uid is load-bearing rather than cosmetic. It is set to 1000/1000
 * with `runAsNonRoot: true` because that is what the API server itself runs as
 * (`paperclip-api`, verified against the live Deployment: `runAsUser: 1000`,
 * `runAsGroup: 1000`, `runAsNonRoot: true`) — and the API server is the
 * process that successfully removes these same directories today, through the
 * mounted sweep. So uid 1000 is not a guess about the tree's ownership; it is
 * the uid that demonstrably owns it.
 *
 * Running as root "to be sure" would be strictly worse than the thing it
 * replaces: a privileged recursive unlink against a volume, in a pod, where
 * the non-privileged equivalent is known to work.
 *
 * ## Bounds, and the one that is NOT a plan-age guard
 *
 * - `backoffLimit: 0` with `restartPolicy: Never`. The transport refuses a log
 *   carrying two marked lines (`duplicate`) rather than guessing which process
 *   wrote which, so "exactly one pod per Job" is what keeps the normal path off
 *   that branch. It also matters for `execute` specifically: a retried pod
 *   would re-run a plan whose age bound has moved on under it.
 * - `activeDeadlineSeconds` bounds a wedged pod holding the claim. ⚠ It is
 *   **not** the plan-staleness guard and must not be read as one: it starts
 *   counting when the pod starts, so queueing and image pull — the unbounded
 *   part of the distance between "plan built" and "first unlink" — sit outside
 *   it entirely. `DEFAULT_MAX_PLAN_AGE_MS`, re-checked per entry inside
 *   `executeIsolationReclaimPlan`, is the only thing that closes that window.
 * - `ttlSecondsAfterFinished` is set, and set GENEROUSLY. The TTL controller
 *   deletes the Job and its pods, and the pod log dies with the pod — so a
 *   short TTL races the driver's own read and the loss surfaces as `absent`,
 *   the one parse failure whose remedy is "go and look at the pod". Pointing
 *   an operator at a pod the cluster garbage-collected is the worst available
 *   diagnostic, so the default leaves an hour.
 *
 * ## The plan rides the environment
 *
 * See `RECLAIM_PLAN_ENV` in `isolation-reclaim-report.ts` for why it is not a
 * ConfigMap (the server's Role has no `configmaps` verb, in any form). The
 * 128 KiB `MAX_ARG_STRLEN` ceiling that makes this sound is enforced *here*,
 * at build time, rather than left to the kubelet — over the limit, a container
 * fails to create with an error that names neither the variable nor the plan.
 */

import * as k8s from "@kubernetes/client-node";

import {
  RECLAIM_PLAN_ENV,
  type ReclaimPlanEnvelope,
} from "./isolation-reclaim-report.js";
import type { IsolationReclaimReportKind } from "./isolation-reclaim-report.js";

/**
 * Where the foreign claim is mounted inside the reclaim pod.
 *
 * Deliberately not `/paperclip` — see the header. Nothing else in the pod
 * writes under this path.
 */
export const RECLAIM_CLAIM_MOUNT_PATH = "/reclaim";

/** Where the `emptyDir` backing `PAPERCLIP_HOME` is mounted. */
export const RECLAIM_HOME_MOUNT_PATH = "/home/reclaim";

/**
 * The isolation tree's path RELATIVE to the root of a workspace claim.
 *
 * `DEFAULT_ISOLATION_WORKSPACE_ROOT` is this same suffix under the server's own
 * `/paperclip` mount. It is spelled separately rather than derived by stripping
 * a prefix off that constant, because the two are different facts that only
 * happen to coincide: one is "where the server's tree is", the other is "where
 * a tree sits inside any claim". A `String.replace` tying them together would
 * silently produce a wrong root the day the server's mount path moves.
 */
export const ISOLATION_WORKSPACES_CLAIM_SUBPATH =
  "instances/default/data/k8s-isolation/workspaces";

/** `--root` for a claim mounted at {@link RECLAIM_CLAIM_MOUNT_PATH}. */
export const RECLAIM_WORKSPACES_ROOT = `${RECLAIM_CLAIM_MOUNT_PATH}/${ISOLATION_WORKSPACES_CLAIM_SUBPATH}`;

/**
 * The executor entrypoint inside the image, and the loader that has to be in
 * front of it.
 *
 * ⚠ The loader is not optional and is not a dev-only convenience. The executor
 * imports `isolation-workspace-reaper.ts`, which imports `@paperclipai/db` as
 * a VALUE (the drizzle table objects). In the runtime image that package's
 * `exports` is `{".": "./src/index.ts"}` — TypeScript source — and its own
 * relative imports are spelled `./client.js`, the extension TypeScript wants
 * and the file that does not exist. Node's built-in type stripping does not
 * rewrite `.js` to `.ts`, so bare Node gets as far as the re-export and stops:
 *
 *   ERR_MODULE_NOT_FOUND: Cannot find module '/app/packages/db/src/client.js'
 *   imported from /app/packages/db/src/index.ts
 *
 * Measured, not inferred: that is the literal output of
 * `node --input-type=module -e 'import("@paperclipai/db")'` run from
 * `/app/server` in the shipped image (Node v24.16.0). The same import under
 * `node --import <loader>` resolves and yields 207 exports.
 *
 * So a bare `node <executor>` dies at import time, before `main` runs and
 * before any report line is written — which the transport reads as `absent`,
 * whose remedy is "go and look at the pod". The image's own `CMD`
 * (`Dockerfile.runtime`) and the MCP bridge in `statefulset.yaml` both carry
 * this same `--import` for this same reason.
 *
 * Setting `command` overrides the image ENTRYPOINT, so nothing else is left to
 * add the loader on our behalf — it has to be spelled here. Both paths are
 * absolute rather than `WORKDIR`-relative, matching how `statefulset.yaml`
 * spells the bridge: the manifest never sets `workingDir`, so a relative form
 * would quietly depend on the image's `WORKDIR` staying `/app`.
 *
 * No unit test can catch a module-resolution failure that only exists inside
 * the image. The test below pins this argv so it cannot drift; to check the
 * argv itself against a shipped tag, one container run is enough:
 *
 *   docker run --rm --entrypoint node <image> \
 *     --import /app/server/node_modules/tsx/dist/loader.mjs \
 *     /app/server/dist/cli/isolation-reclaim-executor.js \
 *     inventory --root /nonexistent
 *
 * A reachable import graph gets as far as the executor's own
 * `--root '/nonexistent' is not a directory`; a broken one dies before that,
 * with a resolution error naming a file under `node_modules`.
 */
export const RECLAIM_TSX_LOADER_PATH = "/app/server/node_modules/tsx/dist/loader.mjs";
export const RECLAIM_EXECUTOR_PATH = "/app/server/dist/cli/isolation-reclaim-executor.js";

/** Marks a Job this module owns, for listing and for the driver's own reads. */
export const RECLAIM_JOB_MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
export const RECLAIM_JOB_COMPONENT_LABEL = "app.kubernetes.io/component";
export const RECLAIM_JOB_COMPONENT = "isolation-reclaim";
export const RECLAIM_JOB_MODE_LABEL = "paperclip.io/reclaim-mode";
export const RECLAIM_JOB_CLAIM_LABEL = "paperclip.io/reclaim-claim";
/**
 * Annotation carrying the claim name UNTRUNCATED.
 *
 * Exported because `isolation-reclaim-runner.ts` verifies an adopted Job
 * against it: {@link reclaimJobName} truncates the claim to fit 63 characters, so the label
 * cannot distinguish two claims sharing a long prefix and this is the only
 * field that can. Both sides read the same constant rather than two copies of
 * the string.
 */
export const RECLAIM_JOB_CLAIM_ANNOTATION = "paperclip.io/reclaim-claim-name";
export const RECLAIM_JOB_ROOT_ANNOTATION = "paperclip.io/reclaim-root";
export const RECLAIM_JOB_DRY_RUN_ANNOTATION = "paperclip.io/reclaim-dry-run";
/** The container the report is read from. One container, named here so the log reader cannot guess. */
export const RECLAIM_JOB_CONTAINER_NAME = "reclaim";

/**
 * Ceiling on the serialized plan, in bytes.
 *
 * The kernel's `MAX_ARG_STRLEN` is 128 KiB per single argv/env string. Held at
 * half that: the margin is not politeness but the fact that the limit applies
 * to `NAME=value` as one string and a near-limit plan would fail at container
 * create, where the error names neither the variable nor the cause.
 *
 * A plan at `DEFAULT_MAX_DELETES_PER_TICK` (200) uuids is ~7.4 KB, so this is
 * roughly 8x the expected worst case — it exists to catch a caller that
 * ignored `maxEntries`, not to constrain a healthy sweep.
 */
export const MAX_RECLAIM_PLAN_ENV_BYTES = 64 * 1024;

/** Default wall-clock ceiling on a running reclaim pod. See the header. */
export const DEFAULT_RECLAIM_ACTIVE_DEADLINE_SECONDS = 15 * 60;

/**
 * Default TTL after the Job finishes.
 *
 * An hour, not the agent Job's 300s. The driver reads the report off
 * `pods/log`, and the TTL controller takes the log with the pod — so this is a
 * deadline on the driver, not just a cleanup knob. See the header.
 */
export const DEFAULT_RECLAIM_TTL_SECONDS = 60 * 60;

export interface IsolationReclaimJobSpec {
  /** `inventory` asks what is there; `execute` unlinks from a plan. */
  mode: IsolationReclaimReportKind;
  /** The foreign PVC this Job exists to mount. */
  claimName: string;
  /** Namespace to create the Job in. */
  namespace: string;
  /** Server image — the executor ships in it, so this is the server's own. */
  image: string;
  /**
   * Distinguishes this invocation's Job from the next one's.
   *
   * Required, and supplied by the caller rather than generated here, so the
   * function stays pure and the driver owns retry semantics: a repeated id is
   * a deliberate `AlreadyExists` (idempotent re-create), a fresh one is a new
   * attempt. Nothing is decided here about which of those is wanted.
   */
  invocationId: string;
  /** Required on `execute`, refused on `inventory`. */
  plan?: ReclaimPlanEnvelope;
  serviceAccountName?: string;
  imagePullPolicy?: string;
  imagePullSecrets?: k8s.V1LocalObjectReference[];
  nodeSelector?: Record<string, string>;
  tolerations?: k8s.V1Toleration[];
  activeDeadlineSeconds?: number;
  ttlSecondsAfterFinished?: number;
  /** Extra labels, e.g. the agent this claim belongs to. Cannot override the own-labels above. */
  extraLabels?: Record<string, string>;
}

export interface IsolationReclaimJobManifest {
  job: k8s.V1Job;
  jobName: string;
  namespace: string;
  /** The `--root` this Job's container was given, for the driver's own logs. */
  root: string;
  /** Serialized plan size in bytes, 0 on `inventory`. Reported so a sweep can watch the headroom. */
  planBytes: number;
}

/**
 * DNS-1123 Job name for one reclaim invocation.
 *
 * Kubernetes caps a Job name at 63 characters, and this uses the whole budget
 * rather than reserving a margin under it — deliberately, because there is
 * nothing the margin would protect. The Job controller does not append its
 * suffix to a name that must stay ≤63: pod names come from a `generateName`
 * whose base the apiserver truncates itself, and the `job-name` /
 * `batch.kubernetes.io/job-name` labels take the Job name unchanged, which at
 * 63 is exactly at the label-value limit and not over it.
 *
 * The claim name is the part that can be long (`agent-workspace-<uuid>` is
 * 52), so it is the part that is truncated — the invocation id is what makes
 * the name unique and must survive intact.
 */
export function reclaimJobName(input: {
  mode: IsolationReclaimReportKind;
  claimName: string;
  invocationId: string;
}): string {
  const invocation = sanitizeDnsLabel(input.invocationId);
  if (!invocation) {
    throw new Error(
      `cannot derive a reclaim Job name: invocationId ${JSON.stringify(input.invocationId)} ` +
        `contains no DNS-1123 characters`,
    );
  }
  const prefix = input.mode === "inventory" ? "pc-reclaim-inv" : "pc-reclaim-exe";
  // Budget: prefix + "-" + claim + "-" + invocation <= 63.
  //
  // The claim is the part that gives, because the invocation id is what makes
  // the name unique — truncating THAT would let two invocations collide on one
  // name, and the second create would come back `AlreadyExists` and read as a
  // successful idempotent re-create. So an invocation id that cannot fit even
  // with the claim dropped is refused here rather than silently producing an
  // over-long name, which the API server rejects with an error that names the
  // field and not the cause. (Same discipline as the plan-size ceiling.)
  const claimBudget = 63 - prefix.length - 2 - invocation.length;
  if (prefix.length + 1 + invocation.length > 63) {
    throw new Error(
      `cannot derive a reclaim Job name: invocationId ${JSON.stringify(input.invocationId)} ` +
        `leaves no room under the 63-character DNS-1123 limit after the '${prefix}-' prefix`,
    );
  }
  const claim = claimBudget > 0 ? sanitizeDnsLabel(input.claimName).slice(0, claimBudget) : "";
  const name = [prefix, claim, invocation].filter((part) => part.length > 0).join("-");
  // Trailing `-` is possible when the claim slice lands on one; a DNS-1123
  // label may not end in a non-alphanumeric.
  return name.replace(/-+$/, "");
}

function sanitizeDnsLabel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Build the Job that runs one reclaim invocation against one foreign claim.
 *
 * Pure: every input is an argument and the only output is the manifest. See the
 * module header for the properties this encodes and why each is there.
 */
export function buildIsolationReclaimJobManifest(
  spec: IsolationReclaimJobSpec,
): IsolationReclaimJobManifest {
  if (!spec.claimName.trim()) {
    throw new Error("claimName is required: a reclaim Job with no claim mounts nothing to reclaim");
  }
  if (!spec.image.trim()) throw new Error("image is required");
  if (!spec.namespace.trim()) throw new Error("namespace is required");

  // The two modes disagree about the plan in BOTH directions, and both
  // disagreements are refused rather than normalized. A missing plan on
  // `execute` would start a pod that reports `ok:false` after a schedule and an
  // image pull — the slowest possible way to learn of a caller bug. A plan
  // supplied on `inventory` means the caller believes it is launching the other
  // mode, and silently dropping it would let that belief survive.
  if (spec.mode === "execute" && !spec.plan) {
    throw new Error("mode 'execute' requires a plan; see RECLAIM_PLAN_ENV");
  }
  if (spec.mode === "inventory" && spec.plan) {
    throw new Error("mode 'inventory' takes no plan; it asks what is there, it does not unlink");
  }

  const jobName = reclaimJobName({
    mode: spec.mode,
    claimName: spec.claimName,
    invocationId: spec.invocationId,
  });

  let planJson = "";
  if (spec.plan) {
    planJson = JSON.stringify(spec.plan);
    // Measured in BYTES, not characters: the kernel limit is on the encoded
    // string, and a uuid-only plan is ASCII today but the bound must not
    // silently become 2x looser if anything non-ASCII ever reaches it.
    const bytes = Buffer.byteLength(`${RECLAIM_PLAN_ENV}=${planJson}`, "utf8");
    if (bytes > MAX_RECLAIM_PLAN_ENV_BYTES) {
      throw new Error(
        `reclaim plan is ${bytes} bytes, over the ${MAX_RECLAIM_PLAN_ENV_BYTES}-byte environment ` +
          `ceiling (${spec.plan.eligibleIds.length} ids). Lower maxEntries on ` +
          `buildIsolationReclaimPlan; the per-tick bound exists for exactly this.`,
      );
    }
  }

  const labels: Record<string, string> = {
    // Caller labels first, so the identifying ones below cannot be overridden —
    // a Job that lies about its own mode or claim would mislead every list.
    ...(spec.extraLabels ?? {}),
    [RECLAIM_JOB_MANAGED_BY_LABEL]: "paperclip",
    [RECLAIM_JOB_COMPONENT_LABEL]: RECLAIM_JOB_COMPONENT,
    [RECLAIM_JOB_MODE_LABEL]: spec.mode,
    // Truncated to the 63-char label-value limit. The claim name is also an
    // annotation below, untruncated, because the label is for selecting and the
    // annotation is for reading.
    [RECLAIM_JOB_CLAIM_LABEL]: sanitizeDnsLabel(spec.claimName).slice(0, 63).replace(/-+$/, ""),
  };

  const env: k8s.V1EnvVar[] = [
    // Keeps `middleware/logger.ts`'s import-time `mkdirSync` + `server.log`
    // open off the mounted claim. See the header; this is half of the pair that
    // closes #3189's named residual, the other half being the mount path.
    { name: "PAPERCLIP_HOME", value: RECLAIM_HOME_MOUNT_PATH },
    ...(planJson ? [{ name: RECLAIM_PLAN_ENV, value: planJson }] : []),
  ];

  const container: k8s.V1Container = {
    name: RECLAIM_JOB_CONTAINER_NAME,
    image: spec.image,
    imagePullPolicy: spec.imagePullPolicy ?? "IfNotPresent",
    // See {@link RECLAIM_TSX_LOADER_PATH}: without the loader this container
    // exits non-zero at import time, with no report line for the transport to
    // read.
    command: ["node", "--import", RECLAIM_TSX_LOADER_PATH],
    args: [RECLAIM_EXECUTOR_PATH, spec.mode, "--root", RECLAIM_WORKSPACES_ROOT],
    env,
    volumeMounts: [
      { name: "reclaim-target", mountPath: RECLAIM_CLAIM_MOUNT_PATH },
      { name: "reclaim-home", mountPath: RECLAIM_HOME_MOUNT_PATH },
    ],
    securityContext: {
      capabilities: { drop: ["ALL"] },
      allowPrivilegeEscalation: false,
      runAsNonRoot: true,
      runAsUser: 1000,
      // Left writable: the Node runtime and pino both touch container-local
      // paths, and a read-only root here would buy nothing the emptyDir and the
      // dropped capabilities do not already give. Matches the agent Job.
      readOnlyRootFilesystem: false,
    },
    resources: {
      // Deletion on CephFS is MDS-metadata-bound, not CPU- or memory-bound; the
      // process holds one directory listing and a bounded id list. Small
      // requests keep a reclaim Job from competing with agent pods for a slot
      // on the `workload: paperclip` nodes it is pinned to.
      requests: { cpu: "50m", memory: "128Mi" },
      limits: { cpu: "500m", memory: "512Mi" },
    },
  };

  const job: k8s.V1Job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: jobName,
      namespace: spec.namespace,
      labels,
      annotations: {
        // Untruncated, unlike the label — this is the one place an operator can
        // read which volume the pod actually mounted.
        [RECLAIM_JOB_CLAIM_ANNOTATION]: spec.claimName,
        [RECLAIM_JOB_ROOT_ANNOTATION]: RECLAIM_WORKSPACES_ROOT,
        // `dryRun` defaults to TRUE in the executor and only a JSON `false`
        // disables it, so this says what the Job will actually do rather than
        // what the field literally held. Stamped because "did this Job delete
        // anything" is the first question asked of it, and reading it off the
        // plan env var means parsing JSON out of a pod spec.
        ...(spec.plan
          ? { [RECLAIM_JOB_DRY_RUN_ANNOTATION]: String(spec.plan.dryRun !== false) }
          : {}),
      },
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds:
        spec.activeDeadlineSeconds ?? DEFAULT_RECLAIM_ACTIVE_DEADLINE_SECONDS,
      ttlSecondsAfterFinished: spec.ttlSecondsAfterFinished ?? DEFAULT_RECLAIM_TTL_SECONDS,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          // See the header: the executor needs no API access, and the server's
          // SA can read secrets and create Jobs.
          automountServiceAccountToken: false,
          ...(spec.serviceAccountName ? { serviceAccountName: spec.serviceAccountName } : {}),
          securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000 },
          ...(spec.imagePullSecrets?.length ? { imagePullSecrets: spec.imagePullSecrets } : {}),
          ...(spec.nodeSelector && Object.keys(spec.nodeSelector).length > 0
            ? { nodeSelector: spec.nodeSelector }
            : {}),
          ...(spec.tolerations?.length ? { tolerations: spec.tolerations } : {}),
          containers: [container],
          volumes: [
            { name: "reclaim-target", persistentVolumeClaim: { claimName: spec.claimName } },
            // Small: it holds a log file the executor barely writes to, and
            // sizing it generously would only let a runaway logger consume node
            // ephemeral storage.
            { name: "reclaim-home", emptyDir: { sizeLimit: "64Mi" } },
          ],
        },
      },
    },
  };

  return {
    job,
    jobName,
    namespace: spec.namespace,
    root: RECLAIM_WORKSPACES_ROOT,
    planBytes: planJson ? Buffer.byteLength(planJson, "utf8") : 0,
  };
}
