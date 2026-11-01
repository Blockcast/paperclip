/**
 * Isolation-workspace reaper (BLO-31222).
 *
 * `buildK8sRunIsolationDescriptor` mounts every `isolationMode === "workspace"`
 * run under
 * `/paperclip/instances/default/data/k8s-isolation/workspaces/<executionWorkspaceId>`,
 * and **nothing has ever removed one**. That is not a leak in the usual sense —
 * there is no code path that tries and fails, there is simply no reaper. The
 * tree grew 0 -> 406.7 GiB between July and 2026-09-02 with no owner.
 *
 * It is billed to CephFS (`paperclip-data`, a 2 TiB quota on the `ssd-fast`
 * tier), so the growth lands directly on the pool that produced BLO-31222's
 * ~19-hours-to-write-block incident. Deleting the >30d cohort by hand during
 * that incident reclaimed real space, but a manual pass re-derives the whole
 * incident in roughly five weeks. This is the scheduled version of that pass.
 *
 * Four properties, each of which is load-bearing:
 *
 * 1. **Positive layout allowlist, not an age-only predicate.** A directory is
 *    removed only when its top level is exactly `{home, session}` — Claude
 *    scratch (`HOME`) and session state (`CLAUDE_CONFIG_DIR`). Anything else is
 *    skipped *unexamined*. When this cohort was audited by hand over 448 real
 *    directories, 447 matched and **one did not**: it carried `wt-blo-19094`, a
 *    real git worktree. An age-only `rm -rf` would have destroyed it. The
 *    allowlist costs one directory in 448 (~0.2% of the audited directories)
 *    and removes the entire class, including on future passes whose
 *    composition nobody has looked at.
 *
 *    The top level is not the whole story, and the first deployed dry run said
 *    so: a worktree also lives *one level down*, as `home/<name>/.git`, under a
 *    top level that reads as a flawless `{home, session}`. `hasNestedCheckout`
 *    extends the same allowlist discipline one level into `home` and `session`
 *    for exactly the directories that are about to be unlinked — 13 of 503 on
 *    the live tree, six of them worktrees registered in a *shared* project repo
 *    outside this root. See that function for the measurement.
 *
 * 2. **Opt-in, following `strandedRecoveryHandBack`.** This deletes files
 *    irreversibly. Defaulting it on would make "deploy the code" and "perform
 *    the deletion" the same act, with no run in between to inspect what the
 *    predicate actually matched. `dryRun` exists so the first enablement can be
 *    an observation.
 *
 * 3. **Idempotent and concurrency-tolerant.** Something else was observed
 *    reclaiming this same tree mid-incident (1,235 -> 1,065 dirs in ~5h, cause
 *    unidentified). Every signal the delete decision rests on — existence,
 *    layout, and `lastUsedAt` — is re-checked immediately before removal, and a
 *    vanished entry is counted, not an error.
 *
 * 4. **Bounded per tick.** `maxDeletesPerTick` caps the unlink volume. Deletion
 *    here is MDS-metadata-bound, not data-bound — measured 145 files/s serial
 *    against a saturated MDS — so an unbounded sweep is a latency event for
 *    every other CephFS consumer on the cluster.
 *
 * **Idleness comes from the database, not from the filesystem.** These
 * directories are keyed by **execution-workspace id, not run id**, so they are
 * reusable and legitimately outlive any single run — which makes "how long since
 * this was last used" the only safe question to ask before deleting one.
 *
 * An earlier revision of this module asked it of the directory's own `mtime`.
 * That was wrong, and wrong in the dangerous direction. A directory's `mtime`
 * advances only when a **direct child entry** is added, removed, or renamed —
 * never when nested content is written. For `isolationMode === "workspace"` the
 * only top-level children are `home` and `session`
 * (`heartbeat.ts:6429,6434`); `cacheRoot` and `tmpRoot` are deliberately routed
 * elsewhere (`heartbeat.ts:6437,6441`). Both are created once at materialization
 * and never again, so the root's `mtime` **is its creation time and never
 * advances with use**. `maxAgeDays` therefore meant "materialized more than N
 * days ago", not "idle for N days" — and since the directory name is
 * `execution_workspaces.id` (`heartbeat.ts:6340-6344`), a workspace in active
 * daily use that happened to be materialized 31 days ago was eligible for
 * irreversible deletion on the reaper's first pass. `storage.home` and
 * `storage.session` are both `"persistent"` (`heartbeat.ts:6458-6459`), so what
 * that would destroy is durable per-workspace state.
 *
 * So the age test resolves each directory name against `execution_workspaces`,
 * and deletes only when **every available signal says idle**:
 *
 * - **Row found** -> gate on `lastUsedAt`, which *is* maintained on use: the
 *   workspace-restore path refreshes it on every reuse
 *   (`heartbeat.ts:27159`), as does creation (`heartbeat.ts:27186`). The column
 *   is `notNull` (`execution_workspaces.ts:35`).
 * - **No row** -> the true orphan cohort this reaper is aimed at, and the only
 *   population with no database truth to consult. Here filesystem age carries
 *   the decision, where "materialized more than N days ago with no owning row"
 *   is exactly the intended meaning. Taking `max(mtime)` of `home`/`session`
 *   instead would not help: the same rule applies one level down.
 *
 * `mtime` is still consulted for every directory, because being a useless
 * *deletion* signal does not make it a useless *retention* one: a workspace
 * materialized yesterday cannot have been idle for a month, whatever a stale
 * row says. Requiring both can only ever retain more.
 *
 * Because `lastUsedAt` is the only signal that can protect a live workspace, it
 * is also the only one whose staleness is dangerous, and the sweep's opening
 * snapshot is exactly that: a read taken potentially minutes before the unlink
 * it authorizes. So it is re-read per directory immediately before `fs.rm`.
 * Neither of the other two re-checks can substitute — a run resuming a
 * long-idle workspace refreshes the row and writes under `home`/`session`,
 * which changes the root's existence not at all, its top-level layout not at
 * all, and (per the paragraph above) its `mtime` not at all.
 *
 * Deleting a genuinely idle workspace costs a cold start, not source: durable
 * transcripts live separately under `data/run-logs/`.
 *
 * ## What this module does NOT reap, and why that is recorded here (PEN-5125)
 *
 * Everything above is scoped to one volume: the claim THIS process mounts. An
 * agent whose Job mounts a different claim — a `workspaceVolumeClaim` from
 * either its own config or its k8s ENVIRONMENT's, or PEN-4932 stage 4b's
 * per-agent claim — materializes its isolation trees on that volume, at this
 * same relative path, where no amount of walking this root will find them. The enumeration here is directory-driven (`readdir` -> `id IN
 * (...)`), so such a workspace is never even asked about: it lands in no outcome
 * bucket, the `scanned` identity below stays exactly true over a shrunken
 * population, and the pass reports `stop_reason=complete`. The failure is not
 * that the reaper reports nothing — it is that it reports success.
 *
 * `unreachableAgents` makes that sayable, and is the only part of PEN-5125 this
 * module can own. It is a count when one can be stated soundly and
 * `UNREACHABLE_AGENTS_UNKNOWN` when it cannot — the environment arm of the
 * probe cannot attribute a claim to particular agents, so it degrades to the
 * sentinel rather than publishing a number it cannot stand behind. **Reclamation is deliberately NOT here**, and three shapes
 * were refused rather than left open:
 *
 * - *Give this reaper a per-claim enumeration.* It would have to mount every
 *   agent PVC, which is precisely the cross-mount coupling PEN-4932 exists to
 *   remove.
 * - *Keep `k8s-isolation` on the server's claim beside the per-agent one.*
 *   Refused on PEN-5120's ground: one surviving bind on the shared CephFS
 *   handle, and ceph-csi's lock keys on the handle, so it pays the whole cost of
 *   the swap for zero blast-radius reduction.
 * - *Unlink from the pod's own `seed-writable-dirs` init container.* The pod
 *   does mount the right volume, but that container's design note turns on its
 *   operations being idempotent, so that "a re-run, a restarted pod and a second
 *   agent on the same volume all converge" — and a per-agent claim is
 *   `ReadWriteMany` precisely because one agent holds concurrent run pods across
 *   nodes. `rm -rf` is the one operation that does not converge against a
 *   concurrent sibling, and it would sit in the container whose symlink guard is
 *   already documented as a check-then-act window. Reclamation wants a dedicated
 *   executor off the run hot path, not this one.
 *
 * ## The server half of that executor is here (PEN-5151)
 *
 * `buildIsolationReclaimPlan` is the inversion the chosen shape asks for: rows
 * -> directories, so the eligible set for a claim this process cannot walk is
 * still decided HERE, against `execution_workspaces`, by the same
 * `classifyIsolationWorkspaceAge` the mounted sweep uses. The executor holding
 * the claim contributes the two things only it can — an inventory of what is
 * actually there, and the unlink — and re-checks layout and nested checkouts
 * against the bytes before removing anything.
 *
 * `collectIsolationWorkspaceInventory` and `executeIsolationReclaimPlan` are
 * the executor's two ends, and they live here rather than in the executor so
 * that `isReapableLayout` and `hasNestedCheckout` are the SAME code the mounted
 * sweep runs. That is the same argument `classifyIsolationWorkspaceAge` is
 * extracted on, applied to the retention checks: the foreign path's failure
 * mode is a second, weaker transcription of a rule that exists to keep files.
 *
 * ⛔ Nothing SCHEDULES this yet, and the presence of these functions must not
 * be read as reclamation. The wire and the entrypoint landed in #3189
 * (`isolation-reclaim-report.ts`, `cli/isolation-reclaim-executor.ts`) and the
 * Job manifest in `isolation-reclaim-job.ts`, so a pod that mounts a foreign
 * claim is now describable — but nothing CREATES one. `listReclaimableClaims`
 * below answers the driver's first question, WHICH claims, so the remaining
 * gap is narrower than it was: what is still missing is the acting half —
 * creating the two Jobs, waiting on them, and recovering each report off
 * `pods/log`. Until that exists a foreign claim is unreclaimed and
 * `unreachableAgents` is still the standing record of it. ⚠ In particular, do
 * not read a non-empty `listReclaimableClaims` as a list of claims that WILL
 * be swept; today it is a list of claims that COULD be.
 *
 * A fourth shape was weighed while building these two ends and is refused, so
 * it is recorded beside the other three: *hand the executor a fleet-wide list
 * of every idle workspace id and let it intersect against its own `readdir`.*
 * It is tempting because it collapses the round trip — one Job, no inventory
 * report — and the per-tick bound survives if it is applied at the unlink site,
 * which is where MDS pressure is actually produced. It is refused on disclosure,
 * not on mechanism: that list is every idle workspace id in the fleet, across
 * every company, handed to a pod that exists to hold ONE agent's volume. A
 * per-agent claim is a blast-radius reduction, and this would widen in the
 * opposite direction for a round trip's worth of latency on a daily sweep. The
 * inventory also keeps the operator surface honest — `inventorySize` and its
 * buckets describe THAT volume, where a fleet-wide list would report mostly
 * about volumes the executor never saw.
 *
 * See `docs/plans/2026-10-28-pen-4932-per-agent-volumes.md` §4 stage 4b.
 */
