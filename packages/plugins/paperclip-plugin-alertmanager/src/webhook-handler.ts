/**
 * Webhook handler logic — separated from `worker.ts` so tests can drive it
 * without triggering the RPC host bootstrap that runs at module load time.
 *
 * All host interaction goes through the `PluginContext` argument; the
 * resolved bearer token is passed in explicitly so the handler stays
 * independent of how the operator chose to supply it (secret-ref vs inline).
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { PluginContext, PluginFencingPrecondition, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import {
  ACCEPTED_SCHEMA_VERSIONS,
  DEFAULT_OPERATOR_SUPPRESSION_HOURS,
  MAX_OPERATOR_SUPPRESSION_HOURS,
  WEBHOOK_KEYS,
  alertStateRef,
  legacyInstanceAlertStateRef,
} from "./constants.js";
import {
  alertMatchesLabelFilter,
  buildIssueDescription,
  buildIssueTitle,
  effectiveAlertStatus,
  severityToPriority,
} from "./issue-mapping.js";
import { resolveIssueRoute } from "./issue-route-resolver.js";
import { resolveAssigneeUserId, resolveFallbackAgentId } from "./owner-resolver.js";
import { aggregateKeyForAlert } from "./aggregate-key.js";
import { escalationDeadlineMs, recordSourceResolvedAndCloseCovers } from "./escalation.js";
import {
  ORIGIN_KIND,
  type AlertStateRecord,
  type AlertmanagerAlert,
  type AlertmanagerPluginConfig,
  type AlertmanagerWebhookPayload,
} from "./types.js";

export class WebhookUnauthorizedError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "WebhookUnauthorizedError";
  }
}

/**
 * Raised after the per-alert loop when at least one alert in the batch could not
 * be processed, so that the delivery fails and Alertmanager retries it.
 *
 * Alerts are caught individually to keep batch isolation — one poisoned alert
 * must not abandon its siblings — but "isolated" must not become "acknowledged".
 * Returning normally makes the host record `success` and answer HTTP 200
 * (`server/src/routes/plugins.ts` "Step 8"), which ends Alertmanager's retries
 * for a delivery that produced no durable issue or state row.
 */
export class AlertDeliveryIncompleteError extends Error {
  readonly fingerprints: readonly string[];

  constructor(fingerprints: readonly string[]) {
    super(
      `${fingerprints.length} alert(s) in this delivery could not be processed (${fingerprints.join(", ")}) — failing the delivery so Alertmanager retries`,
    );
    this.name = "AlertDeliveryIncompleteError";
    this.fingerprints = fingerprints;
  }
}

const AGGREGATE_CREATION_CLAIMS_TABLE = "alertmanager_aggregate_creation_claims";
const AGGREGATE_MEMBERS_TABLE = "alertmanager_aggregate_members";
const AGGREGATE_LIFECYCLE_FENCES_TABLE = "alertmanager_aggregate_lifecycle_fences";

/**
 * Identity of *this* worker process, minted once at module load (BLO-31036).
 *
 * This is deliberately not the host's `instanceInfo.instanceId`, which the SDK
 * documents as the UUID of the Paperclip *instance* and which therefore
 * survives a restart — the one property that makes it useless as proof of
 * death.
 *
 * Every concurrent delivery inside this process shares this id. That is the
 * point, not an accident: the RPC layer pipelines `handleWebhook` calls into
 * the single worker child, so two firing deliveries genuinely interleave, and
 * a per-*delivery* id would let them steal each other's live fences — the
 * exact race the fence exists to prevent.
 */
const WORKER_INSTANCE_ID = randomUUID();

/**
 * The worker's slot: stable across restarts, unique per concurrent host.
 *
 * Ownership is only ever stolen within the same slot. The plugin worker is a
 * cluster-wide singleton today (StatefulSet `paperclip` runs `replicas: 1` with
 * `PAPERCLIP_NODE_ROLE=worker`, while the api replicas swap in a plugin-worker
 * stub that never forks a child), but that singleton rests partly on chart
 * configuration: an unknown `PAPERCLIP_NODE_ROLE` value falls back to `"all"`,
 * so a typo on an api replica would silently add a second plugin host.
 *
 * Keying the steal on the slot means correctness does not depend on that
 * config being right. Within one slot, a new process proves the old one is gone
 * (Kubernetes recreates a StatefulSet ordinal only after the previous pod has
 * fully terminated); across slots, nothing is ever assumed dead.
 *
 * Falls back to a per-process value when `HOSTNAME` is unset, which is
 * fail-safe: an unidentifiable slot matches no stored slot, so it steals
 * nothing.
 */
const WORKER_SLOT = process.env.HOSTNAME?.trim() || `unknown-slot:${WORKER_INSTANCE_ID}`;

/** Test seam: the identity this process claims fences under. */
export function workerFenceIdentity(): { instanceId: string; slot: string } {
  return { instanceId: WORKER_INSTANCE_ID, slot: WORKER_SLOT };
}

type IssueReference = {
  id: string;
  status?: string | null;
  assigneeUserId?: string | null;
  assigneeAgentId?: string | null;
};

type AggregateMemberResolution = {
  disposition:
    | "no-membership"
    | "has-unresolved-siblings"
    | "last-member-resolved"
    | "finalization-pending";
  issueId: string;
  resolutionToken?: string;
};

/**
 * Outcome of claiming the firing fence. On refusal it carries the phase that
 * held the fence so the delivery error can name it, because that phase decides
 * the operator's next move: `firing` and `cancelling` are both owners that a
 * new claim will not displace while they may still be live.
 *
 * Since BLO-31036 a refusal no longer implies a permanent wedge — a fence whose
 * owner has provably died is released by the next worker in that slot, either
 * by the startup sweep or by the next firing claim. A refusal that *persists*
 * therefore means the owner is live, or holds the fence from another slot.
 */
type AggregateFiringClaim =
  | { ok: true; token: string }
  | { ok: false; blockingPhase: string | null };

function q(ns: string, table: string): string {
  return `${ns}.${table}`;
}

async function findActiveAggregateIssue(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
): Promise<IssueReference | null> {
  const activeStatuses = [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "blocked",
  ] as const;
  for (const status of activeStatuses) {
    const [issue] = await ctx.issues.list({
      companyId,
      originKind: ORIGIN_KIND,
      originFingerprint: aggregateKey,
      status,
      limit: 1,
    });
    if (issue) return issue;
  }
  return null;
}

async function tryClaimAggregateCreation(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
): Promise<string | null> {
  const ns = ctx.db.namespace;
  await ctx.db.execute(
    `DELETE FROM ${q(ns, AGGREGATE_CREATION_CLAIMS_TABLE)}
     WHERE company_id = $1
       AND aggregate_key = $2
       AND claimed_at < now() - interval '5 minutes'`,
    [companyId, aggregateKey],
  );
  const claimToken = randomUUID();
  const result = await ctx.db.execute(
    `INSERT INTO ${q(ns, AGGREGATE_CREATION_CLAIMS_TABLE)}
       (company_id, aggregate_key, claim_token)
     VALUES ($1, $2, $3)
     ON CONFLICT (company_id, aggregate_key) DO NOTHING`,
    [companyId, aggregateKey, claimToken],
  );
  return result.rowCount > 0 ? claimToken : null;
}

async function releaseAggregateCreationClaim(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
  claimToken: string,
): Promise<void> {
  const ns = ctx.db.namespace;
  await ctx.db.execute(
    `DELETE FROM ${q(ns, AGGREGATE_CREATION_CLAIMS_TABLE)}
     WHERE company_id = $1 AND aggregate_key = $2 AND claim_token = $3`,
    [companyId, aggregateKey, claimToken],
  );
}

/**
 * Raised when this delivery no longer holds the firing generation it claimed.
 *
 * Distinct from a generic failure because the re-fire path tolerates issue
 * RPC errors (it records that the decision was not applied and carries on).
 * Losing the generation is not a tolerable re-sync failure — it means another
 * owner has taken the aggregate — so it must escape that catch, not be logged
 * and swallowed.
 */
export class AggregateGenerationLostError extends Error {
  constructor(aggregateKey: string) {
    super(
      `Alertmanager aggregate ${aggregateKey} was reclaimed by another owner ` +
        `while this firing delivery was in flight; abandoning before mutating ` +
        `the tracked issue. Failing the delivery so Alertmanager retries ` +
        `against the owner that now holds the fence.`,
    );
    this.name = "AggregateGenerationLostError";
  }
}

/**
 * The same generation, expressed so the *host* can enforce it.
 *
 * `assertFiringGeneration` below can only prove ownership at the moment it
 * runs. Passing this alongside a mutating `issues.*` call moves the check into
 * the transaction that performs the mutation, where it is held under a share
 * lock until commit — so a steal can no longer land between "still mine?" and
 * the write. That is the difference between a barrier and a fence, and it is
 * why the barrier is now only a fast path (BLO-31049).
 */
function firingFence(
  companyId: string,
  aggregateKey: string,
  firingToken: string,
): PluginFencingPrecondition {
  return {
    table: AGGREGATE_LIFECYCLE_FENCES_TABLE,
    match: {
      company_id: companyId,
      aggregate_key: aggregateKey,
      phase: "firing",
      firing_token: firingToken,
    },
  };
}

/**
 * Throw unless this delivery still holds the firing fence under `firingToken`.
 *
 * `upsertAggregateMember` gates the member row on the generation atomically,
 * but the aggregate's other side effects are host RPCs — `issues.update`,
 * `issues.create`, `issues.createComment` — which cannot join a transaction in
 * this plugin's database. Without a check in front of them, a displaced
 * predecessor ran the *whole* re-fire path (reopening a cancelled issue,
 * rewriting its description, creating an orphan issue) and only lost the race
 * at the member write, several RPCs later. The damage was already done.
 *
 * So this is a barrier, not a lock: it converts "always mutates, then fails"
 * into "is rejected before mutating". A predecessor already displaced when it
 * reaches the barrier cannot touch the issue at all.
 *
 * It is now a *fast path* rather than the authoritative check. Every mutating
 * `issues.*` call below also carries `firingFence(...)`, which the host checks
 * under a share lock inside the mutation's own transaction (BLO-31049). That is
 * what closes the window this barrier alone could not: a steal committing
 * between here and an RPC already in flight is caught server-side, because the
 * steal cannot commit while the mutation holds the lock.
 *
 * Kept rather than deleted because it is strictly cheaper — one local SELECT
 * rejects a long-displaced predecessor before it makes any RPC at all, instead
 * of letting it round-trip to the host to be refused there.
 *
 * Deliberately a SELECT: it must not touch `updated_at`. That column is what
 * the wedged-fence detector ages off (`phase in ('firing','cancelling') and
 * updated_at < now() - interval '15 minutes'`), so a guard that bumped it
 * would hide from monitoring exactly the fences this ticket exists to surface.
 */
async function assertFiringGeneration(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
  firingToken: string,
): Promise<void> {
  const rows = await ctx.db.query(
    `SELECT 1 FROM ${q(ctx.db.namespace, AGGREGATE_LIFECYCLE_FENCES_TABLE)}
      WHERE company_id = $1
        AND aggregate_key = $2
        AND phase = 'firing'
        AND firing_token = $3`,
    [companyId, aggregateKey, firingToken],
  );
  if (rows.length === 0) throw new AggregateGenerationLostError(aggregateKey);
}

