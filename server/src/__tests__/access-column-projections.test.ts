import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { companyMemberships, principalPermissionGrants } from "@paperclipai/db";
import { membershipColumns, principalGrantColumns } from "../services/access.js";

// `getMembership` and `listPrincipalGrants` project an explicit column list so
// that a column added to either table cannot reach their consumers — two of
// which serialise the row straight to an API client — without someone deciding
// it should. A comment alone cannot hold that property: the whole failure mode
// is a migration author who never reads this file.
//
// These tests fail when a table gains (or loses) a column. That failure is the
// point: it is the prompt to decide. Resolve it by either adding the column to
// the projection, having decided every consumer should see it, or adding it to
// the `deliberatelyOmitted` set below with a reason.
//
// Refs PEN-5258, PEN-5232.
describe("access service column projections", () => {
  it("getMembership projects a decided column set", () => {
    const deliberatelyOmitted = new Set<string>();
    const tableColumns = Object.keys(getTableColumns(companyMemberships));

    expect(Object.keys(membershipColumns).sort()).toEqual(
      tableColumns.filter((column) => !deliberatelyOmitted.has(column)).sort(),
    );
  });

  it("listPrincipalGrants projects a decided column set", () => {
    const deliberatelyOmitted = new Set<string>();
    const tableColumns = Object.keys(getTableColumns(principalPermissionGrants));

    expect(Object.keys(principalGrantColumns).sort()).toEqual(
      tableColumns.filter((column) => !deliberatelyOmitted.has(column)).sort(),
    );
  });

  it("keeps `scope` a decided field rather than an incidental one", () => {
    // `principal_permission_grants.scope` is an uncontained jsonb: its contents
    // can widen with no migration, so it is the one column whose presence in
    // the projection should stay explicit rather than inherited.
    expect(Object.keys(principalGrantColumns)).toContain("scope");
  });
});