import { inArray, sql } from "drizzle-orm";
import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { agents, environments, executionWorkspaces } from "@paperclipai/db";
import { logger as defaultLogger } from "../middleware/logger.js";
import { DEFAULT_WORKTREE_INSTANCE_HOME_DIRNAME, REPO_MANAGED_WORKTREES_SUBPATH } from "../worktree-config.js";
import { recordIsolationWorkspaceReapSweep } from "./metrics.js";

/** Top-level entries a reapable isolation workspace may contain, sorted. */
export const REAPABLE_LAYOUT = ["home", "session"] as const;

export const DEFAULT_ISOLATION_WORKSPACE_ROOT =
  "/paperclip/instances/default/data/k8s-isolation/workspaces";

/** Per-tick unlink ceiling. Keeps MDS pressure bounded on a shared filesystem. */
export const DEFAULT_MAX_DELETES_PER_TICK = 200;

/**
 * Directories that, non-empty under `home` or `session`, mean live worktree
 * state sits below them. Both come from the modules that create them rather
 * than being restated here, so neither can silently drift unreachable:
 *
 * - `REPO_MANAGED_WORKTREES_SUBPATH` (`.paperclip/worktrees`) is where
 *   `workspace-runtime` puts execution-workspace git worktrees by default when
 *   the side itself is the repo root. A side holding a repo *below* it is
 *   caught by the `<child>/.git` probe instead, since the repo root is there.
 * - `DEFAULT_WORKTREE_INSTANCE_HOME_DIRNAME` (`.paperclip-worktrees`) is the
 *   worktree-instance home `~/.paperclip-worktrees` (per-worktree db, logs,
 *   storage), and `home` is `HOME` here. Observed non-empty as
 *   `home/.paperclip-worktrees` on the live tree 2026-10-09 (BLO-36735, the
 *   scan that found the 13 retentions below), so it is kept as a second case.
 *
 * Ceiling: an operator-set `workspaceStrategy.worktreeParentDir` can put
 * worktrees anywhere, deeper than this probe looks. A checkout there is still
 * caught when its repo root sits at a side or one level below it.
 */
export const WORKTREE_PARENT_DIRS = [REPO_MANAGED_WORKTREES_SUBPATH, DEFAULT_WORKTREE_INSTANCE_HOME_DIRNAME] as const;

/** Directory names are `execution_workspaces.id`; anything else cannot resolve. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the control plane knows about a workspace the filesystem cannot tell us. */
export interface WorkspaceUsageRow {
  lastUsedAt: Date;
  status: string;
  closedAt: Date | null;
}

/**
 * Resolves directory names to owning `execution_workspaces` rows. Injected so
 * the age predicate — the part of this module that decides what gets deleted —
 * is testable without an embedded Postgres, and therefore runs on every host
 * rather than being skipped on some.
 *
 * Called twice per sweep in the live path: once batched over every directory,
 * then once per prospective unlink to re-check the one row that matters.
 */
export type WorkspaceUsageLookup = (ids: string[]) => Promise<Map<string, WorkspaceUsageRow>>;

/**
 * The production lookup. Served by the primary key — the predicate is
 * `id IN (...)`, and the only index touching `lastUsedAt` is
 * `execution_workspaces_company_last_used_idx` on `(companyId, lastUsedAt)`
 * (`execution_workspaces.ts:59-62`), whose leading column this query does not
 * constrain. The PK is the better path anyway; the note is here so nobody
 * "optimizes" toward an index that was never in play.
 */
export function createDbWorkspaceUsageLookup(db: Db): WorkspaceUsageLookup {
  return async (ids) => {
    const resolvable = ids.filter((id) => UUID_PATTERN.test(id));
    const found = new Map<string, WorkspaceUsageRow>();
    if (resolvable.length === 0) return found;

    const rows = await db
      .select({
        id: executionWorkspaces.id,
        lastUsedAt: executionWorkspaces.lastUsedAt,
        status: executionWorkspaces.status,
        closedAt: executionWorkspaces.closedAt,
      })
      .from(executionWorkspaces)
      .where(inArray(executionWorkspaces.id, resolvable));

    for (const row of rows) {
      found.set(row.id, {
        lastUsedAt: row.lastUsedAt,
        status: row.status,
        closedAt: row.closedAt,
      });
    }
    return found;
  };
}

/**
 * Config keys that move an agent's Job off the volume this process mounts.
 *
 * The reaper's reach is exactly `serverHoldsJobDataClaim`
 * (`vendor/paperclip-adapter-claude-k8s/src/server/job-manifest.ts`): it can
 * see a run's isolation tree if and only if the Job mounted the server's own
 * claim. `resolveDataClaimName` there has three slots in precedence order —
 * operator `workspaceVolumeClaim`, the per-agent claim, the server's own PVC —
 * and the first two both resolve to a volume this process has no mount on.
 *
 * ⚠ `workspaceVolumeClaim` is NOT a stage-4b key. It has no `config-schema.ts`
 * toggle, but it is read today, which makes the blind spot below reachable on
 * the CURRENT deployment rather than only after `enablePerAgentWorkspaceVolume`
 * is flipped. PEN-5125 was filed against the per-agent claim alone; this is the
 * same defect one slot higher, and it is why the probe keys on the
 * claim-resolution rule rather than on the gate.
 *
 * ⚠⚠ And it has TWO sources, not one. `execute.ts` merges a k8s-remote
 * execution target's `K8sRemoteSpec` over the agent's config with the
 * ENVIRONMENT winning (`mergeEnvironmentConfig`, the Phase E.1 path named at
 * `job-manifest.ts`), so an agent whose environment supplies a claim is on a
 * foreign volume while its own `adapter_config` says nothing at all. Reading
 * only `agents` therefore returns a confident `0` — a full-coverage reading,
 * which is precisely the silence this probe exists to remove. Found in review
 * of PR #3180.
 *
 * The fourth case — `dataClaimName === ""`, an `emptyDir` — is deliberately
 * absent. That tree is unreachable too, but it dies with the pod, so it
 * accumulates nothing and is not a capacity gap.
 */
export const PER_AGENT_WORKSPACE_VOLUME_CONFIG_KEY = "enablePerAgentWorkspaceVolume";
export const WORKSPACE_VOLUME_CLAIM_CONFIG_KEY = "workspaceVolumeClaim";

/**
 * How many agents' isolation trees this sweep structurally cannot reach.
 *
 * Separate from `WorkspaceUsageLookup` and injected for the same reason: the
 * answer comes from the control plane, and a test must be able to state it
 * without an embedded Postgres.
 */
export type UnreachableAgentCount = () => Promise<number>;

/**
 * The production probe, in two arms that answer different questions.
 *
 * **Arm A — `agents`, a COUNT.** How many agents are moved off this volume by
 * their own config: the per-agent opt-in, or an agent-level
 * `workspaceVolumeClaim`. Mirrors `asBoolean`
 * (`packages/adapter-utils/src/server-utils.ts`) **exactly**: only a JSON
 * boolean `true` opts an agent in, so the predicate is `= 'true'::jsonb` and
 * not a text comparison. A looser match would over-report — an agent carrying
 * the string `"true"` is NOT opted in, and its Job does mount this claim.
 *
 * **Arm B — `environments`, a TRUST CHECK.** A k8s-driver environment's
 * `config.workspaceVolumeClaim` is merged over the agent's and WINS, so an
 * agent whose environment names a claim is on a foreign volume with nothing in
 * its own row to say so.
 *
 * ⚠ `driver = 'k8s'` is necessary but not sufficient, so this arm can fire for
 * an environment that moves no Job at all: `resolveEnvironmentExecutionTarget`
 * returns `null` for a k8s environment unless the adapter is `claude_k8s` or
 * `opencode_k8s` (`environment-execution-target.ts:126-128`), and the claim is
 * read off that target. An environment only ever bound to non-k8s adapters
 * therefore yields a false UNKNOWN. Left uncorrected deliberately: the fix
 * would have to know which adapters an environment is bound to over its
 * lifetime, which is per-run state — the same reason arm A cannot be corrected
 * into a true count — and the error is in the safe direction, over-reporting
 * doubt about coverage rather than under-reporting it. Named here so the next
 * reader does not re-derive it from a `-1` with no unreachable tree behind it.
 * (Ally, review of PR #3180.) Which agents those are is not derivable here: the
 * environment is chosen per run (`executionWorkspaceSettings.environmentId`
 * overrides `agents.defaultEnvironmentId`), so arm A cannot be corrected into a
 * true count. What CAN be said soundly is that arm A is no longer trustworthy —
 * so arm B returns `UNREACHABLE_AGENTS_UNKNOWN` rather than a number. That is
 * the whole reason the sentinel is alertable: `!= 0` fires either way, and the
 * failure direction is "cannot tell", never a false `0`.
 *
 * **`selfDataClaimName` exists because a named claim is not necessarily a
 * foreign one.** `serverHoldsJobDataClaim` is true when `workspaceVolumeClaim`
 * EQUALS the server's own PVC, and naming it explicitly is a realistic operator
 * choice — the adapter's own fixtures use `paperclip-data`, which is this
 * deployment's server claim. Supplying the name here excludes that case from
 * both arms. It is injected rather than read here because the server has no
 * config for it: the adapter resolves it from a live pod read
 * (`k8s-client.ts`), and making a filesystem sweep depend on the Kubernetes API
 * is a worse trade than the over-report. ⚠ Nothing supplies it today, so a
 * claim equal to the server's own reads as foreign: arm A over-counts it and
 * arm B returns UNKNOWN. Both err toward `!= 0`, which is the safe direction
 * for this gauge, and the `IS DISTINCT FROM` comparisons below are already
 * written so that passing the name is the only change needed.
 *
 * Deliberately NOT filtered by `agents.status` or `environments.status`. A
 * paused agent's tree is exactly as unreachable as a running one's and is the
 * one least likely to be noticed; filtering would make the gap shrink when the
 * fleet goes quiet, which is the wrong direction for a capacity signal.
 *
 * Two aggregates per sweep (daily), unindexed on a jsonb key — sequential scans
 * over tables measured in hundreds of rows, against a pass whose next act is an
 * unbounded recursive unlink.
 */