/**
 * Attach a member to the aggregate, but only while the caller still holds the
 * firing fence under `firingToken`.
 *
 * This guard is what makes the ownership steal in `beginAggregateFiring` safe
 * *without* relying on the predecessor being dead. `firing_token` is a fresh
 * UUID minted on every claim and replaced on every steal, so it is already a
 * per-claim generation in the fencing-token sense: a process that has been
 * displaced — by a steal, by the startup sweep, or by its own `finally` — can
 * no longer satisfy this predicate, and therefore cannot attach a member behind
 * a newer owner's back.
 *
 * That matters because same-slot/different-instance is strong evidence of
 * death, not proof of it: Kubernetes' at-most-one guarantee for a StatefulSet
 * ordinal is suspended by force deletion, and by `podManagementPolicy:
 * Parallel`. Rather than rest the fence's safety on that assumption holding,
 * the mutation the fence exists to protect is gated on the generation directly.
 * An overlapping predecessor loses the race deterministically instead of
 * silently attaching a live member to an aggregate a resolver has begun to
 * cancel — the race the design comment in `beginAggregateFiring` refuses to
 * reopen.
 *
 * The guard and the write are one statement, so they are evaluated against a
 * single committed snapshot: a concurrent steal either commits first (this
 * write is refused) or after (this write already landed, and the steal's new
 * owner sees it). There is no check-then-act window between them.
 *
 * Refusal throws rather than returning silently: the delivery must fail so
 * Alertmanager retries against whichever owner now holds the fence.
 */
async function upsertAggregateMember(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
  issueId: string,
  fingerprint: string,
  firingToken: string,
): Promise<void> {
  const ns = ctx.db.namespace;
  const result = await ctx.db.execute(
    `INSERT INTO ${q(ns, AGGREGATE_MEMBERS_TABLE)}
       (company_id, aggregate_key, fingerprint, issue_id)
     SELECT $1, $2, $3, $4
     WHERE EXISTS (
       SELECT 1 FROM ${q(ns, AGGREGATE_LIFECYCLE_FENCES_TABLE)}
        WHERE company_id = $1
          AND aggregate_key = $2
          AND phase = 'firing'
          AND firing_token = $5
     )
     ON CONFLICT (company_id, aggregate_key, fingerprint)
     DO UPDATE SET
       issue_id = EXCLUDED.issue_id,
       resolved_at = NULL,
       updated_at = now()`,
    [companyId, aggregateKey, fingerprint, issueId, firingToken],
  );
  if (result.rowCount === 0) {
    throw new Error(
      `Alertmanager aggregate ${aggregateKey} was reclaimed by another owner ` +
        `while this firing delivery was in flight; refusing to attach member ` +
        `${fingerprint} behind the current fence holder. Failing the delivery so ` +
        `Alertmanager retries against the owner that now holds the fence.`,
    );
  }
}

/**
 * Firing claims the aggregate fence before it mutates member state or touches
 * the issue. A resolver may only begin finalization while the fence is active;
 * once it is cancelling, a new firing fails its delivery and retries after the
 * terminal transition instead of attaching a live member to a cancelled issue.
 */
async function beginAggregateFiring(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
): Promise<AggregateFiringClaim> {
  const ns = ctx.db.namespace;
  const token = randomUUID();
  const fences = q(ns, AGGREGATE_LIFECYCLE_FENCES_TABLE);
  // This is intentionally a fence rather than a lease. A delayed worker can
  // resume after an arbitrary timeout, so stealing `firing` or `cancelling`
  // on the strength of *elapsed time* would allow it to attach a member after a
  // newer resolver has started the terminal transition. That race stays closed:
  // nothing below releases a fence because it is old.
  //
  // What is admitted (BLO-31036) is a fence held by a different process in this
  // same slot. A slot's previous occupant has ordinarily been replaced, because
  // a StatefulSet recreates an ordinal only after the prior pod terminated — but
  // that is strong evidence of death, NOT proof of it. Kubernetes suspends the
  // at-most-one guarantee under force deletion (`--grace-period=0`) and under
  // `podManagementPolicy: Parallel`, and a partitioned node can leave an old
  // process running and able to do work while its replacement starts.
  //
  // So the steal is deliberately NOT load-bearing for safety. `firing_token` is
  // a fresh UUID per claim, replaced on every steal, i.e. a generation in the
  // fencing-token sense — and `upsertAggregateMember` and `finishAggregateFiring`
  // both gate on it. An overlapping predecessor that loses this race can no
  // longer attach a member or complete its delivery; its write is refused and
  // the delivery fails loudly for Alertmanager to retry. Correctness therefore
  // rests on the generation check at the mutation site, and this predicate only
  // decides who is allowed to *proceed*, not whose writes count.
  //
  // A live sibling delivery in *this* process shares WORKER_INSTANCE_ID and is
  // therefore excluded, as is any owner in another slot.
  const result = await ctx.db.execute(
    `INSERT INTO ${fences}
       (company_id, aggregate_key, phase, firing_token, owner_instance_id, owner_slot)
     VALUES ($1, $2, 'firing', $3, $4, $5)
     ON CONFLICT (company_id, aggregate_key) DO UPDATE
     SET phase = 'firing',
         firing_token = EXCLUDED.firing_token,
         resolution_token = NULL,
         owner_instance_id = EXCLUDED.owner_instance_id,
         owner_slot = EXCLUDED.owner_slot,
         updated_at = now()
     WHERE ${fences}.phase IN ('active', 'finalizing')
        OR (
          ${fences}.phase IN ('firing', 'cancelling')
          AND ${fences}.owner_slot = $5
          AND ${fences}.owner_instance_id IS DISTINCT FROM $4
        )`,
    [companyId, aggregateKey, token, WORKER_INSTANCE_ID, WORKER_SLOT],
  );
  if (result.rowCount > 0) return { ok: true, token };
  // Read back the phase that actually refused the claim. The upsert admits
  // 'active' and 'finalizing', so the blocker is necessarily 'firing' or
  // 'cancelling' — an interrupted owner, not a live finalization. Naming it is
  // what makes the wedge diagnosable from the delivery error alone; reporting a
  // fixed phase here sent a six-day production investigation (PEN-2581) after
  // `finalizing`, which is the one phase that cannot produce this failure.
  const rows = await ctx.db.query<{ phase: string }>(
    `SELECT phase
       FROM ${fences}
      WHERE company_id = $1
        AND aggregate_key = $2`,
    [companyId, aggregateKey],
  );
  return { ok: false, blockingPhase: rows[0]?.phase ?? null };
}

/**
 * Release fences abandoned by a previous occupant of this slot (BLO-31036).
 *
 * Runs once per worker process, from `setup()`. The per-claim steal in
 * `beginAggregateFiring` already unwedges any aggregate that keeps firing, but
 * that is not sufficient on its own: an aggregate whose alert has since stopped
 * firing receives no further delivery, so nothing would ever reclaim it and the
 * row would sit in `firing` forever. This sweep is what makes "no fence stays
 * held after the owner dies" an invariant rather than a property of alerts that
 * happen to repeat.
 *
 * Release is justified by identity, never by age:
 *   - `owner_instance_id IS DISTINCT FROM` this process — never touches a fence
 *     held by a live sibling delivery in this same process. A delivery can
 *     arrive while setup is still running, so this exclusion is load-bearing.
 *   - same `owner_slot`, or NULL. NULL means the row was written before this
 *     column existed, i.e. by a strictly older image, which the running process
 *     has by definition replaced.
 *
 * Deliberately non-fatal: a failed sweep leaves fences wedged, which the
 * per-claim steal can still recover. Throwing here would prevent the worker
 * from starting at all and turn a partial outage into a total one.
 */
export async function reconcileAbandonedAggregateFences(
  ctx: PluginContext,
): Promise<number> {
  try {
    const fences = q(ctx.db.namespace, AGGREGATE_LIFECYCLE_FENCES_TABLE);
    const result = await ctx.db.execute(
      `UPDATE ${fences}
       SET phase = 'active',
           firing_token = NULL,
           resolution_token = NULL,
           owner_instance_id = NULL,
           owner_slot = NULL,
           updated_at = now()
       WHERE phase IN ('firing', 'cancelling')
         AND owner_instance_id IS DISTINCT FROM $1
         AND (owner_slot IS NULL OR owner_slot = $2)`,
      [WORKER_INSTANCE_ID, WORKER_SLOT],
    );
    if (result.rowCount > 0) {
      ctx.logger.warn(
        `paperclip-plugin-alertmanager: released ${result.rowCount} aggregate lifecycle fence(s) ` +
          `abandoned by a previous occupant of slot ${WORKER_SLOT}. Each of these was refusing ` +
          `every firing delivery for its aggregate until now.`,
      );
    }
    return result.rowCount;
  } catch (err) {
    ctx.logger.error(
      `paperclip-plugin-alertmanager: aggregate lifecycle fence reconciliation failed: ${String(err)}. ` +
        `Aggregates abandoned by a previous process stay wedged until their next firing delivery reclaims them.`,
    );
    return 0;
  }
}

async function finishAggregateFiring(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
  token: string,
): Promise<void> {
  const ns = ctx.db.namespace;
  const result = await ctx.db.execute(
    `UPDATE ${q(ns, AGGREGATE_LIFECYCLE_FENCES_TABLE)}
     SET phase = 'active',
         firing_token = NULL,
         owner_instance_id = NULL,
         owner_slot = NULL,
         updated_at = now()
     WHERE company_id = $1
       AND aggregate_key = $2
       AND phase = 'firing'
       AND firing_token = $3`,
    [companyId, aggregateKey, token],
  );
  if (result.rowCount === 0) {
    throw new Error(
      `Alertmanager aggregate firing fence was lost for ${aggregateKey}; retrying delivery`,
    );
  }
}

/**
 * Recover only the exact fence named by an operator. This deliberately has no
 * age check and never replaces a token: an interrupted delivery can be released
 * only by a principal that has the token from that delivery.
 *
 * Both phases that refuse a firing claim are recoverable here. `cancelling` is
 * included because a resolver that dies between `beginAggregateCancellation`
 * and `releaseAggregateFinalization` leaves the fence held by a token no live
 * process has, which permanently wedges every later firing for that aggregate.
 * The transition it performs is the same `cancelling` -> `active` release the
 * withheld-cancellation path already takes, so it introduces no new state.
 *
 * `token` is therefore a firing token or a resolution token depending on which
 * phase holds the fence. The operator-facing request field is still named
 * `firingToken` because that is the published wire contract; the listing route
 * reports `phase` so the caller knows which one they are holding.
 */
export async function recoverAggregateFiring(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
  token: string,
): Promise<boolean> {
  const fences = q(ctx.db.namespace, AGGREGATE_LIFECYCLE_FENCES_TABLE);
  const result = await ctx.db.execute(
    `UPDATE ${fences}
     SET phase = 'active',
         firing_token = NULL,
         owner_instance_id = NULL,
         owner_slot = NULL,
         updated_at = now()
     WHERE company_id = $1
       AND aggregate_key = $2
       AND phase = 'firing'
       AND firing_token = $3`,
    [companyId, aggregateKey, token],
  );
  if (result.rowCount > 0) return true;
  // Same compare-and-set discipline on the resolution token: a stale or wrong
  // token releases nothing, so this cannot reopen a fence owned by a newer
  // resolver.
  const cancelling = await ctx.db.execute(
    `UPDATE ${fences}
     SET phase = 'active',
         resolution_token = NULL,
         owner_instance_id = NULL,
         owner_slot = NULL,
         updated_at = now()
     WHERE company_id = $1
       AND aggregate_key = $2
       AND phase = 'cancelling'
       AND resolution_token = $3`,
    [companyId, aggregateKey, token],
  );
  return cancelling.rowCount > 0;
}

