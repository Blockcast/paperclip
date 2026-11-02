import {
  companyMemberships,
  principalPermissionGrants,
} from "@paperclipai/db";

// Both column lists below are a DECISION, not a convenience.
//
// A bare `db.select()` means a column added to either table reaches every
// consumer of every query that omits a column list — including the routes that
// serialise the row straight out to an API client (`routes/access.ts`
// agent-permissions response, `routes/agents.ts` `buildAgentAccessState`) and
// the plugin host, which hands `company_memberships` and
// `principal_permission_grants` rows to third-party plugin code
// (`services/plugin-host-services.ts` `access.listMembers` / `getMember` /
// `updateMember`, `authorization.listGrants` / `setGrants`). That is reach
// granted by the shape of the query rather than by anyone deciding it, which
// is the same defect PEN-5232 records one layer up.
//
// `principal_permission_grants.scope` is the concrete reason this matters
// more than "nobody would add a sensitive column": it is an uncontained
// `jsonb` whose shape is not pinned by its type, so its *contents* can widen
// with no migration at all. `redactGrant` sanitizes those *contents*; it
// spreads `...grant`, so it does not restrict the key *set*.
//
// These lists are the full current column set of each table, because every
// field is already read by some consumer (see PEN-5258 for the per-consumer
// survey) — the point is not to narrow today's response, it is that the NEXT
// column must be added here deliberately before it can reach any of those
// consumers.
// ⇒ Adding a column to either table does NOT belong in these lists by
//    default. Add it only once you have decided every consumer should see it.
//
// SCOPE OF THAT GUARANTEE — PEN-5273 extended it from PEN-5258's two read
// paths to every read of these two tables that returns whole rows, and
// `access-column-projections.test.ts` now enforces that at source: a bare
// `.select()` / `.returning()` on either table fails the test rather than
// silently widening reach. Queries that project a narrower, purpose-built
// column list (`{ id }` existence checks and similar) are unaffected and
// remain the better choice where they fit — the ratchet is about whole-row
// reads, not about forcing every query through these lists.
//
// These live in their own module rather than in `services/access.ts` so that
// `services/authorization.ts` can import them: `access.ts` imports
// `authorization.ts`, so the reverse import would be a cycle.
//
// Refs PEN-5258, PEN-5273, PEN-5232.
export const membershipColumns = {
  id: companyMemberships.id,
  companyId: companyMemberships.companyId,
  principalType: companyMemberships.principalType,
  principalId: companyMemberships.principalId,
  status: companyMemberships.status,
  membershipRole: companyMemberships.membershipRole,
  createdAt: companyMemberships.createdAt,
  updatedAt: companyMemberships.updatedAt,
} as const;

export const principalGrantColumns = {
  id: principalPermissionGrants.id,
  companyId: principalPermissionGrants.companyId,
  principalType: principalPermissionGrants.principalType,
  principalId: principalPermissionGrants.principalId,
  permissionKey: principalPermissionGrants.permissionKey,
  scope: principalPermissionGrants.scope,
  grantedByUserId: principalPermissionGrants.grantedByUserId,
  createdAt: principalPermissionGrants.createdAt,
  updatedAt: principalPermissionGrants.updatedAt,
} as const;