export function createDbUnreachableAgentCount(
  db: Db,
  selfDataClaimName?: string | null,
): UnreachableAgentCount {
  // `IS DISTINCT FROM` rather than `<>` so a NULL self-claim (the state today)
  // excludes nothing instead of making every comparison NULL and silently
  // emptying both arms. The fail-open reading of "I do not know my own claim"
  // has to be "treat every named claim as foreign", not "treat none as".
  const self = selfDataClaimName?.trim() || null;
  return async () => {
    // Arm B first: if it fires, arm A's number is not worth computing, and
    // reporting a count beside a known-untrustworthy basis is what this
    // sentinel exists to avoid.
    const envRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(environments)
      .where(
        sql`${environments.driver} = 'k8s'
            AND btrim(coalesce(${environments.config} ->> ${WORKSPACE_VOLUME_CLAIM_CONFIG_KEY}::text, '')) <> ''
            AND btrim(${environments.config} ->> ${WORKSPACE_VOLUME_CLAIM_CONFIG_KEY}::text) IS DISTINCT FROM ${self}`,
      );
    if ((envRows[0]?.count ?? 0) > 0) return UNREACHABLE_AGENTS_UNKNOWN;

    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agents)
      .where(
        // The `::text` casts pin the operator overload explicitly. Both `->`
        // and `->>` are overloaded on `(jsonb, text)` and `(jsonb, integer)`,
        // and a bound parameter arrives as `unknown`, so the bare form leans on
        // Postgres resolving `unknown` to the preferred type — which it does,
        // and which is why the bare `jsonb -> 'key'` idiom works everywhere.
        // Stating it is cheap and removes the question; it is not a bug fix.
        sql`${agents.adapterConfig} -> ${PER_AGENT_WORKSPACE_VOLUME_CONFIG_KEY}::text = 'true'::jsonb
            OR (btrim(coalesce(${agents.adapterConfig} ->> ${WORKSPACE_VOLUME_CLAIM_CONFIG_KEY}::text, '')) <> ''
                AND btrim(${agents.adapterConfig} ->> ${WORKSPACE_VOLUME_CLAIM_CONFIG_KEY}::text) IS DISTINCT FROM ${self})`,
      );
    return rows[0]?.count ?? 0;
  };
}

/**
 * One foreign claim a reclaim Job should be launched against, and why.
 *
 * `source` is kept because the two arms carry different certainty and an
 * operator reading a sweep's log needs to tell them apart. An
 * `agent_per_agent_volume` row names a claim this control plane derives and
 * can therefore predict exactly; an `environment_claim` row names one an
 * operator typed, which is authoritative but opaque — nothing here knows
 * whether it was ever provisioned.
 */
export interface ReclaimableClaim {
  /** The PVC to mount. Non-empty, DNS-1123, deduped across the whole result. */
  claimName: string;
  source: "agent_per_agent_volume" | "agent_workspace_claim" | "environment_claim";
  /**
   * The agent this claim belongs to, when that is knowable.
   *
   * `null` on every `environment_claim` row, and that is a property of the
   * data rather than a gap to fill later — see `listReclaimableClaims`.
   */
  agentId: string | null;
}

/**
 * Prefix of a claim name derived by the per-agent volume gate.
 *
 * ⚠ RE-DERIVED, not imported. The authority is
 * `agentWorkspaceClaimName`
 * (`vendor/paperclip-adapter-claude-k8s/src/server/workspace-pvc.ts`), and the
 * server does not import vendor code at runtime. Two places computing a claim
 * name independently is exactly how a Job ends up mounting a claim nothing
 * provisioned — which is why the duplication is pinned by a source-agreement
 * test (`isolation-reclaim-claims.test.ts`) that reads the adapter's own
 * source, on the `orphan-artifact-path-agreement.test.ts` precedent, rather
 * than by this comment.
 *
 * The failure this guards is quiet in the worse direction: a drifted prefix
 * does not throw, it names a claim that does not exist, and the reclaim Job
 * then sits `Pending` on an unbound PVC while the real tree keeps growing and
 * the sweep reports that it launched.
 */
export const AGENT_WORKSPACE_CLAIM_PREFIX = "agent-workspace-";

/**
 * Every claim holding an isolation tree this server cannot walk.
 *
 * This is the input the reclaim driver needs and the one
 * `createDbUnreachableAgentCount` deliberately does not produce. The gauge
 * answers "is there a gap"; a sweep needs "which volumes, by name". They are
 * computed from the same two arms and must not drift, but they are different
 * questions and the arms do not answer them equally well.
 *
 * **Arm B is enumerable here even though it is UNKNOWN there, and that
 * asymmetry is the point.** `createDbUnreachableAgentCount` returns
 * `UNREACHABLE_AGENTS_UNKNOWN` for a k8s environment naming a claim because it
 * cannot say WHICH AGENTS land on it — the environment is chosen per run
 * (`executionWorkspaceSettings.environmentId` overrides
 * `agents.defaultEnvironmentId`), so no agent-shaped count is sound. But the
 * CLAIM NAME is a literal in `environments.config`, and it is the claim, not
 * the agent, that this sweep mounts. So the gauge's blind spot is not the
 * reclaimer's: a tree the gauge can only report doubt about is one this
 * function can name and reclaim. Do not "fix" the gauge by reading this
 * function's output into it — the count it owes is of agents, and that is
 * still underivable.
 *
 * The arm-B caveat recorded on the gauge carries over unchanged: `driver =
 * 'k8s'` is necessary but not sufficient, so an environment only ever bound to
 * non-k8s adapters yields a claim that moves no Job. Here that is a wasted
 * inventory Job against a PVC that may not exist, not a wrong deletion — the
 * executor's own allowlist and `lastUsedAt` predicate still gate every unlink
 * — so it is tolerated for the same reason, and for the extra one that a
 * claim named by an operator is the last thing to silently skip.
 *
 * **`selfClaimName` is REQUIRED, where the gauge's is optional, and the
 * direction of the unknown flips.** For a gauge, "I do not know my own claim"
 * must fail open — count a claim that might be mine, over-report doubt. For a
 * list that launches `rm -rf`, failing open means launching a deletion Job
 * against the volume the mounted sweep is already walking: two sweeps racing
 * on one tree, with no cross-process re-read between them (the whole reason
 * `DEFAULT_MAX_PLAN_AGE_MS` exists). So the caller must state it. Passing
 * `null` is a deliberate "this deployment holds no claim to exclude", not a
 * shrug — and the driver is the one caller that can always answer, because it
 * holds a Kubernetes client by necessity and the adapter resolves the server's
 * own claim from a live pod read (`k8s-client.ts`). The thing the gauge could
 * not get is free to the driver.
 *
 * **Deduped by claim name, and that is correctness rather than tidiness.** Two
 * agents can name one claim, and an environment can name a claim an agent
 * already names. Launching two Jobs against one `ReadWriteMany` PVC gets two
 * executors unlinking the same tree from two plans built at different
 * instants, which is precisely the concurrent-sibling case
 * `seed-writable-dirs` was refused over. First writer wins so the more
 * specific attribution survives: an agent-attributed row is never replaced by
 * an environment row naming the same claim.
 *
 * Not filtered by `agents.status` / `environments.status`, matching the gauge:
 * a paused agent's tree is exactly as unreachable, and is the one least likely
 * to be noticed.
 */
export async function listReclaimableClaims(
  db: Db,
  selfClaimName: string | null,
): Promise<ReclaimableClaim[]> {
  const self = selfClaimName?.trim() || null;
  const byClaim = new Map<string, ReclaimableClaim>();
  // First writer wins, so call order encodes attribution preference: agent
  // rows are added before environment rows.
  const add = (claim: ReclaimableClaim): void => {
    if (!claim.claimName || claim.claimName === self) return;
    if (!byClaim.has(claim.claimName)) byClaim.set(claim.claimName, claim);
  };

  const agentRows = await db
    .select({ id: agents.id, config: agents.adapterConfig })
    .from(agents)
    .where(
      // Same two predicates as the gauge's arm A, including `= 'true'::jsonb`
      // rather than a text comparison: only a JSON boolean `true` opts an
      // agent in, mirroring `asBoolean`. A looser match would name a claim
      // that no Job mounts.
      sql`${agents.adapterConfig} -> ${PER_AGENT_WORKSPACE_VOLUME_CONFIG_KEY}::text = 'true'::jsonb
          OR (btrim(coalesce(${agents.adapterConfig} ->> ${WORKSPACE_VOLUME_CLAIM_CONFIG_KEY}::text, '')) <> ''
              AND btrim(${agents.adapterConfig} ->> ${WORKSPACE_VOLUME_CLAIM_CONFIG_KEY}::text) IS DISTINCT FROM ${self})`,
    )
    // Ordered because "first writer wins" below is an ATTRIBUTION rule, and an
    // unordered scan makes it a coin flip: two agents naming one claim would
    // hand `agentId` to whichever row the database returned first, which can
    // change between runs with no change to the data. The claim SET is
    // order-independent; the attribution and the returned order are not.
    .orderBy(agents.id);

  for (const row of agentRows) {
    const config = (row.config ?? {}) as Record<string, unknown>;
    // An explicit claim WINS over the derived one, matching the adapter: the
    // manifest builder reads `workspaceVolumeClaim` as an override, so an
    // agent carrying both is on the named volume and the derived name is a
    // claim nothing mounts.
    const named = typeof config[WORKSPACE_VOLUME_CLAIM_CONFIG_KEY] === "string"
      ? (config[WORKSPACE_VOLUME_CLAIM_CONFIG_KEY] as string).trim()
      : "";
    if (named) {
      add({ claimName: named, source: "agent_workspace_claim", agentId: row.id });
      continue;
    }
    if (config[PER_AGENT_WORKSPACE_VOLUME_CONFIG_KEY] !== true) continue;
    const derived = deriveAgentWorkspaceClaimName(row.id);
    // An id the adapter would REFUSE is skipped rather than thrown on. The
    // adapter THROWS here, and deliberately — there, refusing is what stops an
    // opted-in Job silently mounting the shared claim. Here the equivalent of
    // that mistake is sweeping the wrong volume, and skipping is what avoids
    // it; one refused id must not take the whole sweep down with it.
    if (derived) add({ claimName: derived, source: "agent_per_agent_volume", agentId: row.id });
  }

  const envRows = await db
    .select({ config: environments.config })
    .from(environments)
    .where(
      sql`${environments.driver} = 'k8s'
          AND btrim(coalesce(${environments.config} ->> ${WORKSPACE_VOLUME_CLAIM_CONFIG_KEY}::text, '')) <> ''
          AND btrim(${environments.config} ->> ${WORKSPACE_VOLUME_CLAIM_CONFIG_KEY}::text) IS DISTINCT FROM ${self}`,
    )
    .orderBy(environments.id);

  for (const row of envRows) {
    const config = (row.config ?? {}) as Record<string, unknown>;
    const named = typeof config[WORKSPACE_VOLUME_CLAIM_CONFIG_KEY] === "string"
      ? (config[WORKSPACE_VOLUME_CLAIM_CONFIG_KEY] as string).trim()
      : "";
    if (named) add({ claimName: named, source: "environment_claim", agentId: null });
  }

  return [...byClaim.values()];
}