async function tryClaimAggregateFinalization(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
  issueId: string,
): Promise<string | null> {
  const ns = ctx.db.namespace;
  const fences = q(ns, AGGREGATE_LIFECYCLE_FENCES_TABLE);
  const members = q(ns, AGGREGATE_MEMBERS_TABLE);
  const token = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${fences} (company_id, aggregate_key)
     VALUES ($1, $2)
     ON CONFLICT (company_id, aggregate_key) DO NOTHING`,
    [companyId, aggregateKey],
  );
  const result = await ctx.db.execute(
    `UPDATE ${fences}
     SET phase = 'finalizing',
         firing_token = NULL,
         resolution_token = $4,
         owner_instance_id = $5,
         owner_slot = $6,
         updated_at = now()
     WHERE company_id = $1
       AND aggregate_key = $2
       AND phase = 'active'
       AND NOT EXISTS (
         SELECT 1
         FROM ${members}
         WHERE company_id = $1
           AND aggregate_key = $2
           AND issue_id = $3
           AND resolved_at IS NULL
       )`,
    [
      companyId,
      aggregateKey,
      issueId,
      token,
      WORKER_INSTANCE_ID,
      WORKER_SLOT,
    ],
  );
  return result.rowCount > 0 ? token : null;
}

async function beginAggregateCancellation(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
  token: string,
): Promise<boolean> {
  const ns = ctx.db.namespace;
  // Re-stamp ownership as this process enters `cancelling`. Without it the
  // fence would carry whatever identity claimed finalization, and a concurrent
  // firing in this same process could then read the owner as "not me" and steal
  // a terminal transition that is genuinely live — reintroducing exactly the
  // race the fence exists to prevent (BLO-31036).
  const result = await ctx.db.execute(
    `UPDATE ${q(ns, AGGREGATE_LIFECYCLE_FENCES_TABLE)}
     SET phase = 'cancelling',
         owner_instance_id = $4,
         owner_slot = $5,
         updated_at = now()
     WHERE company_id = $1
       AND aggregate_key = $2
       AND phase = 'finalizing'
       AND resolution_token = $3`,
    [companyId, aggregateKey, token, WORKER_INSTANCE_ID, WORKER_SLOT],
  );
  return result.rowCount > 0;
}

async function releaseAggregateFinalization(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
  token: string,
): Promise<void> {
  const ns = ctx.db.namespace;
  await ctx.db.execute(
    `UPDATE ${q(ns, AGGREGATE_LIFECYCLE_FENCES_TABLE)}
     SET phase = 'active',
         resolution_token = NULL,
         owner_instance_id = NULL,
         owner_slot = NULL,
         updated_at = now()
     WHERE company_id = $1
       AND aggregate_key = $2
       AND phase = 'cancelling'
       AND resolution_token = $3`,
    [companyId, aggregateKey, token],
  );
}

async function resolveAggregateMember(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
  issueId: string,
  fingerprint: string,
  claimFinalization: boolean,
): Promise<AggregateMemberResolution> {
  const ns = ctx.db.namespace;
  // Read the membership and mark it resolved as two statements, not one
  // `UPDATE ... RETURNING`. `ctx.db.query` is SELECT-only and `ctx.db.execute`
  // reports only a row count, so there is no host call that both writes and
  // returns a column; issuing the `UPDATE ... RETURNING` through `ctx.db.query`
  // is rejected with "ctx.db.query only allows SELECT statements", which threw
  // on every resolve delivery for an aggregate-tracked fingerprint and 502'd the
  // whole batch (BLO-31035).
  //
  // The split is exact rather than approximate here: both statements are keyed
  // on the members primary key (company_id, aggregate_key, fingerprint), so the
  // read matches at most the single row the write targets. Nothing deletes
  // member rows, so the row cannot vanish between the two, and the write is
  // idempotent (`COALESCE(resolved_at, now())`), so a concurrent delivery that
  // resolves the same member in between lands on the same terminal state and
  // keeps the earlier `resolved_at`.
  const [member] = await ctx.db.query<{ issue_id: string }>(
    `SELECT issue_id
     FROM ${q(ns, AGGREGATE_MEMBERS_TABLE)}
     WHERE company_id = $1 AND aggregate_key = $2 AND fingerprint = $3`,
    [companyId, aggregateKey, fingerprint],
  );
  const resolvedIssueId = member?.issue_id ?? issueId;
  if (!member) {
    return { disposition: "no-membership", issueId: resolvedIssueId };
  }
  await ctx.db.execute(
    `UPDATE ${q(ns, AGGREGATE_MEMBERS_TABLE)}
     SET resolved_at = COALESCE(resolved_at, now()),
         updated_at = now()
     WHERE company_id = $1 AND aggregate_key = $2 AND fingerprint = $3`,
    [companyId, aggregateKey, fingerprint],
  );

  const unresolved = await ctx.db.query<{ one: number }>(
    `SELECT 1 AS one
     FROM ${q(ns, AGGREGATE_MEMBERS_TABLE)}
     WHERE company_id = $1
       AND aggregate_key = $2
       AND issue_id = $3
       AND resolved_at IS NULL
     LIMIT 1`,
    [companyId, aggregateKey, resolvedIssueId],
  );
  if (unresolved.length > 0) {
    return { disposition: "has-unresolved-siblings", issueId: resolvedIssueId };
  }
  if (!claimFinalization) {
    return { disposition: "last-member-resolved", issueId: resolvedIssueId };
  }
  const resolutionToken = await tryClaimAggregateFinalization(
    ctx,
    companyId,
    aggregateKey,
    resolvedIssueId,
  );
  return resolutionToken
    ? {
        disposition: "last-member-resolved",
        issueId: resolvedIssueId,
        resolutionToken,
      }
    : { disposition: "finalization-pending", issueId: resolvedIssueId };
}

async function findAggregateMemberKey(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  fingerprint: string,
): Promise<string | null> {
  const ns = ctx.db.namespace;
  const [member] = await ctx.db.query<{ aggregate_key: string }>(
    `SELECT aggregate_key
     FROM ${q(ns, AGGREGATE_MEMBERS_TABLE)}
     WHERE company_id = $1
       AND issue_id = $2
       AND fingerprint = $3
     ORDER BY updated_at DESC
     LIMIT 1`,
    [companyId, issueId, fingerprint],
  );
  return member?.aggregate_key ?? null;
}

async function recoverStateFromAggregateMember(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  alert: AlertmanagerAlert,
): Promise<AlertStateRecord | null> {
  const companyId = config.defaultCompanyId;
  if (!companyId) return null;
  const ns = ctx.db.namespace;
  const [member] = await ctx.db.query<{ issue_id: string; aggregate_key: string }>(
    `SELECT issue_id, aggregate_key
     FROM ${q(ns, AGGREGATE_MEMBERS_TABLE)}
     WHERE company_id = $1
       AND fingerprint = $2
       AND resolved_at IS NULL
     ORDER BY updated_at DESC
     LIMIT 1`,
    [companyId, alert.fingerprint],
  );
  if (!member) return null;
  const issue = await ctx.issues.get(member.issue_id, companyId);
  if (!issue || issue.status === "done" || issue.status === "cancelled") {
    return null;
  }
  return buildRecoveredStateRecord(companyId, issue, alert, config, member.aggregate_key);
}

function rebindAlertState(
  record: AlertStateRecord,
  issue: IssueReference,
): AlertStateRecord {
  return {
    ...record,
    paperclipIssueId: issue.id,
    assigneeUserId: issue.assigneeUserId ?? record.assigneeUserId ?? null,
    assigneeAgentId: issue.assigneeAgentId ?? record.assigneeAgentId ?? null,
  };
}

function isAggregateCreationConflict(err: unknown): boolean {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string"
        ? (err as { message: string }).message
        : String(err);
  return message.includes("Alertmanager aggregate creation conflict");
}

function nonEmptyString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Verify `Authorization: Bearer <token>` against the configured token.
 * Constant-time comparison; rejects on missing token, missing header,
 * length mismatch.
 */
export function verifyBearerToken(
  headers: Record<string, string | string[]>,
  expectedToken: string | null,
): boolean {
  if (!expectedToken) return false;
  const raw =
    pickHeader(headers, "authorization") ??
    pickHeader(headers, "Authorization");
  if (!raw) return false;
  const expected = `Bearer ${expectedToken}`;
  if (raw.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(raw), Buffer.from(expected));
}

/**
 * Largest bearer credential worth sending to the host for verification.
 *
 * Mirrors the host's own `MAX_PRESENTED_SECRET_BYTES`
 * (`server/src/services/plugin-secrets-handler.ts`). Anything larger is
 * rejected there as `presented_secret_invalid` — an error, not a `false` — so
 * without this cap an oversized `Authorization` header turns a plainly-wrong
 * credential into a failed delivery that Alertmanager then retries. No secret
 * budget is spent either way (the host checks size before any database work),
 * but the retry volume and error rate are anonymous-triggerable, so reject the
 * over-long credential here and answer 401 instead.
 */
const MAX_BEARER_CREDENTIAL_BYTES = 4_096;

export function readBearerCredential(
  headers: Record<string, string | string[]>,
): string | null {
  const raw =
    pickHeader(headers, "authorization") ??
    pickHeader(headers, "Authorization");
  if (!raw?.startsWith("Bearer ")) return null;
  const credential = raw.slice("Bearer ".length);
  if (credential.length === 0) return null;
  // Byte length, matching how the host measures it — a multi-byte UTF-8
  // credential inside the character limit can still exceed the byte limit.
  if (Buffer.byteLength(credential, "utf8") > MAX_BEARER_CREDENTIAL_BYTES) return null;
  return credential;
}

function pickHeader(
  headers: Record<string, string | string[]>,
  name: string,
): string | undefined {
  const value = headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return undefined;
}

/**
 * Type-guard that an unknown body matches the AM v2 envelope shape.
 * Doesn't validate every label/annotation entry — Alertmanager always
 * sends strings and rejecting on a stray non-string value would be fragile.
 */
export function isAlertmanagerPayload(
  body: unknown,
): body is AlertmanagerWebhookPayload {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.version !== "string") return false;
  if (typeof b.status !== "string") return false;
  if (!Array.isArray(b.alerts)) return false;
  for (const alert of b.alerts) {
    if (!alert || typeof alert !== "object") return false;
    const a = alert as Record<string, unknown>;
    if (typeof a.status !== "string") return false;
    if (typeof a.fingerprint !== "string") return false;
    if (typeof a.startsAt !== "string") return false;
    if (typeof a.endsAt !== "string") return false;
    if (!a.labels || typeof a.labels !== "object") return false;
    if (!a.annotations || typeof a.annotations !== "object") return false;
  }
  return true;
}

/**
 * Read a fingerprint's dedup row from its owning company's scope, migrating a
 * pre-BLO-20467 instance-scoped row on first sight.
 *
 * The migration is gated on `paperclipCompanyId`: a legacy row is adopted only
 * by the company whose issue it actually tracks. A row belonging to another
 * tenant is ignored (and left in place), which is precisely the cross-tenant
 * reuse this change exists to stop. Without the read-through, every alert
 * firing at upgrade time would look new — duplicating live issues and orphaning
 * the originals so their resolution could never close them.
 */
async function readAlertState(
  ctx: PluginContext,
  companyId: string,
  fingerprint: string,
): Promise<{ ref: ReturnType<typeof alertStateRef>; record: AlertStateRecord | null }> {
  const ref = alertStateRef(companyId, fingerprint);
  const scoped = (await ctx.state.get(ref)) as AlertStateRecord | null;
  if (scoped) return { ref, record: scoped };

  const legacyRef = legacyInstanceAlertStateRef(fingerprint);
  const legacy = (await ctx.state.get(legacyRef)) as AlertStateRecord | null;
  if (legacy && legacy.paperclipCompanyId === companyId) {
    await ctx.state.set(ref, legacy);
    try {
      await ctx.state.delete(legacyRef);
    } catch (err) {
      // The scoped copy is already durable, so the migration has taken effect;
      // a stale legacy row is inert (only this company could ever adopt it, and
      // it will never be read again now that the scoped row exists).
      ctx.logger.warn(
        `paperclip-plugin-alertmanager: migrated alert ${fingerprint} to company scope but could not remove the legacy row: ${String(err)}`,
      );
    }
    return { ref, record: legacy };
  }
  return { ref, record: null };
}

/**
 * Milliseconds an operator-closed issue suppresses re-fires, or `null` for
 * "suppress indefinitely" (`operatorSuppressionHours: 0`, the pre-BLO-24234
 * behaviour). A negative or non-finite setting is treated as unset rather than
 * silently disabling suppression in either direction, and an over-large one is
 * clamped to `MAX_OPERATOR_SUPPRESSION_HOURS` so the millisecond conversion
 * cannot overflow to `Infinity` (or to a finite-but-geological window) and
 * re-create the unbounded mute. The clamped value is what the operator-facing
 * labels report, so a clamped config shows up as the window it actually got.
 */
function operatorSuppressionMs(config: AlertmanagerPluginConfig): number | null {
  const hours = config.operatorSuppressionHours;
  const effective =
    typeof hours === "number" && Number.isFinite(hours) && hours >= 0
      ? Math.min(hours, MAX_OPERATOR_SUPPRESSION_HOURS)
      : DEFAULT_OPERATOR_SUPPRESSION_HOURS;
  return effective === 0 ? null : effective * 60 * 60 * 1000;
}

/**
 * Did the *plugin* author this issue's current terminal status, or did a human
 * or an agent? (BLO-31736)
 *
 * This used to be inferred from `existing.resolvedAt`, which does not record
 * authorship — it records only that the alert last cleared. The two diverge on
 * exactly the case the terminal guard in `handleResolved` exists to protect: an
 * agent closes the row `done`, the alert then resolves, the guard correctly
 * declines to overwrite the close, and `resolvedAt` is written anyway. The next
 * re-fire read that as "the plugin closed this" and resurrected the row to
 * `todo`; the resolve after it then found a non-terminal row and cancelled it.
 * A deliberate `done` became a plugin-authored `cancelled`, once per fire/clear
 * cycle, indefinitely — and BLO-24234's operator suppression was unreachable
 * for any alert that had ever resolved, which is every flapping alert, i.e.
 * precisely the ones operators close by hand.
 *
 * Two signals, in precedence order:
 *
 * 1. **`done` is never a close of ours.** The plugin's only status writes are
 *    `todo` (fire, re-open) and `cancelled` (resolve) — it has no path that
 *    closes an issue `done`, so a `done` row was dispositioned by someone
 *    else whatever the state says. (An `issueRouteMap` entry could in
 *    principle *create* a row `done`; that is still not a close on resolve,
 *    and re-opening such a row on re-fire would be wrong for the same
 *    reason.) This signal holds for rows written before `pluginClosedAt`
 *    existed too, which is what makes the reported defect fixed on contact
 *    rather than one migration cycle later.
 * 2. **`pluginClosedAt` is the recorded fact** for anything else: set when a
 *    resolve delivery's cancel actually landed, `null` when we positively know
 *    it did not.
 *
 * `undefined` means authorship is unknown for this row. Two sources: the row
 * predates the field, or it is a member of an aggregate whose close decision
 * this member deferred to a sibling (see `handleResolved`). We fall back to the
 * old `resolvedAt` reading rather than assuming an operator close, because the
 * two errors are not symmetric: reading a plugin close as operator-authored
 * *mutes a live recurring alert* for the suppression window, while reading an
 * operator close as plugin-authored costs one unwanted re-open that the very
 * next firing state-write corrects. Silence is the worse failure. Legacy rows
 * drain on their first post-deploy firing, which writes the field explicitly.
 */
export function closedByPlugin(
  issue: { status: string },
  existing: Pick<AlertStateRecord, "resolvedAt" | "pluginClosedAt">,
): boolean {
  if (issue.status === "done") return false;
  if (existing.pluginClosedAt !== undefined) return existing.pluginClosedAt !== null;
  return Boolean(existing.resolvedAt);
}

/**
 * Decide what a re-fire should do to an issue that already exists for this
 * fingerprint. Split out from `handleFiring` so the four decision points the
 * incident review asked for are enumerable in one place, and testable without
 * driving a whole webhook delivery.
 *
 * A terminal issue the plugin closed when the alert cleared means a re-fire is
 * a genuine recurrence → re-open. A terminal issue closed by anyone else means
 * a human or an agent dispositioned it while the alert was still firing →
 * honour that, but only until the suppression window expires (BLO-24234). See
 * `closedByPlugin` for why that distinction cannot be read off `resolvedAt`.
 */
type RefireDecision =
  | { kind: "refresh" }
  | { kind: "reopen"; reason: "plugin_resolved" | "suppression_expired" }
  | { kind: "suppressed"; suppressedAt: string; firstObservation: boolean }
  | { kind: "issue_missing" };

export function decideRefire(
  issue: { status: string } | null | undefined,
  existing: Pick<
    AlertStateRecord,
    "resolvedAt" | "operatorSuppressedAt" | "pluginClosedAt"
  >,
  config: AlertmanagerPluginConfig,
  nowMs: number,
): RefireDecision {
  if (!issue) return { kind: "issue_missing" };

  const terminal = issue.status === "done" || issue.status === "cancelled";
  if (!terminal) return { kind: "refresh" };
  if (closedByPlugin(issue, existing)) {
    return { kind: "reopen", reason: "plugin_resolved" };
  }

  // Operator-closed. Anchor the window on the first re-fire we see against the
  // closed issue — not on the close itself, which the plugin never observes.
  const suppressedAt = existing.operatorSuppressedAt ?? new Date(nowMs).toISOString();
  const firstObservation = !existing.operatorSuppressedAt;
  const windowMs = operatorSuppressionMs(config);
  if (windowMs === null) return { kind: "suppressed", suppressedAt, firstObservation };

  const anchorMs = Date.parse(suppressedAt);
  // An unparseable anchor (hand-edited or corrupted state row) must not mute the
  // alert forever — re-anchor to now and keep suppressing for one more window.
  if (!Number.isFinite(anchorMs)) {
    return {
      kind: "suppressed",
      suppressedAt: new Date(nowMs).toISOString(),
      firstObservation: true,
    };
  }
  if (nowMs - anchorMs >= windowMs) {
    return { kind: "reopen", reason: "suppression_expired" };
  }
  return { kind: "suppressed", suppressedAt, firstObservation };
}

/**
 * Human-readable suppression window for log lines and the re-open comment.
 */
function operatorSuppressionHoursLabel(config: AlertmanagerPluginConfig): string {
  const ms = operatorSuppressionMs(config);
  if (ms === null) return "indefinite";
  return `${ms / (60 * 60 * 1000)}h`;
}

/** When the current suppression window runs out, for operator-facing logs. */
function suppressionExpiryLabel(
  suppressedAt: string,
  config: AlertmanagerPluginConfig,
): string {
  const ms = operatorSuppressionMs(config);
  if (ms === null) return "never (operatorSuppressionHours=0)";
  const anchorMs = Date.parse(suppressedAt);
  if (!Number.isFinite(anchorMs)) return "unknown (unparseable suppression anchor)";
  return new Date(anchorMs + ms).toISOString();
}

/**
 * Per-delivery memo for the named-fallback owner lookup.
 *
 * `resolveFallbackAgentId` is one unwindowed `ctx.agents.list({ companyId })`,
 * and that call is not cheap on the host side: `server/src/services/agents.ts`
 * issues two full-table selects for the company (the filtered rows plus the org
 * chain) and then `hydrateAgentSpend`, which aggregates `costEvents` for the
 * current month. The fallback rung is also the *common* path — by BLO-20576's
 * own numbers most firing alerts resolve to no owner — so without a memo every
 * alert in a batch pays it, and a storm is exactly when the batch is largest
 * and the host is busiest.
 *
 * The resolution is constant for a given `(companyId, fallbackAgentName)`
 * within a single `handleWebhook` call, so caching it there collapses N host
 * round-trips to one without changing any semantics. Scoping the memo to the
 * delivery (rather than the module) is what keeps it correct: a config edit or
 * an agent being paused takes effect on the very next delivery.
 */
export type FallbackOwnerMemo = Map<string, Promise<string | undefined>>;

function resolveFallbackAgentIdMemoized(
  ctx: Pick<PluginContext, "agents" | "logger">,
  companyId: string,
  fallbackAgentName: string | undefined,
  memo: FallbackOwnerMemo | undefined,
): Promise<string | undefined> {
  if (!memo) return resolveFallbackAgentId(ctx, companyId, fallbackAgentName);
  // JSON-encoded pair rather than a naive `a + sep + b`: agent names are
  // operator-supplied config, so any single-character separator could be
  // embedded in a name to collide with another company's key.
  const key = JSON.stringify([companyId, fallbackAgentName ?? ""]);
  const cached = memo.get(key);
  if (cached) return cached;
  const pending = resolveFallbackAgentId(
    ctx,
    companyId,
    fallbackAgentName,
  ).catch((err: unknown) => {
    // Evict on failure. A refusal (bad name / paused / ambiguous) resolves to
    // `undefined` and IS cached — it is a config fact, stable for the delivery.
    // A *throw* is a transient host fault, and caching it would let one failed
    // `agents.list` poison every remaining alert in the batch, converting a
    // blip that previously cost one alert into a whole-delivery failure.
    memo.delete(key);
    throw err;
  });
  memo.set(key, pending);
  return pending;
}

/**
 * §8.1 — first time we see a fingerprint, create an issue. On re-fire, just
 * bump `lastFiredAt` and re-emit the firing event. On re-fire after a manual
 * close, re-open the existing issue (§8.3 option A).
 */
export async function handleFiring(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  alert: AlertmanagerAlert,
  fallbackOwnerMemo?: FallbackOwnerMemo,
): Promise<void> {
  // Resolved up front because it now scopes the state read, not just issue
  // creation. Without it there is no namespace to look in, so a delivery that
  // could not have created an issue anyway is dropped here instead of after a
  // guaranteed-miss lookup.
  const companyId = config.defaultCompanyId;
  if (!companyId) {
    ctx.logger.warn(
      `Cannot track alert ${alert.fingerprint}: defaultCompanyId not configured`,
    );
    return;
  }
  const { ref: stateRef, record: stateRecord } = await readAlertState(
    ctx,
    companyId,
    alert.fingerprint,
  );
  // BLO-20467: `issues.create` below commits before its `state.set`, so a
  // state-store failure in between leaves a real issue with no state row. That
  // delivery now fails (rather than being acknowledged), so Alertmanager
  // retries it — and a retry that trusted the state miss would file a *second*
  // issue for the same fingerprint, turning a repeating state-store outage into
  // a duplicate-issue storm. Reconciling against the issue the previous attempt
  // already created is what makes the retry idempotent.
  //
  // This is the same `state ?? recover-from-issue` fallback the resolved path
  // has always used; only the firing path was missing it.
  const existing = stateRecord ?? (await recoverStateFromIssue(ctx, config, alert));
  const nowIso = new Date().toISOString();
  const alertname = alert.labels.alertname ?? "UnnamedAlert";
  const severity = alert.labels.severity ?? "unknown";
  const storedAggregateKey = existing
    ? (existing.aggregateKey ??
      (await findAggregateMemberKey(
        ctx,
        existing.paperclipCompanyId,
        existing.paperclipIssueId,
        alert.fingerprint,
      )))
    : null;
  const aggregateKey = storedAggregateKey ?? aggregateKeyForAlert(alert);

  if (!existing && (alert.labels.severity ?? "").trim().toLowerCase() === "info") {
    ctx.logger.info(
      `Alertmanager: ${alertname} is below the issue creation floor (severity=info)`,
    );
    try {
      await ctx.metrics.write("alertmanager.webhook.below_issue_floor", 1, {
        alertname,
        severity: "info",
      });
    } catch (metricErr) {
      ctx.logger.error(
        `paperclip-plugin-alertmanager: failed to record issue floor metric for ${alert.fingerprint}: ${String(metricErr)}`,
      );
    }
    return;
  }

  const firingClaim = await beginAggregateFiring(ctx, companyId, aggregateKey);
  if (!firingClaim.ok) {
    throw new Error(
      `Alertmanager aggregate ${aggregateKey} is held in phase ` +
        `'${firingClaim.blockingPhase ?? "unknown"}' by a delivery in progress; ` +
        `retrying firing delivery. A fence abandoned by a dead process is released ` +
        `automatically by its slot's next worker; if this persists, the holder is ` +
        `either live or in another slot, and an operator can release it via the ` +
        `plugin's recover-aggregate-firing route.`,
    );
  }
  const firingToken = firingClaim.token;

  try {
    if (existing && existing.paperclipIssueId) {
      // Re-fire: refresh body (drill-in URLs may carry a fresh time range) and
      // re-open if the plugin previously auto-cancelled it on resolve, or if an
      // operator's close has aged past the suppression window (BLO-24234).
      let tracked = existing;
      const newDescription = buildIssueDescription(alert);
      // Carried out of the try so the state write below records what actually
      // happened. A decision the RPC then failed to apply must not be persisted
      // as applied — otherwise a transient issues.update outage would bank the
      // suppression anchor (or clear it) on the strength of a call that never
      // landed, and the next re-fire would reason from a fiction.
      let decision: RefireDecision = { kind: "issue_missing" };
      let decisionApplied = false;
      try {
        const issue = await ctx.issues.get(
          existing.paperclipIssueId,
          existing.paperclipCompanyId,
        );
        decision = decideRefire(issue, existing, config, Date.now());

        // Barrier before the first issue mutation. Placed *after* the reads
        // above so the window between proving ownership and acting on it holds
        // no RPC of our own: everything from here to `upsertAggregateMember` is
        // a write, and a predecessor displaced before this point performs none
        // of them. The reads are unguarded on purpose — they mutate nothing.
        await assertFiringGeneration(ctx, companyId, aggregateKey, firingToken);

        if (decision.kind === "reopen") {
          if (decision.reason === "plugin_resolved") {
            // A different firing in this aggregate may already have created a
            // live winner while this fingerprint was resolved. Rebind to that
            // winner before reopening the terminal issue, which avoids
            // resurrecting a cancelled aggregate member.
            const activeAggregateIssue = await findActiveAggregateIssue(
              ctx,
              existing.paperclipCompanyId,
              aggregateKey,
            );
            if (
              activeAggregateIssue &&
              activeAggregateIssue.id !== existing.paperclipIssueId
            ) {
              tracked = rebindAlertState(existing, activeAggregateIssue);
              await ctx.issues.update(
                activeAggregateIssue.id,
                { description: newDescription },
                existing.paperclipCompanyId,
                undefined,
                { fencing: firingFence(companyId, aggregateKey, firingToken) },
              );
              await ctx.metrics.write("alertmanager.aggregate.rebound", 1, {
                alertname,
                severity,
              });
            } else {
              try {
                await ctx.issues.update(
                  existing.paperclipIssueId,
                  { status: "todo", description: newDescription },
                  existing.paperclipCompanyId,
                  undefined,
                  { fencing: firingFence(companyId, aggregateKey, firingToken) },
                );
                await ctx.metrics.write("alertmanager.firing.reopened", 1, {
                  alertname,
                  severity,
                });
              } catch (err) {
                // A competing firing can win the aggregate between the lookup
                // and this update. Re-read the winner before surfacing the
                // original error so the retry follows the active issue.
                const reboundIssue = await findActiveAggregateIssue(
                  ctx,
                  existing.paperclipCompanyId,
                  aggregateKey,
                );
                if (
                  !reboundIssue ||
                  reboundIssue.id === existing.paperclipIssueId
                ) {
                  throw err;
                }
                tracked = rebindAlertState(existing, reboundIssue);
                await ctx.issues.update(
                  reboundIssue.id,
                  { description: newDescription },
                  existing.paperclipCompanyId,
                  undefined,
                  { fencing: firingFence(companyId, aggregateKey, firingToken) },
                );
                await ctx.metrics.write("alertmanager.aggregate.rebound", 1, {
                  alertname,
                  severity,
                });
              }
            }
          } else {
            await ctx.issues.update(
              existing.paperclipIssueId,
              { status: "todo", description: newDescription },
              existing.paperclipCompanyId,
              undefined,
              { fencing: firingFence(companyId, aggregateKey, firingToken) },
            );
            // Say why the close did not stick, on the issue itself — an
            // operator who closed this yesterday needs to know it re-opened
            // because the alert never stopped firing, not because something
            // ignored them.
            try {
              await ctx.issues.createComment(
                existing.paperclipIssueId,
                `Re-opened by paperclip-plugin-alertmanager: this issue was closed by hand, but \`${alertname}\` has kept firing past the ${operatorSuppressionHoursLabel(config)} suppression window. Closing it again will suppress it for another window; silence the alert rule itself if it should stop paging.`,
                existing.paperclipCompanyId,
                { fencing: firingFence(companyId, aggregateKey, firingToken) },
              );
            } catch (commentErr) {
              // The re-open is the load-bearing half and has already landed.
              ctx.logger.warn(
                `Re-opened issue ${existing.paperclipIssueId} after suppression expiry but could not post the explanatory comment: ${String(commentErr)}`,
              );
            }
            await ctx.metrics.write("alertmanager.firing.suppression_expired", 1, {
              alertname,
              severity,
            });
          }
        } else if (decision.kind === "refresh") {
          await ctx.issues.update(
            existing.paperclipIssueId,
            { description: newDescription },
            existing.paperclipCompanyId,
            undefined,
            { fencing: firingFence(companyId, aggregateKey, firingToken) },
          );
        } else if (decision.kind === "suppressed") {
          // The whole point of BLO-24234: this path used to be entirely silent,
          // emitting only `firing.deduped` — indistinguishable from a healthy
          // re-fire against an open issue. A muted fingerprint must be visible
          // as muted, every time it fires, or nobody can tell that a delivered
          // page produced no actionable artifact.
          if (decision.firstObservation) {
            ctx.logger.warn(
              `Alert ${alertname} (${alert.fingerprint}) re-fired against operator-closed issue ${existing.paperclipIssueId}; suppressing re-open until ${suppressionExpiryLabel(decision.suppressedAt, config)}`,
            );
          } else {
            ctx.logger.info(
              `Alert ${alertname} (${alert.fingerprint}) still suppressed by operator close of issue ${existing.paperclipIssueId} (until ${suppressionExpiryLabel(decision.suppressedAt, config)})`,
            );
          }
          await ctx.metrics.write("alertmanager.firing.suppressed", 1, {
            alertname,
            severity,
          });
        } else {
          // `issues.get` returned nothing — the issue was hard-deleted out from
          // under the state row. Previously this fell through both branches in
          // silence; say so, since the fingerprint is now tracking a ghost.
          ctx.logger.warn(
            `Alert ${alertname} (${alert.fingerprint}) re-fired but its tracked issue ${existing.paperclipIssueId} could not be read; leaving state intact`,
          );
          await ctx.metrics.write("alertmanager.firing.issue_missing", 1, {
            alertname,
            severity,
          });
        }
        decisionApplied = true;
      } catch (err) {
        // Losing the generation is not a re-sync failure to be tolerated: this
        // delivery no longer owns the aggregate, so it must not fall through to
        // the state write and event emission below on the strength of a
        // decision it was never entitled to apply.
        if (err instanceof AggregateGenerationLostError) throw err;
        ctx.logger.warn(
          `Failed to re-sync existing issue ${existing.paperclipIssueId} on re-fire: ${String(err)}`,
        );
      }

      // Ladder restart keeps its original trigger — the alert going
      // resolved → firing — which is independent of the issue's status: an
      // operator may have re-opened the issue by hand, in which case the branch
      // above is a plain `refresh` but `handleResolved` has still left
      // `nextEscalationAt` null and `escalationComplete` true. Gating this on
      // the re-open would silently disarm escalation for exactly that case.
      //
      // A suppression-expiry re-open is the one new trigger: the ladder has
      // been frozen for the whole suppression window, so the now-visible issue
      // needs a live deadline or it will never page anyone.
      const suppressionExpiryReopen =
        decisionApplied &&
        decision.kind === "reopen" &&
        decision.reason === "suppression_expired";
      const ladderRestart = Boolean(existing.resolvedAt) || suppressionExpiryReopen;
      // Only a decision we actually applied may move the anchor. `issue_missing`
      // preserves it: the issue was unreadable, so we learned nothing about
      // whether the operator's close still stands, and dropping the anchor would
      // restart the whole window on the next readable re-fire.
      const suppressionAnchor =
        !decisionApplied || decision.kind === "issue_missing"
          ? (existing.operatorSuppressedAt ?? null)
          : decision.kind === "suppressed"
            ? decision.suppressedAt
            : null;
      // BLO-31736: same rule, same reason, for the closure-authorship record.
      // A firing delivery that applied a decision has observed the issue's
      // status first-hand, so whatever close we had recorded is spent — we
      // either re-opened the row or judged the close to be someone else's.
      // Writing `null` there is what makes BLO-24234's suppression reachable
      // on the *next* re-fire for an alert that has resolved before: a later
      // hand-cancel of this row is then read as the operator close it is,
      // rather than inheriting our stale authorship. It also drains legacy
      // rows, whose `undefined` still falls back to `resolvedAt`.
      //
      // `issue_missing` and a failed RPC learn nothing, so they must leave it
      // alone. Clearing on those would let one transient `issues.get` failure
      // convert our own close into an apparent operator close and mute a live
      // recurring alert for a whole suppression window — the failure
      // direction this ticket exists to remove, arriving from the other side.
      const pluginClosureUpdate: Partial<Pick<AlertStateRecord, "pluginClosedAt">> =
        !decisionApplied || decision.kind === "issue_missing"
          ? {}
          : { pluginClosedAt: null };
      // The same rule has to cover `resolvedAt`, or the guarantee above is only
      // true for rows that already carry an explicit `pluginClosedAt`. For a
      // legacy row (`pluginClosedAt: undefined`) `resolvedAt` *is* the
      // authorship signal `closedByPlugin` falls back to, so clearing it on a
      // delivery that applied nothing does exactly what the paragraph above
      // refuses to do, one field over: one failed `issues.get` turns our own
      // close into an apparent operator close and mutes the next re-fire.
      // Leaving it untouched keeps the row's last real observation intact until
      // a delivery that actually applied a decision replaces it.
      const resolvedAtUpdate: Partial<Pick<AlertStateRecord, "resolvedAt">> =
        !decisionApplied || decision.kind === "issue_missing" ? {} : { resolvedAt: null };

      await upsertAggregateMember(
        ctx,
        tracked.paperclipCompanyId,
        aggregateKey,
        tracked.paperclipIssueId,
        alert.fingerprint,
        firingToken,
      );

      const updated: AlertStateRecord = {
        ...tracked,
        aggregateKey,
        alertname,
        severity,
        lastFiredAt: nowIso,
        ...resolvedAtUpdate,
        ...pluginClosureUpdate,
        operatorSuppressedAt: suppressionAnchor,
        nextEscalationAt: ladderRestart
          ? (() => {
              const delay = escalationDeadlineMs(alert, config);
              return delay === null ? null : new Date(Date.now() + delay).toISOString();
            })()
          : existing.nextEscalationAt,
        escalationAttempt: ladderRestart ? 0 : existing.escalationAttempt,
        escalationComplete: ladderRestart ? false : existing.escalationComplete,
        escalationIntervalMs: ladderRestart
          ? escalationDeadlineMs(alert, config)
          : (existing.escalationIntervalMs ?? escalationDeadlineMs(alert, config)),
      };
      // Fenced, like the member write above and for the same reason. Winning
      // `upsertAggregateMember` proves ownership *at that statement*, not for
      // the rest of the delivery: a steal committing right after it would
      // otherwise let this displaced worker overwrite the aggregate's alert
      // state with its own stale view. The host holds the generation lock to
      // commit, so the steal and this write cannot interleave.
      await ctx.state.set(stateRef, updated, {
        fencing: firingFence(companyId, aggregateKey, firingToken),
      });

      // Same generation, re-read immediately before dispatch — but an
      // ownership *check*, not a fence, and named accordingly. It stops a
      // displaced predecessor announcing a re-fire in the common case, where
      // the displacement happened long before this point. It does not make
      // delivery authoritative: a steal landing between the check and the
      // fan-out still delivers. Nothing in this repo subscribes to this event,
      // and any future subscriber must re-establish ownership before acting on
      // it rather than trusting delivery. See `PluginEventOwnershipCheck` and
      // BLO-31113 for the authoritative-delivery follow-up.
      await ctx.events.emit(
        "alertmanager.alert.firing",
        tracked.paperclipCompanyId,
        {
          fingerprint: alert.fingerprint,
          alertname,
          severity,
          labels: alert.labels,
          annotations: alert.annotations,
          paperclipIssueId: tracked.paperclipIssueId,
          assigneeUserId: tracked.assigneeUserId,
          assigneeAgentId: tracked.assigneeAgentId ?? null,
          reFired: true,
        },
        { ownershipCheck: firingFence(companyId, aggregateKey, firingToken) },
      );
      await ctx.metrics.write("alertmanager.firing.deduped", 1, {
        alertname,
        severity,
      });
      return;
    }

  // Creation floor. Deliberately placed *after* the re-fire branch above and
  // before creation only: an `info` alert that already owns an issue (filed
  // before this floor existed) keeps being refreshed, and `handleResolved`
  // still closes it. Gating the whole delivery instead would strand those
  // legacy issues open forever, which is the resolution behavior this ticket
  // explicitly excludes from scope.
  //
  // Reads the `severity` already computed above rather than re-reading the
  // label: two normalizations of one value drift the moment either changes.
  if (severity.trim().toLowerCase() === "info") {
    ctx.logger.info(
      `Alertmanager: ${alertname} is below the issue creation floor (severity=info)`,
    );
    try {
      await ctx.metrics.write("alertmanager.webhook.below_issue_floor", 1, {
        alertname,
        severity: "info",
      });
    } catch (metricErr) {
      // Best-effort: this drop is permanent policy, already decided. Letting a
      // metrics outage throw would mark the delivery failed and make
      // Alertmanager retry an alert we will drop identically every time.
      ctx.logger.error(
        `paperclip-plugin-alertmanager: failed to record issue floor metric for ${alert.fingerprint}: ${String(metricErr)}`,
      );
    }
    return;
  }

  // First time we've seen this fingerprint — create a new issue. `companyId` is
  // already resolved and non-empty; it scoped the state read above.
  let retainedIssue = await findActiveAggregateIssue(ctx, companyId, aggregateKey);
  const issueRouteResolution = resolveIssueRoute(alert, config.issueRouteMap);
  const issueRoute = issueRouteResolution.route;
  const routeAssigneeAgentId = nonEmptyString(issueRoute?.assigneeAgentId);
  const routeHasAssigneeUserId = Object.prototype.hasOwnProperty.call(
    issueRoute ?? {},
    "assigneeUserId",
  );
  const routeAssigneeUserId = routeHasAssigneeUserId
    ? nonEmptyString(issueRoute?.assigneeUserId ?? undefined)
    : undefined;
  let createAssigneeAgentId: string | undefined;
  let createAssigneeUserId: string | undefined;
  let assigneeResolutionSource = "aggregate-winner";
  let resolvedTarget = "(aggregate-winner)";
  if (!retainedIssue) {
    const { assigneeUserId, assigneeAgentId, resolution } =
      await resolveAssigneeUserId(ctx, alert, config.ownerMap);
    const ownerOverride =
      resolution.source === "label-override" ||
      resolution.source === "annotation-override";
    createAssigneeAgentId = ownerOverride
      ? assigneeAgentId
      : routeAssigneeAgentId ?? assigneeAgentId;
    createAssigneeUserId = createAssigneeAgentId
      ? undefined
      : ownerOverride
        ? assigneeUserId
        : routeHasAssigneeUserId
          ? routeAssigneeUserId
          : assigneeUserId;
    assigneeResolutionSource = resolution.source;
    resolvedTarget =
      resolution.agentId
        ? `agent:${resolution.agentId}`
        : resolution.email ?? "(none)";
  }
  const fallbackAssigneeAgentId =
    retainedIssue || createAssigneeAgentId || createAssigneeUserId
      ? undefined
      : await resolveFallbackAgentIdMemoized(
          ctx,
          companyId,
          config.fallbackAgentName,
          fallbackOwnerMemo,
        );
  const finalAssigneeAgentId = createAssigneeAgentId ?? fallbackAssigneeAgentId;
  if (!retainedIssue && !finalAssigneeAgentId && !createAssigneeUserId) {
    ctx.logger.warn(
      `Cannot create issue for ${alertname}: fallbackAgentName is missing, invalid, or ambiguous`,
    );
    await ctx.metrics.write("alertmanager.owner.fallback_failed", 1, {
      alertname,
      severity,
    });
    throw new Error(
      `Fallback owner resolution failed for ${alertname}; refusing ownerless issue creation`,
    );
  }
  const routeProjectId = nonEmptyString(issueRoute?.projectId);
  const routeGoalId = nonEmptyString(issueRoute?.goalId);
  const routeStatus = issueRoute?.status;
  const resolvedAssignee =
    finalAssigneeAgentId ?? createAssigneeUserId ?? "(no assignee)";
  ctx.logger.debug(
    `Owner resolution for ${alertname}: ${assigneeResolutionSource} → ${resolvedTarget} → ${resolvedAssignee}`,
  );
  if (issueRouteResolution.source) {
    ctx.logger.debug(
      `Issue route for ${alertname}: ${issueRouteResolution.source.labelKey}=${issueRouteResolution.source.labelValue}`,
    );
  }

  const title = buildIssueTitle(alert);
  const description = buildIssueDescription(alert);
  const priority = severityToPriority(severity, config.severityToPriority);

  const billingCode = alert.labels.billing_code ?? null;

  let created = retainedIssue === null;
  let issue = retainedIssue;
  // Same barrier as the re-fire path, before the creation path's own aggregate
  // side effects. Without it a displaced predecessor filed a brand-new issue
  // for an aggregate it no longer owned and only lost the race at the member
  // write below, leaving an orphan issue no member row and no resolver refers
  // to. All the owner/route resolution above is reads, so proving ownership
  // here rather than at the claim keeps the window free of our own RPCs.
  await assertFiringGeneration(ctx, companyId, aggregateKey, firingToken);
  if (!issue) {
    let claimToken: string | null = null;
    try {
      claimToken = await tryClaimAggregateCreation(ctx, companyId, aggregateKey);
      if (!claimToken) {
        const retained = await findActiveAggregateIssue(
          ctx,
          companyId,
          aggregateKey,
        );
        if (retained) {
          issue = retained;
          created = false;
        } else {
          throw new Error(
            `Alertmanager aggregate creation already in progress for ${aggregateKey}`,
          );
        }
      }
      if (!issue) {
        issue = await ctx.issues.create({
          companyId,
          fencing: firingFence(companyId, aggregateKey, firingToken),
          title,
          description,
          priority,
          originKind: ORIGIN_KIND,
          originId: alert.fingerprint,
          originFingerprint: aggregateKey,
          ...(routeProjectId ? { projectId: routeProjectId } : {}),
          ...(routeGoalId ? { goalId: routeGoalId } : {}),
          ...(routeStatus ? { status: routeStatus } : {}),
          ...(createAssigneeUserId ? { assigneeUserId: createAssigneeUserId } : {}),
          ...(finalAssigneeAgentId ? { assigneeAgentId: finalAssigneeAgentId } : {}),
          ...(billingCode ? { billingCode } : {}),
        });
      }
    } catch (err) {
      if (!isAggregateCreationConflict(err)) throw err;
      const retained = await findActiveAggregateIssue(
        ctx,
        companyId,
        aggregateKey,
      );
      if (!retained) throw err;
      issue = retained;
      created = false;
    } finally {
      if (claimToken) {
        try {
          await releaseAggregateCreationClaim(
            ctx,
            companyId,
            aggregateKey,
            claimToken,
          );
        } catch (releaseErr) {
          ctx.logger.warn(
            `paperclip-plugin-alertmanager: failed to release aggregate creation claim for ${aggregateKey}: ${String(releaseErr)}`,
          );
        }
      }
    }
  }
  const effectiveAssigneeUserId = created
    ? createAssigneeUserId ?? null
    : issue.assigneeUserId ?? null;
  const effectiveAssigneeAgentId = created
    ? finalAssigneeAgentId ?? null
    : issue.assigneeAgentId ?? null;

  const record: AlertStateRecord = {
    paperclipIssueId: issue.id,
    paperclipCompanyId: companyId,
    aggregateKey,
    assigneeUserId: effectiveAssigneeUserId,
    assigneeAgentId: effectiveAssigneeAgentId,
    alertname,
    severity,
    firstSeenAt: alert.startsAt || nowIso,
    lastFiredAt: nowIso,
    resolvedAt: null,
    // BLO-31736: a freshly tracked fingerprint has no close of ours behind it.
    // Explicit rather than `undefined` so a new row never enters the legacy
    // `resolvedAt` authorship fallback.
    pluginClosedAt: null,
    nextEscalationAt: (() => {
      const delay = escalationDeadlineMs(alert, config);
      return delay === null ? null : new Date(Date.now() + delay).toISOString();
    })(),
    escalationAttempt: 0,
    escalationComplete: false,
    escalationIntervalMs: escalationDeadlineMs(alert, config),
  };
  await upsertAggregateMember(
    ctx,
    companyId,
    aggregateKey,
    issue.id,
    alert.fingerprint,
    firingToken,
  );
  // Fenced for the same reason as the re-fire path above: winning the member
  // write proves ownership at that statement only, and the creation path has
  // the same unguarded tail. Ally flagged this site specifically — a creation
  // delivery displaced right after the member upsert would otherwise publish
  // alert state and a firing event for an aggregate it no longer owns.
  await ctx.state.set(stateRef, record, {
    fencing: firingFence(companyId, aggregateKey, firingToken),
  });

  await ctx.events.emit(
    "alertmanager.alert.firing",
    companyId,
    {
      fingerprint: alert.fingerprint,
      alertname,
      severity,
      labels: alert.labels,
      annotations: alert.annotations,
      paperclipIssueId: issue.id,
      assigneeUserId: effectiveAssigneeUserId,
      assigneeAgentId: effectiveAssigneeAgentId,
      reFired: !created,
    },
    { ownershipCheck: firingFence(companyId, aggregateKey, firingToken) },
  );

  await ctx.activity.log({
    companyId,
    message: created
      ? `Alertmanager: created issue for firing alert "${alertname}" (severity=${severity})`
      : `Alertmanager: attached firing alert "${alertname}" to aggregate issue (severity=${severity})`,
    entityType: "issue",
    entityId: issue.id,
    metadata: {
      fingerprint: alert.fingerprint,
      aggregateKey,
      created,
      assigneeResolutionSource,
      issueRouteSource: issueRouteResolution.source
        ? `${issueRouteResolution.source.labelKey}=${issueRouteResolution.source.labelValue}`
        : "no-match",
    },
  });

  if (!created) {
    await ctx.metrics.write("alertmanager.aggregate.joined", 1, {
      alertname,
      severity,
    });
  }

  await ctx.metrics.write("alertmanager.firing.handled", 1, {
    alertname,
    severity,
  });
  } finally {
    await finishAggregateFiring(ctx, companyId, aggregateKey, firingToken);
  }
}

