// OIDC group-claim → paperclip RBAC reconciliation (BLO-6295 piece D).
//
// Behavior contract (signed off 2026-05-21):
//
// - id_token `groups` claim contains MICROSOFT_SSH_USERS_GROUP_ID  →
//   auto-grant `companyMemberships(blockcast, user, operator, active)`.
//   No human-in-the-loop step. The ssh-users Entra group is the
//   engineering team's source of truth for "should have Blockcast
//   company access"; signing in via that group is the explicit grant.
//
// - id_token `groups` claim contains MICROSOFT_ADMIN_AGENTS_GROUP_ID →
//   write a `pending` row to the `approvals` table with
//   type=`microsoft_admin_elevation`. The flag DOES NOT auto-grant
//   isInstanceAdmin — an existing instance admin must explicitly
//   approve the elevation via the Board UI / approvals API. The same
//   row is idempotent: an existing pending approval for the same
//   (userId, type) is left as-is on subsequent signins.
//
// Pure functions in this file deliberately avoid coupling to better-auth
// or the Microsoft Graph client; the periodic reconciler in
// services/microsoft-group-reconciler.ts and the better-auth hook in
// auth/better-auth.ts both call `reconcileMicrosoftUser` with whatever
// group list they have on hand. Dex/Google sign-in uses the same underlying
// reconciler with Workspace group email addresses from the Dex `groups` claim.