/**
 * The adapter's label-value rule (`assertLabelSafeAgentId`), which it checks
 * BEFORE deriving the name. Duplicated for the same reason the slug pipeline
 * below is, and pinned by the same agreement test.
 */
const LABEL_SAFE_AGENT_ID = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

/**
 * The server's copy of the adapter's claim-name derivation.
 *
 * Returns `""` wherever the adapter REFUSES, so that "name only what the
 * adapter would have provisioned" holds for every input rather than for most
 * of them. The two differ only in HOW they refuse — the adapter throws, this
 * skips; see the call site for why.
 *
 * The label-value check is the load-bearing half. Ids like `-abc`, `abc_`, or
 * anything over 63 characters slug CLEANLY, so without it this would return
 * `agent-workspace-abc` for an agent the adapter threw on before provisioning
 * anything — naming a claim that does not exist, which is the "Job sits
 * `Pending` on an unbound claim" failure the caller's docstring warns about.
 * UUID ids never reach either refusal; both are backstops.
 *
 * The empty-slug ternary is the adapter's own backstop carried over, and is
 * UNREACHABLE for the reason it is unreachable there: a label-safe id starts
 * with an alphanumeric, and an alphanumeric always survives the filter above.
 * Kept because it guards this derivation directly rather than by implication.
 *
 * Kept beside `AGENT_WORKSPACE_CLAIM_PREFIX` so the agreement tests have one
 * place to read.
 */
function deriveAgentWorkspaceClaimName(agentId: string): string {
  const id = agentId ?? "";
  if (id.length > 63 || !LABEL_SAFE_AGENT_ID.test(id)) return "";
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
  return slug ? `${AGENT_WORKSPACE_CLAIM_PREFIX}${slug}` : "";
}

export interface IsolationWorkspaceReapOptions {
  root?: string;
  maxAgeDays: number;
  maxDeletesPerTick?: number;
  /** Classify and log, delete nothing. */
  dryRun?: boolean;
  now?: () => number;
  logger?: typeof defaultLogger;
  /**
   * Required, and deliberately not defaulted. Any default here is fail-open:
   * "no rows" routes every directory to the filesystem fallback, which is the
   * predicate this module exists to stop using. Callers must state where
   * idleness comes from.
   */
  lookupWorkspaceUsage: WorkspaceUsageLookup;
  /**
   * Optional, unlike `lookupWorkspaceUsage` above, and the asymmetry is
   * deliberate: omitting this changes nothing about what gets deleted, so it
   * cannot be fail-open in that sense. What it does change is whether the sweep
   * can say how much of the population it covered — so omitting it is recorded
   * as `UNREACHABLE_AGENTS_UNKNOWN` rather than as zero. The production
   * constructor always supplies it; see `startIsolationWorkspaceReaper`.
   */
  countUnreachableAgents?: UnreachableAgentCount;
  /**
   * This process's own `data` PVC claim name, when the deployment knows it.
   * Used only to stop a `workspaceVolumeClaim` that NAMES the server's own
   * claim from reading as foreign — `serverHoldsJobDataClaim` is true in that
   * case. Unset today; see `createDbUnreachableAgentCount` for why it is
   * injected rather than resolved here, and for the over-report that leaves.
   */
  selfDataClaimName?: string | null;
}

export interface IsolationWorkspaceReapResult {
  scanned: number;
  eligible: number;
  deleted: number;
  /**
   * Present but its *top level* does not match the layout allowlist —
   * deliberately untouched, and unexamined below that top level.
   */
  skippedLayout: number;
  /**
   * Top level matches the allowlist, but a git checkout or worktree state sits
   * below it (`hasNestedCheckout`) — retained. Kept apart from `skippedLayout`
   * so that series keeps meaning "the tree is more heterogeneous than the
   * allowlist was validated against" rather than absorbing a steady
   * population (13 when the live tree was measured, BLO-36735).
   */
  retainedNestedCheckout: number;
  /** Resolved to a workspace row used inside the window — the live cohort. */
  retainedInUse: number;
  /**
   * Idle at the sweep's opening snapshot, but used again before this pass
   * reached its unlink — the race the pre-unlink re-read exists to catch.
   *
   * Separate from `retainedInUse` on purpose. Both retain, but they mean
   * opposite things operationally: `retainedInUse` is the ordinary steady
   * state, whereas any non-zero value here is a workspace that came within one
   * query of being deleted underneath a live run. Folding it into the ordinary
   * counter would make the near-miss this module exists to prevent report
   * identically to routine, and its frequency unmeasurable in production —
   * which is the only evidence that can confirm or retire the exposure window
   * argued at the re-read below.
   */
  retainedResurrected: number;
  /**
   * Materialized inside the window, so it cannot have been idle longer than it
   * has existed. Counted rather than left as the arithmetic remainder, so an
   * operator reading a sweep log can name every outcome: with no concurrent
   * removals, `scanned` is exactly
   * `retainedFresh + retainedInUse + retainedResurrected + skippedLayout +
   * retainedNestedCheckout + failed + eligible`.
   *
   * `failed` is named in that sum rather than assumed away: a present but
   * unreadable directory (`EACCES`, or an MDS hiccup on this filesystem) lands
   * there and needs no concurrency to occur, so omitting it would leave the
   * identity quietly false on exactly the tree an operator is inspecting.
   */
  retainedFresh: number;
  /** Disappeared between scan and delete (concurrent reaper, or a live run). */
  vanished: number;
  failed: number;
  /** True when `maxDeletesPerTick` stopped the pass with work remaining. */
  capped: boolean;
  /**
   * True when the pre-unlink re-read faulted and ended the tick early. Distinct
   * from `capped`: both stop the pass with work remaining, but this one means
   * the stop was a fault rather than a budget, so the remaining directories
   * were never assessed at all.
   */
  lookupFaulted: boolean;
  /**
   * How many agents' isolation trees this sweep structurally could not reach,
   * or `UNREACHABLE_AGENTS_UNKNOWN` when the probe was absent or faulted
   * (PEN-5125).
   *
   * ⛔ This is NOT another outcome bucket, and it is not part of the `scanned`
   * identity above — the directories it describes were never enumerated, so
   * they are in no bucket at all. That is the whole finding. `root_absent`
   * (BLO-36814) was added to stop an enabled-but-misaimed reaper from looking
   * like a disabled one, but it fires only on `ENOENT` of the root, and a
   * per-agent claim leaves this root **present and populated** by every agent
   * that did not opt in. So `readdir` succeeds, the sweep runs, the identity
   * holds exactly, every `entries_total{outcome=…}` child is internally
   * consistent — over a silently shrunken population — and `stop_reason` reads
   * `complete`.
   *
   * The cost of the gap is therefore not that the reaper reports nothing. It is
   * that it reports **success**: `complete` means "finished sweeping the tree it
   * could see", never "swept the population", and before this field nothing
   * published could tell those apart.
   */
  unreachableAgents: number;
}

/**
 * `unreachableAgents` when the probe was not supplied or threw.
 *
 * Negative because a count cannot be, so it is unambiguous in a time series and
 * an operator alerts on `!= 0` — one expression covering both "agents are
 * unreachable" and "this sweep cannot tell". A sentinel of `0` would make a
 * persistently failing probe read as full coverage, which is the silence this
 * field exists to remove.
 */
export const UNREACHABLE_AGENTS_UNKNOWN = -1;

/**
 * The age test, as a pure verdict over the two signals that can speak to it.
 *
 * Delete only when EVERY available signal says idle. `lastUsedAt` is the
 * authoritative one and the only one that can keep a live workspace alive — see
 * the module doc comment. Filesystem `mtime` is materialization time, so it is a
 * valid *retention* signal even though it is a useless deletion signal: a
 * directory materialized yesterday cannot have been idle for a month, whatever a
 * stale row claims. Requiring both can only ever retain more, which is the
 * correct bias for an irreversible operation, and it costs one `stat`.
 *
 * Extracted because it now has TWO callers that must agree exactly — the
 * in-process sweep, and `buildIsolationReclaimPlan`, which decides the same
 * question for a volume this process cannot walk (PEN-5151). Those two run in
 * different processes and, for the plan, minutes apart from the unlink they
 * authorize. A second transcription of this rule is the most likely way the
 * foreign-claim sweep ends up deleting on a predicate the mounted one rejects,
 * and the direction of that drift is unbounded: `mtime` alone is precisely the
 * predicate BLO-31222 exists to stop using. One function, two callers.
 *
 * `idleSinceMs` is returned on every arm, not just the deletable one, because
 * the caller logs it for retained directories too — an operator reading a sweep
 * needs the age of what was KEPT as much as of what was removed.
 */
export type IsolationWorkspaceAgeVerdict =
  | { verdict: "fresh"; idleSinceMs: number; ageSource: "mtime" }
  | { verdict: "in_use"; idleSinceMs: number; ageSource: "lastUsedAt" }
  | { verdict: "aged"; idleSinceMs: number; ageSource: "lastUsedAt" | "mtime" };

export function classifyIsolationWorkspaceAge(input: {
  mtimeMs: number;
  owner: WorkspaceUsageRow | undefined;
  cutoff: number;
}): IsolationWorkspaceAgeVerdict {
  const { mtimeMs, owner, cutoff } = input;
  if (mtimeMs >= cutoff) return { verdict: "fresh", idleSinceMs: mtimeMs, ageSource: "mtime" };
  if (!owner) return { verdict: "aged", idleSinceMs: mtimeMs, ageSource: "mtime" };
  // A row exists, so the filesystem no longer gets a vote on deletion.
  const lastUsedMs = owner.lastUsedAt.getTime();
  if (lastUsedMs >= cutoff) {
    return { verdict: "in_use", idleSinceMs: lastUsedMs, ageSource: "lastUsedAt" };
  }
  return { verdict: "aged", idleSinceMs: lastUsedMs, ageSource: "lastUsedAt" };
}

/**
 * One directory as an executor holding a foreign claim can describe it, without
 * a database (PEN-5151).
 *
 * `mtimeMs` is the root's own `mtime` — the same `stat` the mounted sweep takes,
 * and carrying the same meaning: materialization time, useful only to retain.
 */
export interface IsolationWorkspaceInventoryEntry {
  name: string;
  mtimeMs: number;
}