/**
 * §8.2 — alert cleared. If we have state for the fingerprint, close or
 * comment per `autoCloseOnResolve`. If not, log and drop.
 */
async function ensureResolutionComment(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
  resolvedAt: string,
) {
  const body = `Alert resolved at ${resolvedAt}.`;
  const comments = await ctx.issues.listComments(issueId, companyId);
  if (comments.some((comment) => comment.body === body)) return;
  await ctx.issues.createComment(issueId, body, companyId);
}

/**
 * BLO-29908: the resolve-driven cancel pins both execution-lock columns to
 * `null`, so a row a live run holds fails the precondition instead of being
 * cancelled. `updateIssue` answers that with a 409 whose message is one of
 * three "…before the update could be applied" variants (checkout owner,
 * execution owner, or the in-transaction precondition catch-all).
 *
 * Matching the shared suffix is deliberate: those are the ONLY preconditions
 * this call sets, so any of them failing means exactly one thing — a lock
 * appeared or was already held. Anything else is a real fault and must
 * propagate so the delivery fails and Alertmanager retries, rather than being
 * silently reported as a withheld cancel.
 */
function isExecutionLockPreconditionFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return message.includes("before the update could be applied");
}

/**
 * Marker line keyed on the holding run, not on `resolvedAt`. A flapping
 * fingerprint resolves twice an hour (BLO-29905 / BLO-29393), so keying the
 * idempotency on the timestamp would append a near-identical comment on every
 * cycle. One notification per holding run is the useful signal: it tells the
 * run that its subject cleared, once.
 */
