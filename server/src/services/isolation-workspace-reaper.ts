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
 * ⛔ It is NOT wired to an executor yet, and nothing calls it on the reap path.
 * Landing the decision half reviewed and inert ahead of the Job that consumes
 * it is the posture `workspace-pvc.ts` took for the claim itself, and for the
 * same reason: the half that decides what gets deleted is the half worth
 * reviewing on its own. Until that executor exists a foreign claim is still
 * unreclaimed, and `unreachableAgents` is still the standing record of it.
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
  /** True when `maxEntries` dropped eligible entries from the tail. */
  truncated: boolean;
  /** Entries considered, so a reader can check the buckets against the input. */
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
    if (seen.has(entry.name)) continue;
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
  plan.truncated = aged.length > maxEntries;
  plan.eligibleIds = aged.slice(0, maxEntries).map((entry) => entry.name);
  return plan;
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