/** What a reclaim executor is authorized to unlink, and why the rest was spared. */
export interface IsolationReclaimPlan {
  /**
   * Directory names the executor may remove, oldest-idle first, after it
   * re-checks layout and nested checkouts on its own volume. Ordering is part of
   * the contract: `maxEntries` truncates, so the entries dropped must be the
   * least overdue rather than whichever the inventory happened to list last.
   */
  eligibleIds: string[];
  /** Materialized inside the window; cannot have been idle longer than it has existed. */
  retainedFresh: number;
  /** Resolved to a workspace row used inside the window — the live cohort. */
  retainedInUse: number;
  /**
   * Refused because the name is not a workspace id. See the module header: this
   * bucket exists only on the plan path, and it is a deliberate narrowing.
   */
  skippedUnsafeName: number;
  /**
   * Refused because the entry carried no usable `mtimeMs`.
   *
   * Kept apart from `skippedUnsafeName` because the causes are different and so
   * are the remedies: an unexpected name is a directory nobody should have
   * created, whereas this is an executor reporting badly — a serialization bug
   * on the inventory path, not something on the volume. Folding them together
   * would hide one steady population under the other, which is the mistake
   * `retainedNestedCheckout` was split out of `skippedLayout` to avoid.
   */
  skippedMalformed: number;
  /**
   * Named twice in the inventory. `readdir` cannot do that; a report crossing a
   * process boundary can, and a repeat would spend the bound twice on one
   * directory.
   */
  skippedDuplicate: number;
  /**
   * Eligible on every signal, but past `maxEntries`. These are offered again on
   * the next tick — the plan is ordered oldest-idle first precisely so that
   * what gets dropped here is the least overdue.
   */
  droppedByBound: number;
  /**
   * True when `droppedByBound` is non-zero. Redundant with it by construction,
   * and kept anyway for the same reason `capped` is kept beside the sweep's
   * counters: one boolean an operator can alert on without arithmetic.
   */
  truncated: boolean;
  /**
   * Entries considered. Every one lands in exactly one bucket, so with nothing
   * else changing, `inventorySize` is exactly
   * `eligibleIds.length + droppedByBound + retainedFresh + retainedInUse +
   * skippedUnsafeName + skippedMalformed + skippedDuplicate`.
   *
   * Stated and held by a test rather than left to be assumed: this is the one
   * surface an operator has for a volume they cannot walk, so a silent bucket
   * here is the same failure the mounted sweep's `scanned` identity exists to
   * prevent — a count that looks complete over a population it is not.
   */
  inventorySize: number;
}

/**
 * The inversion: rows -> directories, for a claim this process cannot walk.
 *
 * The mounted sweep enumerates the filesystem and asks the database about what
 * it found (`readdir` -> `id IN (...)`). A per-agent or operator claim has no
 * such mount here, so the two halves are split across a process boundary: an
 * executor holding the claim reports what it has, this function decides, and the
 * executor unlinks what it is given. **Every deletion decision stays here**,
 * against `execution_workspaces`, which is the whole point — an executor with no
 * database could only fall back to `mtime`, and that is the predicate BLO-31222
 * exists to stop using.
 *
 * The age rule is `classifyIsolationWorkspaceAge`, shared verbatim with the
 * mounted sweep, so a directory is eligible here exactly when it would be there.
 *
 * ## What this does NOT decide, and must not be made to
 *
 * Layout (`REAPABLE_LAYOUT`) and `hasNestedCheckout` are **not** evaluated here,
 * and the omission is deliberate rather than pending. Both read the filesystem,
 * so answering them here would mean trusting an executor's report of its own
 * contents about a tree it is asking permission to delete — and both exist to
 * retain. They belong where the bytes are, re-checked immediately before the
 * unlink, exactly as the mounted sweep does it. A plan entry is therefore
 * permission to *consider* a directory, never an instruction to remove it, and
 * an executor that skips those checks is not a faster executor but a wrong one.
 *
 * ## Why the name is validated, when the mounted sweep does not bother
 *
 * There, names come from `readdir` and are single path components by
 * construction. Here a name crosses a process boundary and comes back as the
 * argument to a recursive unlink, so a name like `..` or one carrying a
 * separator would escape the root it was scoped to. `UUID_PATTERN` is both the
 * natural rule — these directories ARE `execution_workspaces.id` — and the
 * strictest one available, so it is used rather than a bespoke
 * "no separators, not dot-dot" check that would have to be argued complete.
 *
 * The cost is real and bounded: a foreign-claim directory whose name is not a
 * uuid is never planned, so it is never reclaimed by this path. On the mounted
 * sweep such a name resolves to no row and falls to the `mtime` fallback. Here
 * it is counted as `skippedUnsafeName` and left, which is the safe direction —
 * an unreclaimed directory costs capacity, a mis-scoped `rm -rf` costs data.
 *
 * ## Bounded, like the sweep it mirrors
 *
 * `maxEntries` defaults to `DEFAULT_MAX_DELETES_PER_TICK` for property 4's
 * reason: deletion on this filesystem is MDS-metadata-bound, and the executor is
 * a second unlink source against the same MDS. Truncation is reported rather
 * than silent, and the plan is sorted oldest-idle first so successive ticks make
 * progress through a backlog instead of re-offering the same head.
 */
export async function buildIsolationReclaimPlan(input: {
  inventory: ReadonlyArray<IsolationWorkspaceInventoryEntry>;
  lookupWorkspaceUsage: WorkspaceUsageLookup;
  maxAgeDays: number;
  maxEntries?: number;
  now?: () => number;
}): Promise<IsolationReclaimPlan> {
  const now = input.now ?? Date.now;
  const maxEntries = input.maxEntries ?? DEFAULT_MAX_DELETES_PER_TICK;
  const cutoff = now() - input.maxAgeDays * 86_400_000;

  const plan: IsolationReclaimPlan = {
    eligibleIds: [],
    retainedFresh: 0,
    retainedInUse: 0,
    skippedUnsafeName: 0,
    skippedMalformed: 0,
    skippedDuplicate: 0,
    droppedByBound: 0,
    truncated: false,
    inventorySize: input.inventory.length,
  };

  // Deduplicated as well as validated, for the same boundary reason: `readdir`
  // cannot return a name twice, but an inventory can, and a repeated name would
  // spend the `maxEntries` budget twice on one directory — pushing a real
  // candidate out of the plan while the second unlink only ever finds ENOENT.
  // First occurrence wins; a repeat carrying a different `mtimeMs` is incoherent
  // input, not a second directory to judge.
  const named: IsolationWorkspaceInventoryEntry[] = [];
  const seen = new Set<string>();
  for (const entry of input.inventory) {
    if (!UUID_PATTERN.test(entry.name)) {
      plan.skippedUnsafeName += 1;
      continue;
    }
    // `mtimeMs` is typed `number`, but it arrives over a serialization boundary
    // and the type is not enforcement. A missing, null, NaN or string value
    // makes `mtimeMs >= cutoff` FALSE, which routes the entry to `aged` — and a
    // `null` additionally sorts to the FRONT of the plan, so a malformed entry
    // would become the highest-priority deletion candidate. That is the
    // fail-open direction this module refuses everywhere else, so it is checked
    // here rather than left to the executor's own re-checks to catch.
    // (Ally, review of PR #3184.)
    if (!Number.isFinite(entry.mtimeMs)) {
      plan.skippedMalformed += 1;
      continue;
    }
    if (seen.has(entry.name)) {
      plan.skippedDuplicate += 1;
      continue;
    }
    seen.add(entry.name);
    named.push(entry);
  }
  if (named.length === 0) return plan;

  // One batched query for the whole plan, matching the mounted sweep's opening
  // snapshot. Unlike that sweep there is no pre-unlink re-read available from
  // here — the unlink happens in another process — so this snapshot is the only
  // database read the decision gets, and the executor's own staleness bound is
  // what has to close the window. That bound is the executor's to state; this
  // function's contract is only that the verdicts were true when taken.
  const usage = await input.lookupWorkspaceUsage(named.map((entry) => entry.name));

  const aged: Array<{ name: string; idleSinceMs: number }> = [];
  for (const entry of named) {
    const age = classifyIsolationWorkspaceAge({
      mtimeMs: entry.mtimeMs,
      owner: usage.get(entry.name),
      cutoff,
    });
    if (age.verdict === "fresh") plan.retainedFresh += 1;
    else if (age.verdict === "in_use") plan.retainedInUse += 1;
    else aged.push({ name: entry.name, idleSinceMs: age.idleSinceMs });
  }

  aged.sort((a, b) => a.idleSinceMs - b.idleSinceMs);
  plan.droppedByBound = Math.max(0, aged.length - maxEntries);
  plan.truncated = plan.droppedByBound > 0;
  plan.eligibleIds = aged.slice(0, maxEntries).map((entry) => entry.name);
  return plan;
}

/**
 * Default ceiling on how stale a plan may be at the moment of an unlink.
 *
 * The mounted sweep protects a live workspace by re-reading `lastUsedAt`
 * immediately before each `fs.rm`. **No analogue of that read exists here**, and
 * no other check substitutes for it: a run resuming a long-idle workspace
 * refreshes the row and writes *under* `home`/`session`, which changes the
 * root's existence not at all, its top-level layout not at all, and its `mtime`
 * not at all. So the executor cannot detect a resurrection — it can only refuse
 * to act on a verdict old enough for one to have happened.
 *
 * That makes plan age the executor's whole safety margin, and it is why this is
 * checked per entry rather than once at start-up. The unlink loop is the slow
 * part: `maxDeletes` removals against an MDS measured at 145 files/s serial can
 * run for minutes, which is exactly the window the mounted sweep's per-entry
 * re-read exists to close. A single check at the top would bound the moment the
 * executor *started* and leave that window wide open, which is the shape of
 * bound that reads as protection and is not.
 *
 * Ten minutes is chosen against both ends. It must exceed the ordinary distance
 * between "plan built" and "pod running" — Job admission, scheduling, image
 * pull — or a healthy sweep refuses itself and the tree is never reclaimed;
 * that failure is quiet, because refusing is also what a correct stale-plan
 * refusal looks like. It must stay comparable to the mounted sweep's own
 * snapshot-to-unlink window, which is minutes, or the foreign path is running a
 * materially weaker predicate than the one it claims to share.
 *
 * A Job's `activeDeadlineSeconds` does NOT cover this and must not be mistaken
 * for it: it starts counting when the pod starts, so it bounds execution time
 * while leaving queueing and image pull — the unbounded part — outside the
 * measurement entirely.
 *
 * ⚠ The foreign-claim path (PEN-5151) has a caller that raises this, and it is
 * held to `MAX_FOREIGN_PLAN_AGE_MS` below rather than being free to pick.
 */
export const DEFAULT_MAX_PLAN_AGE_MS = 10 * 60_000;