function cancelWithheldMarker(runId: string): string {
  return `<!-- alertmanager:cancel-withheld:${runId} -->`;
}

async function ensureCancelWithheldComment(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
  resolvedAt: string,
  runId: string,
) {
  const marker = cancelWithheldMarker(runId);
  const comments = await ctx.issues.listComments(issueId, companyId);
  if (comments.some((comment) => comment.body.includes(marker))) return;
  const body = [
    marker,
    `**Alert resolved at ${resolvedAt} — auto-cancel withheld.**`,
    "",
    `This issue is held by execution run \`${runId}\`, so \`paperclip-plugin-alertmanager\` left`,
    "the status untouched rather than cancelling the row and clearing the execution lock.",
    "",
    "- The underlying alert is no longer firing. If your investigation is done, close this issue yourself.",
    "- The lock is intact: nothing was released out from under the holding run.",
    "- Cancelling here is the holder's decision, not the bridge's ([BLO-29908](/BLO/issues/BLO-29908)).",
  ].join("\n");
  await ctx.issues.createComment(issueId, body, companyId);
}

export async function handleResolved(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  alert: AlertmanagerAlert,
): Promise<void> {
  // Same scoping rule as handleFiring: without a company there is no namespace
  // to look in, and `recoverStateFromIssue` could not query either.
  const companyId = config.defaultCompanyId;
  if (!companyId) {
    ctx.logger.warn(
      `Cannot resolve alert ${alert.fingerprint}: defaultCompanyId not configured`,
    );
    return;
  }
  const { ref: stateRef, record: stateRecord } = await readAlertState(
    ctx,
    companyId,
    alert.fingerprint,
  );
  const existing = stateRecord ?? (await recoverStateFromIssue(ctx, config, alert));
  if (!existing) {
    ctx.logger.info(
      `Alertmanager: resolved for unknown fingerprint ${alert.fingerprint}, dropping`,
    );
    return;
  }

  const resolvedAt = alert.endsAt || new Date().toISOString();
  const alertname = existing.alertname;
  const storedAggregateKey =
    existing.aggregateKey ??
    (await findAggregateMemberKey(
      ctx,
      existing.paperclipCompanyId,
      existing.paperclipIssueId,
      alert.fingerprint,
    ));
  const aggregateKey = storedAggregateKey ?? aggregateKeyForAlert(alert);
  const aggregateResolution = await resolveAggregateMember(
    ctx,
    existing.paperclipCompanyId,
    aggregateKey,
    existing.paperclipIssueId,
    alert.fingerprint,
    config.autoCloseOnResolve !== false,
  );
  let cancellationToken: string | null = null;
  let cancelWithheldForRunId: string | null = null;
  // BLO-31736: authorship, recorded rather than inferred. Flipped only on the
  // branch where our own `status: "cancelled"` patch actually landed, so the
  // next re-fire can tell our close from an operator's.
  let pluginCancelLanded = false;

  try {
    if (config.autoCloseOnResolve !== false) {
      if (aggregateResolution.disposition === "finalization-pending") {
        throw new Error(
          `Alertmanager aggregate ${aggregateKey} is already finalizing; retrying resolution delivery`,
        );
      }
      // Old per-fingerprint records have no aggregate key or member row, so
      // retain their historical close behavior. Aggregate-tracked records are
      // fail-closed: a missing membership never authorizes cancellation.
      const shouldCancel =
        aggregateResolution.disposition === "last-member-resolved" ||
        (!storedAggregateKey && aggregateResolution.disposition === "no-membership");
      if (shouldCancel) {
        if (aggregateResolution.disposition === "last-member-resolved") {
          const resolutionToken = aggregateResolution.resolutionToken;
          if (
            !resolutionToken ||
            !(await beginAggregateCancellation(
              ctx,
              existing.paperclipCompanyId,
              aggregateKey,
              resolutionToken,
            ))
          ) {
            throw new Error(
              `Alertmanager aggregate ${aggregateKey} firing invalidated finalization; retrying resolution delivery`,
            );
          }
          cancellationToken = resolutionToken;
        }
        const issue = await ctx.issues.get(
          aggregateResolution.issueId,
          existing.paperclipCompanyId,
        );
        if (issue && issue.status !== "done" && issue.status !== "cancelled") {
          try {
            await ctx.issues.update(
              aggregateResolution.issueId,
              {
                status: "cancelled",
                // Do not cancel a row while a checkout or execution run owns
                // it. The host evaluates both preconditions atomically.
                expectedCurrentCheckoutRunId: null,
                expectedCurrentExecutionRunId: null,
              },
              existing.paperclipCompanyId,
            );
            pluginCancelLanded = true;
          } catch (err) {
            if (!isExecutionLockPreconditionFailure(err)) throw err;
            // The diagnostic read before update is racy. Re-read after the
            // failed CAS and only notify an owner that is still present.
            const currentIssue = await ctx.issues.get(
              aggregateResolution.issueId,
              existing.paperclipCompanyId,
            );
            cancelWithheldForRunId =
              currentIssue?.executionRunId ?? currentIssue?.checkoutRunId ?? null;
            if (cancelWithheldForRunId) {
              await ensureCancelWithheldComment(
                ctx,
                aggregateResolution.issueId,
                existing.paperclipCompanyId,
                resolvedAt,
                cancelWithheldForRunId,
              );
            }
            ctx.logger.info(
              `Alertmanager: withheld resolve-cancel for ${alertname} (${alert.fingerprint}) — issue ${aggregateResolution.issueId} is held by run ${cancelWithheldForRunId ?? "an unobserved owner"}`,
            );
            await ctx.metrics.write("alertmanager.resolved.cancel_withheld", 1, {
              alertname,
              severity: existing.severity,
            });
          }
        }
      } else if (aggregateResolution.disposition === "no-membership") {
        ctx.logger.warn(
          `Alertmanager: refusing to cancel aggregate issue ${aggregateResolution.issueId} for ${alert.fingerprint} because its membership is missing`,
        );
      }
    } else {
      await ensureResolutionComment(
        ctx,
        aggregateResolution.issueId,
        existing.paperclipCompanyId,
        resolvedAt,
      );
    }

    // BLO-16120: mark this source resolved within every cover it's a member
    // of, and close each cover only once its last unresolved member resolves.
    // Runs unconditionally (independent of autoCloseOnResolve) — the ladder
    // exhausted because the alert kept firing, not because the underlying
    // issue's status policy says so, so a resolved alert means its membership
    // in the shared cover is done either way.
    await recordSourceResolvedAndCloseCovers(
      ctx,
      existing.paperclipCompanyId,
      aggregateResolution.issueId,
    );

    // BLO-31736: authorship is a property of the *issue*, but this record is
    // keyed by fingerprint — and in a multi-member aggregate those are not the
    // same thing, because every member points at one shared issue. Three cases:
    //
    //  - **Our cancel landed** → stamp it. This delivery closed the issue.
    //  - **We deferred the close to a sibling** (`has-unresolved-siblings`):
    //    this delivery decided nothing, so the `null` our own *firing* write
    //    planted is now a false assertion. The last member to resolve will
    //    close the shared issue on this member's behalf and cannot reach back
    //    to correct this row, so leaving `null` made every non-last member read
    //    its own aggregate's close as an operator close and suppress the next
    //    genuine recurrence — the muting direction this ticket exists to
    //    remove. Drop to `undefined` ("authorship unknown"), which falls back
    //    to `resolvedAt` exactly as a legacy row does: a spurious re-open is
    //    the cheap error, silence is the expensive one.
    //  - **Anything else** — the terminal guard declining to overwrite someone
    //    else's close, a withheld cancel, a missing membership,
    //    `autoCloseOnResolve` off — leaves the previous value untouched via the
    //    spread, because this delivery learned nothing new about who closed the
    //    row. Overwriting would break the recurrence contract on a repeated
    //    `resolved` notification: Alertmanager may re-deliver one, the guard
    //    would hold (we already cancelled it), and clearing the flag would then
    //    mute the next real re-fire.
    const closeDeferredToSibling =
      config.autoCloseOnResolve !== false &&
      aggregateResolution.disposition === "has-unresolved-siblings";
    const pluginClosureUpdate: Partial<Pick<AlertStateRecord, "pluginClosedAt">> =
      pluginCancelLanded
        ? { pluginClosedAt: resolvedAt }
        : closeDeferredToSibling
          ? { pluginClosedAt: undefined }
          : {};

    const updated: AlertStateRecord = {
      ...existing,
      aggregateKey,
      paperclipIssueId: aggregateResolution.issueId,
      resolvedAt,
      ...pluginClosureUpdate,
      nextEscalationAt: null,
      escalationComplete: true,
      cancelWithheldForRunId,
      cancelWithheldAt: cancelWithheldForRunId ? resolvedAt : null,
    };
    await ctx.state.set(stateRef, updated);

    await ctx.events.emit(
      "alertmanager.alert.resolved",
      existing.paperclipCompanyId,
      {
        fingerprint: alert.fingerprint,
        alertname,
        paperclipIssueId: aggregateResolution.issueId,
        resolvedAt,
        cancelWithheldForRunId,
      },
    );

    await ctx.metrics.write("alertmanager.resolved.handled", 1, {
      alertname,
      severity: existing.severity,
    });
  } finally {
    if (cancellationToken) {
      await releaseAggregateFinalization(
        ctx,
        existing.paperclipCompanyId,
        aggregateKey,
        cancellationToken,
      );
    }
  }
}

