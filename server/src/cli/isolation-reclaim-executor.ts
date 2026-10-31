/**
 * The reclaim executor's entrypoint — the process that runs inside the Job
 * holding a foreign claim (PEN-5151).
 *
 *   node /app/server/dist/cli/isolation-reclaim-executor.js inventory --root <path>
 *   node /app/server/dist/cli/isolation-reclaim-executor.js execute   --root <path>
 *
 * PEN-4932 moves an opted-in agent's runs onto a per-agent PVC, and the
 * server's isolation sweep goes blind on it: it can enumerate no directory it
 * does not mount. The remedy PEN-5125 chose is a dedicated executor that holds
 * the claim instead, off the run hot path. `isolation-workspace-reaper.ts`
 * already owns both halves of that split; this file is only how they are
 * reached from a container.
 *
 * ## Deliberately credential-free
 *
 * This process gets no `DATABASE_URL` and no API token, and it must stay that
 * way. It is the one thing that makes the design safe: the pod mounts a volume
 * it is about to delete from, so anything secret placed on it would be exposed
 * to exactly the tree under reclamation. Every decision that needs the
 * database — which is all of them — is taken by `buildIsolationReclaimPlan` on
 * the control plane, and arrives here as a finished list.
 *
 * It follows that the module graph this file pulls in must not open a
 * connection. It imports `isolation-workspace-reaper.ts` for the two functions
 * below, which brings in the drizzle *table* objects as types and metadata; no
 * `createDb()` is called on this path. That is a property to preserve, not an
 * accident — contrast `ccrotate-state-hook.ts`, the other CLI here, which does
 * talk to Postgres directly and is wired into a context where that is sound.
 *
 * ## Why there is no default root
 *
 * `--root` is required and must be absolute. `DEFAULT_ISOLATION_WORKSPACE_ROOT`
 * exists and would be the obvious fallback, and that is precisely why it is not
 * used: it names the *server's own* tree. A reclaim Job that silently fell back
 * to it would be pointed at the shared claim the mounted sweep already owns —
 * two unlink sources against one tree, from a process that cannot re-read
 * `lastUsedAt`. Refusing to start is the only safe reading of "nobody told me
 * which volume this is".
 *
 * ## Output contract
 *
 * Exactly one line on stdout: the framed report (`isolation-reclaim-report.ts`).
 * Everything else — including every diagnostic — goes to stderr. The two share
 * one interleaved view through `pods/log`, so the marker is what separates
 * them; see that module. The report is emitted on the failure path too, because
 * a Job that fails silently and a Job that reports why are the same exit code
 * to the control plane and very different things to an operator.
 *
 * Exit 0 when the report says `ok`, 1 otherwise. The report is written before
 * the exit in both cases.
 */

import {
  type IsolationReclaimReport,
  type IsolationReclaimReportKind,
  ISOLATION_RECLAIM_REPORT_VERSION,
  encodeIsolationReclaimReport,
} from "../services/isolation-reclaim-report.js";
import {
  collectIsolationWorkspaceInventory,
  executeIsolationReclaimPlan,
} from "../services/isolation-workspace-reaper.js";

/** Env var carrying the plan on the `execute` path. */
export const RECLAIM_PLAN_ENV = "PAPERCLIP_RECLAIM_PLAN_JSON";

/**
 * The plan as it crosses into the pod.
 *
 * Carried in the environment rather than a ConfigMap because the server's Role
 * (`paperclip-k8s-adapters`) has **no** `configmaps` verb in any form, so a
 * ConfigMap would need an RBAC change in `onprem-k8s` ahead of this — and it
 * buys nothing: `maxDeletes` already bounds `eligibleIds` to a few hundred
 * uuids, ~7 KB, far inside the kernel's 128 KiB limit on a single environment
 * string (`MAX_ARG_STRLEN`, see `job-manifest.ts`).
 */
export interface ReclaimPlanEnvelope {
  planBuiltAtMs: number;
  eligibleIds: string[];
  maxDeletes?: number;
  maxPlanAgeMs?: number;
  dryRun?: boolean;
}

export interface ParsedArgs {
  mode: IsolationReclaimReportKind;
  root: string;
}

/**
 * Parse argv into a mode and a root, or throw with the reason.
 *
 * Exported for the tests: the alternative is a test that spawns a process to
 * find out whether a flag was accepted, which would make the argument rules the
 * slowest thing in the suite to state.
 */
