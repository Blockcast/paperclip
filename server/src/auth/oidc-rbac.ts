// Dex OIDC group-claim to Paperclip RBAC reconciliation.
// Workspace group email addresses from Dex's `groups` claim grant company
// operator membership or request instance-admin elevation. Elevation remains
// approval-gated; no OIDC group directly grants instance-admin.

import type { Db } from "@paperclipai/db";
import {
  approvals,
  companyMemberships,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { insertApproval } from "../services/approval-insert.js";

const DEFAULT_BLOCKCAST_COMPANY_ID = "aaced805-3491-4ee5-9b14-cdf70cb81d47";

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
 * own OAuth flow which already validated against Dex's JWKS before
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
 * call on every signin -- no duplicate memberships or approval rows.
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

  // Workspace operator group -> Blockcast operator.
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
      // Operator was archived earlier and is now back in the group; re-
      // activate. Membership role left as-is to preserve any manual
      // upgrade (e.g. promoted to owner via the admin UI).
      await db
        .update(companyMemberships)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(companyMemberships.id, existing[0]!.id));
      addedMembership = true;
    }
  }

  // Workspace admin group -> pending elevation approval.
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
      await insertApproval(db, {
        companyId: config.blockcastCompanyId,
        type: config.adminApprovalType,
        requestedByUserId: userId,
        status: "pending",
        payload: {
          title: `Admin elevation requested for ${userId}`,
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

export async function reconcileDexUser(
  db: Db,
  userId: string,
  groups: string[],
  config: DexRbacConfig = loadDexRbacConfig(),
): Promise<ReconcileResult> {
  return reconcileGroupClaimUser(db, userId, groups, config);
}
