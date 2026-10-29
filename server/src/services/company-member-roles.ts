import { PERMISSION_KEYS } from "@paperclipai/shared";
import type { HumanCompanyMembershipRole } from "@paperclipai/shared";

const HUMAN_COMPANY_MEMBERSHIP_ROLES: HumanCompanyMembershipRole[] = [
  "owner",
  "admin",
  "operator",
  "viewer",
];

/**
 * Fold a stored `company_memberships.membership_role` onto the human role
 * union. The column is a plain nullable `text` with no DB constraint
 * (`packages/db/src/schema/company_memberships.ts`), so values outside
 * `HUMAN_COMPANY_MEMBERSHIP_ROLES` — and outside even the wider storable
 * `COMPANY_MEMBERSHIP_ROLES` — do reach this function.
 *
 * Two of them have an EXPLICIT branch rather than taking `fallback`, because
 * the right answer for each is a decision somebody made, not a default:
 *
 *   - `member` -> `operator`. The legacy name for the ordinary writer role.
 *   - `support` -> `viewer`. A cloud-tenant support principal gets READ, NOT
 *     WRITE. Decided 2026-10-29, owner CTO, on PEN-4964; implemented on
 *     PEN-3954. `support` is written verbatim into this column by the
 *     cloud-tenant provisioning path (`middleware/auth.ts`,
 *     `stackMembershipRole` accepts `owner|admin|member|support`; only
 *     `owner`/`admin` collapse to `owner`), and it is absent from BOTH
 *     `HUMAN_COMPANY_MEMBERSHIP_ROLES` and `COMPANY_MEMBERSHIP_ROLES`
 *     (`packages/shared/src/constants.ts`) — the write only succeeds because
 *     the column is unconstrained. The decision deliberately keeps storing
 *     the raw string and normalizes on READ, so rows already written are
 *     covered too; and it deliberately does NOT add `support` to
 *     `HUMAN_COMPANY_MEMBERSHIP_ROLES`, which would make it a selectable UI
 *     role in every tenant and in the public plugin SDK to fix an authz bug
 *     in one deployment mode.
 *
 * Without the `support` branch the value took `fallback`, which means it was
 * READ DIFFERENTLY BY EACH CALLER: `viewer` at the fail-closed bars, and
 * `operator` at `ensureHumanRoleDefaultGrants`, which then seeded it a real
 * `tasks:assign` grant. The branch is what makes every call site agree.
 */
export function normalizeHumanRole(
  value: unknown,
  fallback: HumanCompanyMembershipRole = "operator"
): HumanCompanyMembershipRole {
  if (value === "member") return "operator";
  if (value === "support") return "viewer";
  return HUMAN_COMPANY_MEMBERSHIP_ROLES.includes(value as HumanCompanyMembershipRole)
    ? (value as HumanCompanyMembershipRole)
    : fallback;
}

/**
 * THE membership-role write bar. Whether a stored row clears a non-viewer
 * test, failing CLOSED on anything outside the normalized human role union.
 *
 * This is the single predicate Ally asked for in Suggestion 1 on
 * paperclip#2444: before PEN-3954 the same question was spelled four
 * different ways as a raw `role === "viewer"` comparison in
 * `routes/authz.ts` (twice), `routes/tool-access.ts` and
 * `routes/tool-gateway.ts`, and a fifth way as a private helper in
 * `services/authorization.ts`. A raw comparison counts `null` AND `support`
 * as non-viewer and ADMITS the write; this one denies both.
 *
 * The fallback is `viewer`, NOT `normalizeHumanRole`'s own `operator`
 * default. That default is right for its other callers (grant seeding, label
 * rendering) and wrong for an authorization bar: it would turn every unknown
 * or legacy role string into a privileged member. `viewer` is the
 * least-privileged member of the union, so an unrecognized role lands where a
 * viewer lands — needing an explicit `principal_permission_grants` row.
 *
 * Add new call sites by calling THIS, never by re-spelling the comparison.
 * `server/src/__tests__/pen3954-membership-role-write-bars.test.ts` walks all
 * of `server/src` outside `__tests__` and fails CI on a raw `=== "viewer"`
 * reappearing anywhere in it.
 */
export function membershipRoleIsNonViewer(value: unknown): boolean {
  return normalizeHumanRole(value, "viewer") !== "viewer";
}

export function grantsForHumanRole(
  role: HumanCompanyMembershipRole
): Array<{
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
}> {
  switch (role) {
    case "owner":
      return [
        { permissionKey: "agents:create", scope: null },
        { permissionKey: "agents:configure", scope: null },
        { permissionKey: "skills:create", scope: null },
        { permissionKey: "environments:manage", scope: null },
        { permissionKey: "users:invite", scope: null },
        { permissionKey: "users:manage_permissions", scope: null },
        { permissionKey: "tasks:assign", scope: null },
        { permissionKey: "joins:approve", scope: null },
      ];
    case "admin":
      return [
        { permissionKey: "agents:create", scope: null },
        { permissionKey: "agents:configure", scope: null },
        { permissionKey: "skills:create", scope: null },
        { permissionKey: "environments:manage", scope: null },
        { permissionKey: "users:invite", scope: null },
        { permissionKey: "tasks:assign", scope: null },
        { permissionKey: "joins:approve", scope: null },
      ];
    case "operator":
      return [{ permissionKey: "tasks:assign", scope: null }];
    case "viewer":
      return [];
  }
}

export function resolveHumanInviteRole(
  defaultsPayload: Record<string, unknown> | null | undefined
): HumanCompanyMembershipRole {
  if (!defaultsPayload || typeof defaultsPayload !== "object") return "operator";
  const scoped = defaultsPayload.human;
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    return "operator";
  }
  return normalizeHumanRole((scoped as Record<string, unknown>).role, "operator");
}