export function parseReclaimArgs(argv: readonly string[]): ParsedArgs {
  const [mode, ...rest] = argv;
  if (mode !== "inventory" && mode !== "execute") {
    throw new Error(`expected subcommand 'inventory' or 'execute', got ${mode ? `'${mode}'` : "none"}`);
  }

  let root: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg === "--root") {
      root = rest[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
      continue;
    }
    throw new Error(`unrecognized argument '${arg}'`);
  }

  if (!root) throw new Error("--root is required; see the module header on why there is no default");
  // Absolute only. A relative root would resolve against the container's
  // working directory, which is not a property of the claim being reclaimed.
  if (!root.startsWith("/")) throw new Error(`--root must be an absolute path, got '${root}'`);
  return { mode, root };
}

/**
 * Read and validate the plan envelope from the environment.
 *
 * Validated here as well as inside `executeIsolationReclaimPlan`, which also
 * refuses a non-finite `planBuiltAtMs`. Not redundant: that function's refusal
 * is a `plan_unusable` *result*, which is the right answer for a plan that
 * arrived and was unjudgeable. An envelope that is not even JSON never produces
 * a result at all, and reporting it as one would claim the executor examined a
 * plan it never received.
 */
export function parseReclaimPlan(raw: string | undefined): ReclaimPlanEnvelope {
  if (!raw) throw new Error(`${RECLAIM_PLAN_ENV} is required for 'execute'`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${RECLAIM_PLAN_ENV} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${RECLAIM_PLAN_ENV} is not a JSON object`);
  }

  const plan = parsed as Record<string, unknown>;
  if (!Array.isArray(plan.eligibleIds) || plan.eligibleIds.some((id) => typeof id !== "string")) {
    throw new Error(`${RECLAIM_PLAN_ENV}.eligibleIds must be an array of strings`);
  }
  if (typeof plan.planBuiltAtMs !== "number") {
    throw new Error(`${RECLAIM_PLAN_ENV}.planBuiltAtMs must be a number`);
  }

  return {
    planBuiltAtMs: plan.planBuiltAtMs,
    eligibleIds: plan.eligibleIds as string[],
    maxDeletes: typeof plan.maxDeletes === "number" ? plan.maxDeletes : undefined,
    maxPlanAgeMs: typeof plan.maxPlanAgeMs === "number" ? plan.maxPlanAgeMs : undefined,
    // Only a JSON `false` turns the dry run off. Mirrors `asBoolean`'s
    // discipline in the opposite direction, and for the reaper's property 2:
    // this unlinks irreversibly, so "deploy the image" and "perform the
    // deletion" must not be the same act. A missing, null, or string-typed
    // field leaves the executor previewing.
    dryRun: plan.dryRun === false ? false : true,
  };
}

/**
 * Run one reclaim invocation and return the report to emit.
 *
 * Returns rather than prints, and takes no process state, so the tests can
 * state the whole contract — including the failure reports — without a
 * subprocess or a captured stdout.
 */
export async function runReclaimExecutor(input: {
  argv: readonly string[];
  env: Record<string, string | undefined>;
}): Promise<IsolationReclaimReport> {
  let mode: IsolationReclaimReportKind = "inventory";
  try {
    const args = parseReclaimArgs(input.argv);
    mode = args.mode;

    if (args.mode === "inventory") {
      const inventory = await collectIsolationWorkspaceInventory(args.root);
      return { v: ISOLATION_RECLAIM_REPORT_VERSION, kind: "inventory", ok: true, inventory };
    }

    const plan = parseReclaimPlan(input.env[RECLAIM_PLAN_ENV]);
    const result = await executeIsolationReclaimPlan({
      root: args.root,
      eligibleIds: plan.eligibleIds,
      planBuiltAtMs: plan.planBuiltAtMs,
      maxDeletes: plan.maxDeletes,
      maxPlanAgeMs: plan.maxPlanAgeMs,
      dryRun: plan.dryRun,
    });
    return { v: ISOLATION_RECLAIM_REPORT_VERSION, kind: "execute", ok: true, result };
  } catch (err) {
    // Reported, not thrown. An uncaught throw reaches the operator as a stack
    // trace on the shared stderr view and no marked line at all, which the
    // parser can only call `absent` — the one failure that says "look at the
    // pod" when the pod has already said exactly what was wrong.
    return {
      v: ISOLATION_RECLAIM_REPORT_VERSION,
      kind: mode,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/* c8 ignore start -- process wiring; the behaviour is in runReclaimExecutor */
async function main(): Promise<void> {
  const report = await runReclaimExecutor({
    argv: process.argv.slice(2),
    env: process.env,
  });
  process.stdout.write(`${encodeIsolationReclaimReport(report)}\n`);
  process.exit(report.ok ? 0 : 1);
}

// `import.meta.url` guard so importing this module in a test does not run it.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
/* c8 ignore stop */