async function recoverStateFromIssue(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  alert: AlertmanagerAlert,
): Promise<AlertStateRecord | null> {
  const companyId = config.defaultCompanyId;
  if (!companyId) return null;

  const matches = await ctx.issues.list({
    companyId,
    originKind: ORIGIN_KIND,
    originId: alert.fingerprint,
    limit: 1,
  });
  const issue = matches[0];
  // The per-fingerprint lookup can find an older terminal issue even while a
  // newer aggregate member is still unresolved on the active winner. Do not
  // let that historical row mask the aggregate membership fallback: state
  // loss must recover the live aggregate binding, not conclude that the alert
  // is unknown merely because its first origin match is terminal.
  if (!issue || issue.status === "done" || issue.status === "cancelled") {
    return recoverStateFromAggregateMember(ctx, config, alert);
  }

  return buildRecoveredStateRecord(companyId, issue, alert, config);
}

function buildRecoveredStateRecord(
  companyId: string,
  issue: IssueReference,
  alert: AlertmanagerAlert,
  config: AlertmanagerPluginConfig,
  aggregateKey?: string,
): AlertStateRecord {
  return {
    paperclipIssueId: issue.id,
    paperclipCompanyId: companyId,
    ...(aggregateKey ? { aggregateKey } : {}),
    assigneeUserId: issue.assigneeUserId ?? null,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    alertname: alert.labels.alertname ?? "UnnamedAlert",
    severity: alert.labels.severity ?? "unknown",
    firstSeenAt: alert.startsAt || new Date().toISOString(),
    lastFiredAt: alert.startsAt || new Date().toISOString(),
    resolvedAt: null,
    // BLO-31736: reconstructed rows are built only from a *non-terminal* issue
    // (both callers reject `done`/`cancelled` before getting here), so no close
    // of ours can be outstanding. Explicit rather than `undefined` so a
    // reconstructed row does not enter the legacy authorship fallback.
    pluginClosedAt: null,
    // BLO-20467: arm the ladder on the recovered record. The firing path now
    // adopts this when state was lost, and the re-fire branch carries these
    // fields through unchanged for a still-firing alert — so leaving them unset
    // would silently disarm escalation for exactly the alert whose state we
    // just had to reconstruct. Ladder progress made before the state loss is
    // not recoverable from the issue, so this restarts the ladder rather than
    // resuming it: a late page beats no page. Inert on the resolved path, which
    // overwrites both fields.
    nextEscalationAt: (() => {
      const delay = escalationDeadlineMs(alert, config);
      return delay === null ? null : new Date(Date.now() + delay).toISOString();
    })(),
    escalationAttempt: 0,
    escalationComplete: false,
    escalationIntervalMs: escalationDeadlineMs(alert, config),
  };
}