/**
 * Hard ceiling on a *derived* plan-age bound, for callers that compute one.
 *
 * `driveIsolationReclaim` (PEN-5151) runs this executor as a Job and must give
 * the plan a lifetime that survives admission, scheduling and the image pull —
 * so it derives one from the wait it grants. Left unbounded, that derivation
 * reads `activeDeadlineSeconds`, which the paragraph above says in so many
 * words must not be mistaken for this bound: it is a **liveness** knob, public
 * on the driver, and an operator raising it to give a slow MDS more time would
 * silently widen the window in which a resurrected workspace can still be
 * unlinked. That is a liveness setting quietly becoming a fail-open safety
 * setting, which is the shape this module refuses everywhere else.
 *
 * Fifteen minutes keeps the derived bound "comparable to the mounted sweep's
 * own snapshot-to-unlink window, which is minutes" — 1.5× the default rather
 * than the 2.5× an unclamped default budget produces, and, more importantly,
 * **constant**: it does not move when a liveness knob moves.
 *
 * This ceiling binds derivations only. An explicit `maxPlanAgeMs` from a caller
 * passes through untouched, because that parameter *is* the safety knob, named
 * as such — the hazard is a bound inferred from something that is not.
 */
export const MAX_FOREIGN_PLAN_AGE_MS = 15 * 60_000;

/**
 * How far in the FUTURE a plan's timestamp may sit before it is refused.
 *
 * The age bound above is one-sided, and one-sided is not enough. Any finite
 * `planBuiltAtMs` greater than `now()` makes `now() - planBuiltAtMs` negative,
 * so `> maxPlanAgeMs` is false on every iteration and the plan reads as
 * eternally fresh — the same "comparison whose false branch is the permissive
 * one" this module refuses everywhere else, landing on the one value that IS
 * the executor's safety margin. The finiteness guard does not reach it: a
 * future timestamp is a perfectly good number.
 *
 * Two realistic producers, neither exotic. A unit mismatch at the transport —
 * microseconds or nanoseconds where milliseconds were meant — lands decades
 * ahead. And a control-plane/executor clock skew beyond a few minutes does it
 * directly, which is worth taking seriously on a path whose entire guarantee is
 * a comparison of two clocks.
 *
 * A minute, because the bound has to absorb ordinary NTP-level skew between the
 * control plane and a node without absorbing either of the above: a unit
 * mismatch overshoots by decades, and a skew large enough to matter to a
 * ten-minute window is larger than this. (Ally, review of PR #3186.)
 */
export const MAX_PLAN_CLOCK_SKEW_MS = 60_000;

/**
 * Enumerate a claim the control plane cannot walk, as an executor can (PEN-5151).
 *
 * The inventory half of the handoff: this is everything the decision in
 * `buildIsolationReclaimPlan` needs that only a process holding the volume can
 * supply. It is deliberately dumb — one `readdir`, one `stat` each, no
 * judgement — because every judgement that can be made from the database
 * belongs on the other side of the boundary.
 *
 * Names are reported as found, including names that are not workspace ids. The
 * plan refuses those (`skippedUnsafeName`) and counts them, and that count is
 * the only way an operator learns a foreign claim is accumulating directories
 * nothing can resolve. Filtering here would delete the evidence rather than the
 * directory.
 *
 * Faults are per entry and never fatal, matching the mounted sweep: a directory
 * that vanishes between the `readdir` and its `stat` is simply absent from the
 * inventory, where it reads as a directory that no longer needs reclaiming —
 * which is true. An absent root yields an empty inventory for the same reason
 * the sweep treats it as the normal case on a deployment with no isolation tree.
 */
export async function collectIsolationWorkspaceInventory(
  root: string,
): Promise<IsolationWorkspaceInventoryEntry[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const inventory: IsolationWorkspaceInventoryEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const stat = await fs.stat(path.join(root, entry.name));
      inventory.push({ name: entry.name, mtimeMs: stat.mtimeMs });
    } catch {
      // Vanished or unreadable between the listing and the stat. Omitted rather
      // than reported with a sentinel `mtimeMs`: the plan's finiteness guard
      // would refuse it anyway, and a missing entry is the honest description.
      continue;
    }
  }
  return inventory;
}

/** Why an execution stopped before it had considered every planned id. */
export type IsolationReclaimStopReason = "complete" | "capped" | "plan_stale" | "plan_unusable";

/** What an executor did with the plan it was given, and what it refused. */
export interface IsolationReclaimExecutionResult {
  /** Plan entries received. The denominator for every counter below. */
  requested: number;
  /** Directories unlinked. Always 0 under `dryRun`. */
  deleted: number;
  /**
   * Passed every check and reached the unlink, under `dryRun`. Always 0 on a
   * live pass.
   *
   * Kept apart from both `deleted` and `notAttempted` so the identity below is a
   * real partition in either mode. Folding a dry run's outcome into
   * `notAttempted` would make a successful preview indistinguishable from a
   * plan the executor refused — and refusal is the one outcome on this path an
   * operator has to be able to see.
   */
  wouldDelete: number;
  /**
   * Refused at this end because the name is not a workspace id.
   *
   * The plan already refused these, so in a healthy pipeline this is always 0 —
   * and it is checked again anyway, because this is the process that calls
   * `fs.rm`. A name validated once at the producer is an unvalidated name at the
   * point of damage; the two checks are not redundant, they bracket a transport.
   */
  skippedUnsafeName: number;
  /** Top level was not exactly `REAPABLE_LAYOUT`. Property 1, re-asked here. */
  skippedLayout: number;
  /** Layout-compliant but holding a checkout one level down. */
  retainedNestedCheckout: number;
  /** Gone before this executor reached it — the concurrency-tolerant case. */
  vanished: number;
  /** A fault that was neither absence nor a refusal. */
  failed: number;
  /**
   * Planned entries never examined, because the per-tick bound was reached or
   * the plan went stale mid-loop. Not a refusal of those directories — they are
   * offered again on the next tick, and the plan's ordering is what makes that
   * progress rather than a loop over the same head.
   */
  notAttempted: number;
  /** `notAttempted` was produced by the bound. */
  capped: boolean;
  /**
   * Why the loop ended. Two of these want an operator, and they are kept apart
   * because the causes and the remedies are different — the same reason
   * `skippedMalformed` is not folded into `skippedUnsafeName`:
   *
   * - `plan_stale` — the distance from plan to unlink exceeded `maxPlanAgeMs`,
   *   so the executor refused the remainder rather than act on a verdict old
   *   enough for a workspace to have been resurrected under it. A real
   *   condition on a healthy system under load; the remedy is scheduling.
   * - `plan_unusable` — the plan could not be judged at all, so NOTHING was
   *   examined: a non-finite timestamp or ceiling, a non-finite `maxDeletes`,
   *   or a timestamp dated into the future past the allowed clock skew. Every
   *   one of those is a transport, unit or clock defect rather than a slow
   *   pipeline, and reporting it as `plan_stale` would hide a permanent bug
   *   inside a counter that is expected to move.
   */
  stopReason: IsolationReclaimStopReason;
}

/**
 * The unlink half of the handoff — the executor's end (PEN-5151).
 *
 * Runs where the bytes are, against a claim the control plane does not mount.
 * It receives `eligibleIds` from `buildIsolationReclaimPlan` and treats each as
 * **permission to consider a directory, never an instruction to remove one**:
 * the two retention checks that can only be answered from the filesystem —
 * `isReapableLayout` and `hasNestedCheckout` — are asked here, immediately
 * before the unlink, exactly as the mounted sweep asks them. They are the same
 * functions, not a second implementation, which is the point of this living in
 * this module.
 *
 * ## The property this half does NOT have
 *
 * The mounted sweep re-reads `lastUsedAt` per directory immediately before
 * `fs.rm`, and that read is the only thing standing between a resurrected
 * workspace and deletion underneath a live run. An executor with no database
 * cannot take it, and giving it one would move every deletion decision onto the
 * volume being deleted — the thing the split exists to avoid.
 *
 * So the margin is time, and it is enforced rather than assumed: every entry is
 * attempted only while the plan is younger than `maxPlanAgeMs`, and the
 * remainder is handed back as `notAttempted` with `stopReason: "plan_stale"`.
 * This is strictly weaker than a re-read and is recorded as such — it bounds the
 * window in which a resurrection could go unseen, where the mounted sweep
 * observes the resurrection itself. See `DEFAULT_MAX_PLAN_AGE_MS`.
 *
 * ## Accounting
 *
 * Every planned id lands in exactly one bucket, so
 * `requested === deleted + wouldDelete + skippedUnsafeName + skippedLayout +
 * retainedNestedCheckout + vanished + failed + notAttempted`. Held by a test,
 * for the reason the plan's own identity is: this result and the plan are the
 * entire operator surface for a volume nobody can walk, and a count that looks
 * complete over a population it is not is the exact failure PEN-5125 filed.
 */