import type { Db } from "@paperclipai/db";
import {
  approvals,
  companyMemberships,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";

// Production GUIDs (blockcast.net tenant). Env-overridable for dev/staging
// instances that point at a different tenant or different group structure.
// The defaults match what `az ad group list` returns in production.
const DEFAULT_BLOCKCAST_COMPANY_ID = "aaced805-3491-4ee5-9b14-cdf70cb81d47";
const DEFAULT_SSH_USERS_GROUP_ID = "980aeb78-a886-4dae-98bb-7a9893d20706";
const DEFAULT_ADMIN_AGENTS_GROUP_ID = "675cb5f3-4a94-4514-96d8-9899587b19ed";

export interface MicrosoftRbacConfig {
  blockcastCompanyId: string;
  sshUsersGroupId: string;
  adminAgentsGroupId: string;
}

export interface GroupClaimRbacConfig {
  blockcastCompanyId: string;
  operatorGroupId: string | null;
  adminGroupId: string | null;
  adminApprovalType: string;
  payloadSource: string;
}

export interface DexRbacConfig extends GroupClaimRbacConfig {
  providerId: string;
}

export function loadMicrosoftRbacConfig(): MicrosoftRbacConfig {
  return {
    blockcastCompanyId:
      process.env.MICROSOFT_BLOCKCAST_COMPANY_ID?.trim() || DEFAULT_BLOCKCAST_COMPANY_ID,
    sshUsersGroupId:
      process.env.MICROSOFT_SSH_USERS_GROUP_ID?.trim() || DEFAULT_SSH_USERS_GROUP_ID,
    adminAgentsGroupId:
      process.env.MICROSOFT_ADMIN_AGENTS_GROUP_ID?.trim() || DEFAULT_ADMIN_AGENTS_GROUP_ID,
  };
}

export function loadDexRbacConfig(): DexRbacConfig {
  const providerId = process.env.PAPERCLIP_DEX_OIDC_PROVIDER_ID?.trim() || "dex";
  return {
    providerId,
    blockcastCompanyId:
      process.env.PAPERCLIP_DEX_BLOCKCAST_COMPANY_ID?.trim() || DEFAULT_BLOCKCAST_COMPANY_ID,
    operatorGroupId: process.env.PAPERCLIP_DEX_OPERATOR_GROUP?.trim() || null,
    adminGroupId: process.env.PAPERCLIP_DEX_ADMIN_GROUP?.trim() || null,
    adminApprovalType:
      process.env.PAPERCLIP_DEX_ADMIN_APPROVAL_TYPE?.trim() || "dex_admin_elevation",
    payloadSource: "dex_groups_claim",
  };
}

/**
 * Decode a JWT id_token and extract its `groups` claim. Returns an empty
 * array on any decode failure — callers treat "no groups" as "no auto-
 * grant", which is the safe default.
 *
 * Does NOT validate the signature. The token comes from better-auth's
 * own OAuth flow which already validated against Microsoft's JWKS before
 * persisting; we only re-parse the stored value.
 */
export function parseIdTokenGroups(idToken: string | null | undefined): string[] {
  if (!idToken || typeof idToken !== "string") return [];
  const parts = idToken.split(".");
  if (parts.length !== 3) return [];
  try {
    const payload = Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    const parsed = JSON.parse(payload) as { groups?: unknown };
    if (!Array.isArray(parsed.groups)) return [];
    return parsed.groups.filter((g): g is string => typeof g === "string");
  } catch {
    return [];
  }
}

export interface ReconcileResult {
  /** Did we insert a NEW companyMemberships row (vs no-op on existing). */
  addedMembership: boolean;
  /** Did we create a NEW pending admin-elevation approval (vs no-op on existing). */
  pendingAdminElevation: boolean;
  /** Group IDs we observed in the token (for caller logging). */
  observedGroups: string[];
}

function normalizeGroup(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

/**
 * Apply OIDC group membership to paperclip state. Idempotent: safe to
 * call on every signin and from the periodic reconciler — no duplicate
 * memberships, no duplicate approval rows.
 *
 * Pure-ish: only the database is touched. Caller decides where the
 * `groups` list comes from (id_token parse for signin-time path; Graph
 * API query for the daily reconciler path).
 *
 * Does NOT remove memberships when a user is no longer in ssh-users.
 * Off-boarding requires explicit Board action (archive the row via the
 * existing admin/users/:userId/company-access route). Auto-archive would
 * be too aggressive a default — a transient Entra outage that returns
 * empty groups would mass-remove the whole team.
 */
export async function reconcileGroupClaimUser(
  db: Db,
  userId: string,
  groups: string[],
  config: GroupClaimRbacConfig,
): Promise<ReconcileResult> {
  const groupSet = new Set(groups.map(normalizeGroup).filter((g): g is string => Boolean(g)));
  const operatorGroupId = normalizeGroup(config.operatorGroupId);
  const adminGroupId = normalizeGroup(config.adminGroupId);
  let addedMembership = false;
  let pendingAdminElevation = false;

  // ── ssh-users → Blockcast operator ──────────────────────────────────
  if (operatorGroupId && groupSet.has(operatorGroupId)) {
    const existing = await db
      .select({ id: companyMemberships.id, status: companyMemberships.status })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, config.blockcastCompanyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      await db.insert(companyMemberships).values({
        companyId: config.blockcastCompanyId,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: "operator",
      });
      addedMembership = true;
    } else if (existing[0]!.status !== "active") {
      // Operator was archived earlier and is now back in ssh-users; re-
      // activate. Membership role left as-is to preserve any manual
      // upgrade (e.g. promoted to owner via the admin UI).
      await db
        .update(companyMemberships)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(companyMemberships.id, existing[0]!.id));
      addedMembership = true;
    }
  }

  // ── AdminAgents → pending elevation approval ────────────────────────
  if (adminGroupId && groupSet.has(adminGroupId)) {
    const existing = await db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.type, config.adminApprovalType),
          eq(approvals.requestedByUserId, userId),
          eq(approvals.status, "pending"),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      await db.insert(approvals).values({
        companyId: config.blockcastCompanyId,
        type: config.adminApprovalType,
        requestedByUserId: userId,
        status: "pending",
        payload: {
          userId,
          detectedAt: new Date().toISOString(),
          source: config.payloadSource,
          adminGroupId: config.adminGroupId,
        },
      });
      pendingAdminElevation = true;
    }
  }

  return { addedMembership, pendingAdminElevation, observedGroups: groups };
}

export async function reconcileMicrosoftUser(
  db: Db,
  userId: string,
  groups: string[],
  config: MicrosoftRbacConfig = loadMicrosoftRbacConfig(),
): Promise<ReconcileResult> {
  return reconcileGroupClaimUser(db, userId, groups, {
    blockcastCompanyId: config.blockcastCompanyId,
    operatorGroupId: config.sshUsersGroupId,
    adminGroupId: config.adminAgentsGroupId,
    adminApprovalType: "microsoft_admin_elevation",
    payloadSource: "microsoft_groups_claim",
  });
}

export async function reconcileDexUser(
  db: Db,
  userId: string,
  groups: string[],
  config: DexRbacConfig = loadDexRbacConfig(),
): Promise<ReconcileResult> {
  return reconcileGroupClaimUser(db, userId, groups, config);
}