/**
 * Top-level webhook handler. Pure-ish: takes ctx + config + an authentication
 * verdict + input, returns void. Throws `WebhookUnauthorizedError` when that
 * verdict is `false` — the worker's onWebhook re-throws this so the host
 * can surface a 401 / drop the delivery. Throws `AlertDeliveryIncompleteError`
 * when any alert in the batch failed to process, so the host records the
 * delivery `failed` and Alertmanager retries it.
 *
 * `authenticated` is a verdict, never a credential. `authenticateWebhook`
 * (config-scope.ts) owns every way a request can authenticate — inline token
 * and `webhookTokenRef` alike — so this function does no comparison and never
 * sees a secret. It also records no credential health: given only a verdict it
 * could not tell "no credential configured" from "wrong bearer presented", and
 * conflating those is exactly what credential-health.ts exists to prevent
 * (BLO-20572). `resolveCompanyScope` is the sole recorder.
 *
 * Returning normally is an acknowledgement: it makes the host answer HTTP 200
 * and ends Alertmanager's retries. Only do that when the delivery needs no
 * retry — a malformed or unsupported-version payload, or a filtered alert —
 * never when something that could succeed later has failed.
 */
export async function handleWebhook(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  authenticated: boolean,
  input: PluginWebhookInput,
): Promise<void> {
  if (input.endpointKey !== WEBHOOK_KEYS.alertmanager) {
    ctx.logger.warn(
      `paperclip-plugin-alertmanager: ignoring webhook for unknown endpoint key "${input.endpointKey}"`,
    );
    return;
  }

  if (!authenticated) {
    ctx.logger.warn(
      "paperclip-plugin-alertmanager: rejecting webhook — bearer token missing or invalid",
    );
    await ctx.metrics.write("alertmanager.webhook.unauthorized", 1);
    throw new WebhookUnauthorizedError();
  }

  const body = input.parsedBody;
  if (!isAlertmanagerPayload(body)) {
    ctx.logger.warn(
      "paperclip-plugin-alertmanager: dropping webhook with malformed body",
    );
    await ctx.metrics.write("alertmanager.webhook.malformed", 1);
    return;
  }

  if (!ACCEPTED_SCHEMA_VERSIONS.has(body.version)) {
    ctx.logger.warn(
      `paperclip-plugin-alertmanager: dropping webhook with unsupported schema version "${body.version}"`,
    );
    await ctx.metrics.write("alertmanager.webhook.unsupported_version", 1, {
      version: body.version,
    });
    return;
  }

  const failedFingerprints: string[] = [];
  // Scoped to this delivery — see FallbackOwnerMemo. A storm is the case that
  // matters: without it, every ownerless alert in the batch repeats the same
  // company-wide agent lookup.
  const fallbackOwnerMemo: FallbackOwnerMemo = new Map();

  for (const alert of body.alerts) {
    if (!alertMatchesLabelFilter(alert, config.acceptOnlyLabels)) {
      await ctx.metrics.write("alertmanager.webhook.filtered", 1, {
        alertname: alert.labels.alertname ?? "unknown",
      });
      continue;
    }

    const status = effectiveAlertStatus(alert, body);
    const alertname = alert.labels.alertname ?? "unknown";
    try {
      // These policy values govern issue creation only. They are evaluated
      // before firing work, but must not prevent a resolved delivery from
      // closing an issue that was already created.
      const policyValues = [
        alert.labels.paperclip_issue,
        alert.annotations.paperclip_issue,
      ];
      const malformedPolicy = policyValues.some(
        (value) => value !== undefined && typeof value !== "string",
      );
      const optedOut = policyValues.some(
        (value) =>
          typeof value === "string" && value.trim().toLowerCase() === "false",
      );
      if (status === "firing") {
        if (malformedPolicy) {
          // A non-string here means the rule author wrote something structurally
          // wrong. Refusing to guess is safer than coercing: `paperclip_issue`
          // decides whether a page becomes an issue at all.
          ctx.logger.warn(
            `paperclip-plugin-alertmanager: dropping alert ${alert.fingerprint} because paperclip_issue must be a string when provided`,
          );
          try {
            await ctx.metrics.write("alertmanager.alert.malformed", 1, {
              alertname,
            });
          } catch (metricErr) {
            ctx.logger.error(
              `paperclip-plugin-alertmanager: failed to record malformed alert metric for ${alert.fingerprint}: ${String(metricErr)}`,
            );
          }
          continue;
        }
        if (optedOut) {
          ctx.logger.info(
            `Alertmanager: ${alertname} opted out via paperclip_issue=false`,
          );
          try {
            await ctx.metrics.write("alertmanager.webhook.issue_opt_out", 1, {
              alertname,
            });
          } catch (metricErr) {
            // Best-effort for the same reason as the creation floor: a permanent
            // policy drop must stay acknowledged even if telemetry is down.
            ctx.logger.error(
              `paperclip-plugin-alertmanager: failed to record issue opt-out metric for ${alert.fingerprint}: ${String(metricErr)}`,
            );
          }
          continue;
        }
        await handleFiring(ctx, config, alert, fallbackOwnerMemo);
      } else if (status === "resolved") {
        // Reached with BOTH policy gates above deliberately bypassed — this
        // path is creation-only, exactly like the severity floor in
        // handleFiring, and for the same reason. Gating it would strand any
        // issue the rule had *already* filed: handleResolved would never run,
        // so `state.resolvedAt` would stay null and the issue would never reach
        // done/cancelled. `advanceIssueLadder` (escalation.ts:377,380) returns
        // early only on resolvedAt, escalationComplete, or a terminal issue
        // status — none of which would ever happen — so the sweep would keep
        // advancing the ladder, waking agents, and eventually file a
        // [user-cover] board escalation for an alert that had already resolved.
        //
        // That is the modal adoption path for the opt-out, not an exotic one:
        // operators opt a rule out *because* it has been filing noisy issues,
        // so a tracked issue almost always exists at that moment. An opt-out is
        // meant to stop new noise, not to wedge the issues it already made.
        //
        // The malformed gate reaches the same conclusion by a shorter route: a
        // non-string `paperclip_issue` is a defect in a *creation* policy, and
        // dropping the resolve over it would convert a typo — a YAML `true`
        // where a `"true"` was meant — into a permanently escalating issue for
        // an alert that has cleared. The firing-side drop already refuses to
        // guess what the author meant; the resolve never had to guess, because
        // it does not read the value at all.
        //
        // This does not weaken the "no state side effect" guarantee for a rule
        // opted out from the start: with no issue ever filed there is no state
        // row, and handleResolved drops an unknown fingerprint without touching
        // anything.
        await handleResolved(ctx, config, alert);
      } else {
        ctx.logger.warn(
          `paperclip-plugin-alertmanager: unknown alert status "${status}" for fingerprint ${alert.fingerprint}`,
        );
      }
    } catch (err) {
      // Catch per alert so one failure cannot abandon the rest of the batch —
      // but record it, because the delivery is NOT complete. Spec §5.2 step 3's
      // "log + 200" applies to a *malformed payload*, which is handled above and
      // is permanent; these failures are issue-RPC, state-store, event, and
      // metric errors, which are transient. Swallowing them answered HTTP 200,
      // so Alertmanager stopped retrying and the alert was destroyed with no
      // durable issue or state row — the same silent-loss class as the outage
      // this plugin already suffered (BLO-20467).
      ctx.logger.error(
        `paperclip-plugin-alertmanager: error processing alert ${alert.fingerprint}: ${String(err)}`,
      );
      failedFingerprints.push(alert.fingerprint);
      try {
        await ctx.metrics.write("alertmanager.alert.error", 1, {
          alertname: alert.labels.alertname ?? "unknown",
        });
      } catch (metricErr) {
        // Telemetry is best-effort; a metrics outage must not be the thing that
        // aborts the remaining alerts. The delivery already counts as failed.
        ctx.logger.error(
          `paperclip-plugin-alertmanager: failed to record alert error metric for ${alert.fingerprint}: ${String(metricErr)}`,
        );
      }
    }
  }

  if (failedFingerprints.length > 0) {
    // Replaying the whole batch is safe: handleFiring/handleResolved both key
    // off the stored per-fingerprint alert state, so alerts that already
    // succeeded update their existing issue rather than filing a duplicate.
    throw new AlertDeliveryIncompleteError(failedFingerprints);
  }
}