export async function executeIsolationReclaimPlan(options: {
  root: string;
  eligibleIds: ReadonlyArray<string>;
  /** When the plan's database snapshot was taken, as epoch ms. */
  planBuiltAtMs: number;
  maxPlanAgeMs?: number;
  maxDeletes?: number;
  dryRun?: boolean;
  now?: () => number;
  logger?: typeof defaultLogger;
}): Promise<IsolationReclaimExecutionResult> {
  const now = options.now ?? Date.now;
  const log = options.logger ?? defaultLogger;
  const maxDeletes = options.maxDeletes ?? DEFAULT_MAX_DELETES_PER_TICK;
  const maxPlanAgeMs = options.maxPlanAgeMs ?? DEFAULT_MAX_PLAN_AGE_MS;

  const result: IsolationReclaimExecutionResult = {
    requested: options.eligibleIds.length,
    deleted: 0,
    wouldDelete: 0,
    skippedUnsafeName: 0,
    skippedLayout: 0,
    retainedNestedCheckout: 0,
    vanished: 0,
    failed: 0,
    notAttempted: 0,
    capped: false,
    stopReason: "complete",
  };

  // Everything the loop's two bounds rest on, checked once before any of it
  // runs. All three values cross the same serialization boundary `mtimeMs`
  // does, and all three fail the same way — into the PERMISSIVE branch, because
  // every bound below is a comparison whose false arm is "keep going":
  //
  // - `planBuiltAtMs` missing / null / NaN / a string: `now() - x >
  //   maxPlanAgeMs` is false forever, so the plan reads as eternally fresh and
  //   the executor unlinks the lot with its only safety margin disabled.
  // - `planBuiltAtMs` in the FUTURE: a perfectly finite number that produces a
  //   negative age, with exactly the same effect. See `MAX_PLAN_CLOCK_SKEW_MS`
  //   — the age bound is one-sided, and one-sided is not enough.
  // - `maxPlanAgeMs` or `maxDeletes` non-finite: same shape, on the ceiling
  //   rather than the measurement. A NaN `maxDeletes` makes
  //   `unlinkAttempts >= maxDeletes` false forever, silently removing the
  //   per-tick MDS bound that is property 4 of this module.
  //
  // Refusing the whole plan rather than clamping, because a value this wrong is
  // evidence about the transport, and continuing under a repaired guess would
  // make the next operator debug a sweep that half worked.
  const planAgeMs = now() - options.planBuiltAtMs;
  const unusable =
    !Number.isFinite(options.planBuiltAtMs)
      ? "planBuiltAtMs is not a finite number"
      : !Number.isFinite(maxPlanAgeMs)
        ? "maxPlanAgeMs is not a finite number"
        : !Number.isFinite(maxDeletes) || maxDeletes < 0
          ? "maxDeletes is not a finite, non-negative number"
          : planAgeMs < -MAX_PLAN_CLOCK_SKEW_MS
            ? "planBuiltAtMs is in the future beyond the allowed clock skew"
            : null;
  if (unusable) {
    result.notAttempted = options.eligibleIds.length;
    result.stopReason = "plan_unusable";
    log.error(
      {
        root: options.root,
        reason: unusable,
        planBuiltAtMs: options.planBuiltAtMs,
        planAgeMs,
        maxPlanAgeMs,
        maxDeletes,
        maxClockSkewMs: MAX_PLAN_CLOCK_SKEW_MS,
      },
      "isolation reclaim executor refused a plan it cannot judge; nothing was examined",
    );
    return result;
  }

  // Counts entries that reached the unlink point, whatever happened there, so
  // the bound caps work a live pass would perform rather than unlinks that
  // succeeded — the mounted sweep caps on `eligible` for the same reason, and it
  // is what makes a dry run stop at the directory a live run would.
  let unlinkAttempts = 0;
  for (let i = 0; i < options.eligibleIds.length; i += 1) {
    const name = options.eligibleIds[i] as string;

    // Re-checked per entry, not once at the top: the loop below is the slow
    // part, so a single check would bound the wrong interval. See
    // `DEFAULT_MAX_PLAN_AGE_MS`.
    if (now() - options.planBuiltAtMs > maxPlanAgeMs) {
      result.notAttempted = options.eligibleIds.length - i;
      result.stopReason = "plan_stale";
      log.warn(
        {
          root: options.root,
          planAgeMs: now() - options.planBuiltAtMs,
          maxPlanAgeMs,
          deleted: result.deleted,
          notAttempted: result.notAttempted,
        },
        "isolation reclaim executor stopped on a stale plan; the remaining ids were not examined " +
          "because their idle verdict is old enough that a workspace could have been resumed under it",
      );
      break;
    }

    if (!UUID_PATTERN.test(name)) {
      // Unreachable from a plan this repo built, and checked anyway — see
      // `skippedUnsafeName`. Logged at error because it means the transport, not
      // the volume, is wrong.
      //
      // The name goes in the record, truncated. Without it the line says only
      // that something was refused, which cannot distinguish a serialization
      // bug from a tampered payload — and this counter is expected to sit at
      // zero forever, so the one time it moves is the one time the value
      // matters. Truncated because it is the only field here that is neither
      // generated nor validated by this process, and an unbounded one would let
      // a single malformed entry dominate the log.
      result.skippedUnsafeName += 1;
      log.error(
        { root: options.root, refusedName: String(name).slice(0, 128) },
        "isolation reclaim executor refused a planned entry whose name is not a workspace id",
      );
      continue;
    }

    if (unlinkAttempts >= maxDeletes) {
      result.notAttempted = options.eligibleIds.length - i;
      result.capped = true;
      result.stopReason = "capped";
      break;
    }

    const dir = path.join(options.root, name);

    let children: string[];
    try {
      children = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") result.vanished += 1;
      else {
        result.failed += 1;
        log.error({ err, dir }, "isolation reclaim executor could not read a planned workspace");
      }
      continue;
    }

    if (!isReapableLayout(children)) {
      result.skippedLayout += 1;
      log.warn(
        { dir, layout: [...children].sort() },
        "isolation reclaim executor skipped a planned directory outside the layout allowlist",
      );
      continue;
    }

    if (await hasNestedCheckout(dir)) {
      result.retainedNestedCheckout += 1;
      log.warn(
        { dir },
        "isolation reclaim executor retained a layout-compliant directory holding a nested git checkout",
      );
      continue;
    }

    unlinkAttempts += 1;

    if (options.dryRun) {
      log.info({ dir }, "isolation reclaim executor would remove a planned workspace (dry run)");
      result.wouldDelete += 1;
      continue;
    }

    try {
      // No `force`, for the sweep's reason: a directory that vanished must raise
      // ENOENT and be counted, not be reported as a deletion that happened.
      await fs.rm(dir, { recursive: true });
      result.deleted += 1;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") result.vanished += 1;
      else {
        result.failed += 1;
        log.error({ err, dir }, "isolation reclaim executor failed to remove a planned workspace");
      }
    }
  }

  log.info(
    { root: options.root, dryRun: options.dryRun === true, maxPlanAgeMs, ...result },
    "isolation reclaim execution complete",
  );
  return result;
}

function isReapableLayout(entries: string[]): boolean {
  if (entries.length !== REAPABLE_LAYOUT.length) return false;
  const sorted = [...entries].sort();
  return REAPABLE_LAYOUT.every((name, i) => sorted[i] === name);
}

/**
 * Property 1 inspects the workspace's own top level and nothing below it. A git
 * worktree lives one level below: `home/<name>/.git` is a *file* holding
 * `gitdir: …/<shared project repo>/.git/worktrees/<name>`. So a directory whose
 * top level is exactly `{home, session}` — fully compliant, indistinguishable
 * from an orphan — can still hold live checkouts, and removing it reaches
 * **outside this root**: the working tree is destroyed, and the shared repo is
 * left carrying a dangling registration that makes `git worktree list` report a
 * path that no longer exists and `git worktree add <same name>` fail until
 * someone runs `git worktree prune`.
 *
 * Measured on the live tree 2026-10-09 (BLO-36735), against the first deployed
 * dry-run tick: **13 of the 503 directories in the match set** hold a checkout
 * or a non-empty `home/.paperclip-worktrees`. Six are worktrees of one live
 * `pim-multicast-gateway` checkout and are registered in its `worktree list`;
 * one carries an uncommitted change. Nothing unpushed was found, so the loss is
 * bounded — but it is silent, and it lands on a repo this module does not own.
 *
 * Cost on that tree: 13 of 503 directories (2.6% by count), but 23.7 of
 * 141.6 GiB — **16.7% of the space** and 15.9% of the entries (550,692 of
 * 3,467,038). Even by count that is ~12x property 1's one-in-448, so this is
 * not the same trade; it is still the right one, because what it keeps is live
 * work in a repo this module does not own. Quote the space share, not the
 * count, when weighing whether to loosen it. Both
 * `home` and `session` are probed: a registered worktree was found under each.
 *
 * Cost is bounded by construction — this runs only for a directory that has
 * already passed the age gate *and* the top-level allowlist, i.e. one about to
 * be unlinked, which is far more metadata work than the probe. That keeps
 * property 4 intact.
 *
 * Unreadable is not evidence of absence, so every fault here retains.
 */
async function hasNestedCheckout(dir: string): Promise<boolean> {
  try {
    for (const side of REAPABLE_LAYOUT) {
      const base = path.join(dir, side);
      const children = await fs.readdir(base);
      // A repo rooted at the side itself, then one rooted at each child.
      for (const root of [base, ...children.map((child) => path.join(base, child))]) {
        if (await isPresent(() => fs.stat(path.join(root, ".git")))) return true;
      }
      for (const parent of WORKTREE_PARENT_DIRS) {
        const entries = await isPresent(() => fs.readdir(path.join(base, parent)));
        if (entries && entries.length > 0) return true;
      }
    }
  } catch {
    return true;
  }
  return false;
}

/**
 * Runs `probe`, mapping ENOENT/ENOTDIR — "nothing there" — to `false`. Every
 * other fault is rethrown so `hasNestedCheckout` retains: EACCES or ELOOP on a
 * `.git` is not evidence that no checkout is there.
 */
async function isPresent<T>(probe: () => Promise<T>): Promise<T | false> {
  try {
    return await probe();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw err;
  }
}

/**
 * One sweep. Never throws for a per-directory fault: a single unreadable or
 * concurrently-removed workspace must not abort the pass.
 */
export async function reapIsolationWorkspaces(
  options: IsolationWorkspaceReapOptions,
): Promise<IsolationWorkspaceReapResult> {
  const root = options.root ?? DEFAULT_ISOLATION_WORKSPACE_ROOT;
  const maxDeletes = options.maxDeletesPerTick ?? DEFAULT_MAX_DELETES_PER_TICK;
  const now = options.now ?? Date.now;
  const log = options.logger ?? defaultLogger;
  const lookupWorkspaceUsage = options.lookupWorkspaceUsage;
  const cutoff = now() - options.maxAgeDays * 86_400_000;

  const result: IsolationWorkspaceReapResult = {
    scanned: 0,
    eligible: 0,
    deleted: 0,
    skippedLayout: 0,
    retainedNestedCheckout: 0,
    retainedInUse: 0,
    retainedResurrected: 0,
    retainedFresh: 0,
    vanished: 0,
    failed: 0,
    capped: false,
    lookupFaulted: false,
    unreachableAgents: UNREACHABLE_AGENTS_UNKNOWN,
  };

  // Probed BEFORE the root `readdir`, so the root-absent return below carries
  // it too. That path is the one where coverage matters most: a reaper aimed at
  // a path that does not exist on a fleet that has moved its trees elsewhere is
  // the exact BLO-31222 shape, and `root_absent` alone cannot say whether the
  // bytes went somewhere or were never there.
  //
  // Never fatal. This is an observation about the sweep, not an input to it —
  // nothing here decides what gets deleted — so a fault leaves the sentinel in
  // place and the pass proceeds. Failing the sweep on it would trade a capacity
  // blind spot for a reclamation outage.
  if (options.countUnreachableAgents) {
    try {
      result.unreachableAgents = await options.countUnreachableAgents();
    } catch (err) {
      log.error(
        { err },
        "isolation-workspace reaper could not determine how many agents' trees it cannot reach; " +
          "sweep coverage is unknown for this tick",
      );
    }
  }
  if (result.unreachableAgents > 0) {
    log.warn(
      { root, unreachableAgents: result.unreachableAgents },
      "isolation-workspace reaper cannot reach every agent's isolation tree; " +
        "this sweep's outcome counters describe a subset of the population (PEN-5125)",
    );
  }

  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    // An absent root is the normal case on a non-k8s-isolation deployment.
    //
    // BLO-36814: record it anyway. Returning here without touching the
    // registry leaves an ENABLED reaper pointed at a WRONG path looking
    // exactly like a disabled one — absent series, no alert, tree growing
    // unreclaimed. That is the BLO-31222 incident shape, and it is the same
    // blind spot this metric exists to remove. `root_absent` keeps it
    // distinguishable from a clean sweep over a tree that really is empty.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      log.info(
        { root, maxAgeDays: options.maxAgeDays, dryRun: options.dryRun === true, ...result },
        "isolation-workspace reaper sweep complete (root absent)",
      );
      recordIsolationWorkspaceReapSweep(result, {
        dryRun: options.dryRun === true,
        now,
        stopReason: "root_absent",
      });
      return result;
    }
    throw err;
  }

  const directories = entries.filter((entry) => entry.isDirectory());
  // One batched query for the whole sweep, rather than a round trip per directory.
  const usage = await lookupWorkspaceUsage(directories.map((entry) => entry.name));

  for (const entry of directories) {
    result.scanned += 1;
    const dir = path.join(root, entry.name);
    const owner = usage.get(entry.name);

    // The age test. One `stat`, then `classifyIsolationWorkspaceAge` — which
    // is shared with `buildIsolationReclaimPlan` so the two sweeps cannot
    // drift. See that function for why both signals are required.
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(dir)).mtimeMs;
    } catch {
      result.vanished += 1;
      continue;
    }

    const age = classifyIsolationWorkspaceAge({ mtimeMs, owner, cutoff });
    if (age.verdict === "fresh") {
      result.retainedFresh += 1;
      continue;
    }
    if (age.verdict === "in_use") {
      result.retainedInUse += 1;
      continue;
    }
    const idleSinceMs = age.idleSinceMs;

    let children: string[];
    try {
      children = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") result.vanished += 1;
      else result.failed += 1;
      continue;
    }

    if (!isReapableLayout(children)) {
      result.skippedLayout += 1;
      // Logged individually and on purpose: the log line carries the path, and
      // the path is the only way to tell the two populations in this counter
      // apart. A skip is either single-sided (`{home}` or `{session}` alone — a
      // half-materialized workspace, carrying no heterogeneity at all) or a
      // genuine superset (an extra top-level entry), and only the second is
      // worth a human look before the next pass widens the allowlist.
      //
      // ⚠ The counter cannot distinguish them, so do not read its total as a
      // rise. Measured over the whole live tree at maxAgeDays=30 on 2026-10-11
      // (BLO-36735): 50 skips = 42 single-sided + 8 supersets, that subset
      // unchanged from 2026-10-10. This comment previously gave "the historical
      // baseline of 1" — the superset count when BLO-36735 first measured it,
      // before the single-sided population existed at scale. Against a live
      // total of 50 that reads as a 50x rise with a benign cause, which is how
      // a real rise gets missed. Splitting this by a `reason` label is the
      // durable fix; until then runbooks/isolation-workspace-reaper.md carries
      // the tree-side split.
      //
      // Scope, so the counts are not over-read: this observes **aged**
      // directories only. The fresh-`mtime` retention above `continue`s before
      // the layout check, so a newly created worktree-shaped directory is
      // counted `retainedFresh` and goes unreported until it crosses
      // `maxAgeDays`. Checking layout first would surface it during the window
      // a human could act on it most cheaply, but it costs a `readdir` on every
      // young directory on every sweep — and bounding exactly that MDS
      // metadata load is property 4 of this module. The safety allowlist is
      // unaffected either way, since both paths retain; only the warning is
      // delayed. Deliberate trade, recorded rather than left to be rediscovered.
      log.warn(
        {
          dir,
          layout: [...children].sort(),
          ageDays: (now() - idleSinceMs) / 86_400_000,
          ageSource: owner ? "lastUsedAt" : "mtime",
        },
        "isolation-workspace reaper skipped a directory outside the layout allowlist",
      );
      continue;
    }

    // Only reached when the top level already qualifies: a directory the
    // allowlist rejects was skipped unexamined above, which is property 1.
    // Counted and logged apart from that skip — this one *was* examined and its
    // top level *did* match, so folding it in would hide a real rise in
    // `skippedLayout` under a steady nested-checkout population (BLO-36735).
    if (await hasNestedCheckout(dir)) {
      result.retainedNestedCheckout += 1;
      log.warn(
        {
          dir,
          ageDays: (now() - idleSinceMs) / 86_400_000,
          ageSource: owner ? "lastUsedAt" : "mtime",
        },
        "isolation-workspace reaper retained a layout-compliant directory holding a nested git checkout",
      );
      continue;
    }

    // Cap on the work a real pass would perform, not on unlinks already done, so
    // that a dry run stops at the same directory a live run would and a tick
    // whose remaining entries were all retained does not report itself capped.
    if (result.eligible >= maxDeletes) {
      result.capped = true;
      result.scanned -= 1;
      break;
    }

    // Property 3, for the one signal that can protect a live workspace.
    //
    // Existence and layout were both re-checked just above, and neither can see
    // a resurrection: restoring a workspace refreshes `lastUsedAt` and writes
    // *under* `home`/`session`, leaving the root present, its top level
    // unchanged, and its `mtime` unchanged. So the sweep's opening snapshot is
    // the only stale input here — and it is not stale by a hair. `maxDeletes`
    // unlinks against an MDS measured at 145 files/s serial can hold that
    // window open for minutes, which is long enough for a run to restore this
    // workspace and start writing to it. Deleting underneath such a run is
    // strictly worse than the cold start this module budgets for.
    //
    // One primary-key lookup per prospective unlink, at most `maxDeletes` per
    // tick on a pass that runs daily — negligible against the unlink it guards.
    // `dryRun` skips it, so a preview still costs exactly one query; the
    // consequence is that a dry run may report as eligible a workspace the live
    // pass would then retain, which is the harmless direction.
    //
    // A lookup fault ends the tick rather than being swallowed per directory:
    // unlike an unreadable directory it is not local to one entry, and the
    // fail-closed reading of "cannot confirm idle" is "do not delete". The next
    // tick retries from a fresh snapshot.
    //
    // It `break`s rather than throwing, and that distinction is load-bearing.
    // This is the only call in the sweep that can fault *after* irreversible
    // removals — up to `maxDeletes` of them — so letting it propagate would
    // discard `result` and with it the count of what was already unlinked, on
    // precisely the run an operator most needs to reconstruct. Breaking keeps
    // the fail-closed semantics identical (no further deletions this tick) and
    // still reaches the summary log with real counts. It is also what keeps the
    // "never throws for a per-directory fault" contract on this function true.
    if (!options.dryRun) {
      let current: WorkspaceUsageRow | undefined;
      try {
        current = (await lookupWorkspaceUsage([entry.name])).get(entry.name);
      } catch (err) {
        result.lookupFaulted = true;
        log.error(
          { err, dir, deleted: result.deleted },
          "isolation-workspace reaper could not re-confirm a workspace was idle; " +
            "ending the tick with deletions already performed",
        );
        break;
      }
      if (current && current.lastUsedAt.getTime() >= cutoff) {
        // The near miss. Counted and logged separately from the ordinary
        // snapshot-time retention above because this one is a workspace that
        // was one query away from being deleted underneath a live run — the
        // exact event this re-read was added to prevent. Both timestamps go in
        // the record so the width of the window that was actually observed can
        // be read off production rather than argued from the MDS throughput
        // estimate.
        result.retainedResurrected += 1;
        log.warn(
          {
            dir,
            snapshotLastUsedAt: owner ? owner.lastUsedAt.toISOString() : null,
            currentLastUsedAt: current.lastUsedAt.toISOString(),
            cutoff: new Date(cutoff).toISOString(),
          },
          "isolation-workspace reaper retained a workspace resurrected mid-sweep",
        );
        continue;
      }
    }

    result.eligible += 1;

    if (options.dryRun) {
      // The operator inspecting a dry run has to be able to tell a true orphan
      // from a workspace the database still owns; printing the age source is
      // what makes that distinction visible before the first live pass.
      log.info(
        {
          dir,
          idleSince: new Date(idleSinceMs).toISOString(),
          ageDays: (now() - idleSinceMs) / 86_400_000,
          ageSource: owner ? "lastUsedAt" : "mtime",
          status: owner?.status ?? null,
          closedAt: owner?.closedAt?.toISOString() ?? null,
        },
        "isolation-workspace reaper would remove a workspace (dry run)",
      );
      continue;
    }

    try {
      // No `force`: a directory that vanishes mid-sweep must raise ENOENT so it
      // is counted as `vanished` rather than silently reported as a deletion.
      await fs.rm(dir, { recursive: true });
      result.deleted += 1;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") result.vanished += 1;
      else {
        result.failed += 1;
        log.error({ err, dir }, "isolation-workspace reaper failed to remove a workspace");
      }
    }
  }

  log.info(
    { root, maxAgeDays: options.maxAgeDays, dryRun: options.dryRun === true, ...result },
    "isolation-workspace reaper sweep complete",
  );
  // BLO-36814. The log line above lives on one pod with log retention; this is
  // the scraped surface that says a daily irreversible-delete sweep is still
  // ticking. Both, deliberately: the counters answer "how many, of which
  // outcome, over what window" long after the pod is gone, the log keeps the
  // per-directory detail that must never become a label.
  recordIsolationWorkspaceReapSweep(result, { dryRun: options.dryRun === true, now });
  return result;
}

export type IsolationWorkspaceReaperScheduler = {
  setInterval: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  clearInterval: (timer: ReturnType<typeof setInterval>) => void;
};

const defaultScheduler: IsolationWorkspaceReaperScheduler = { setInterval, clearInterval };

export function startIsolationWorkspaceReaper(
  db: Db,
  intervalMs: number,
  options: Omit<IsolationWorkspaceReapOptions, "lookupWorkspaceUsage"> &
    Partial<Pick<IsolationWorkspaceReapOptions, "lookupWorkspaceUsage">>,
  scheduler: IsolationWorkspaceReaperScheduler = defaultScheduler,
): () => void {
  const log = options.logger ?? defaultLogger;
  // Built once: the lookup holds no per-sweep state, and building it per tick
  // would only re-close over the same handle.
  const sweepOptions: IsolationWorkspaceReapOptions = {
    ...options,
    lookupWorkspaceUsage: options.lookupWorkspaceUsage ?? createDbWorkspaceUsageLookup(db),
    // Defaulted here rather than left to `index.ts`, so the single production
    // entry point cannot be wired up coverage-blind by omission (PEN-5125).
    countUnreachableAgents:
      options.countUnreachableAgents ?? createDbUnreachableAgentCount(db, options.selfDataClaimName),
  };
  let inFlight: Promise<void> | null = null;
  const runTick = () => {
    // Ticks are serialized: a sweep that outruns its interval against a slow
    // MDS must not stack concurrent passes over the same tree.
    if (inFlight) return;
    inFlight = reapIsolationWorkspaces(sweepOptions)
      .catch((err) => {
        log.error({ err }, "isolation-workspace reaper sweep failed");
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
