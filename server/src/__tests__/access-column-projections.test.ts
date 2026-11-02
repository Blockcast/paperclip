import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { companyMemberships, principalPermissionGrants } from "@paperclipai/db";
import { membershipColumns, principalGrantColumns } from "../services/access.js";
import type * as AccessModule from "../services/access.js";

// Every whole-row read of `company_memberships` and `principal_permission_grants`
// projects an explicit column list, so that a column added to either table
// cannot reach their consumers — which include two routes that serialise the
// row straight to an API client and the plugin host, which hands rows to
// third-party plugin code — without someone deciding it should. A comment alone
// cannot hold that property: the whole failure mode is a migration author who
// never reads this file.
//
// These tests fail when a table gains (or loses) a column. That failure is the
// point: it is the prompt to decide. Resolve it by either adding the column to
// the projection, having decided every consumer should see it, or adding it to
// the `deliberatelyOmitted` set below with a reason.
//
// `deliberatelyOmitted` is not free, and the compiler will tell you so before
// this test does. Dropping a column from `membershipColumns` narrows the row
// type, which breaks two places that assert the FULL row: `getMembership`'s
// `Promise<MembershipRow | null>` annotation (`services/access.ts`) and
// `redactGrant`'s `$inferSelect` parameter (`services/plugin-host-services.ts`).
// Both need retyping to whatever you narrowed to. That cost is the point — a
// narrower projection should be a typed decision, not a silent one.
//
// Refs PEN-5258, PEN-5273, PEN-5232.
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

  // PEN-5273: the column lists above are only worth what their CALL SITES are
  // worth. PEN-5258 projected two read paths and the comment above it read, to
  // a hurried eye, as a property of the tables — while `listMembers`,
  // `getMemberById`, `listActiveUserMemberships`, `ensureMembership`'s two
  // `.returning()` paths, both plugin-host grant reads and four `routes/access`
  // reads were still bare. A prose "next ratchet step" is exactly the kind of
  // promise this series exists to stop relying on, so the step is enforced here
  // instead.
  //
  // This scans source rather than behaviour on purpose: the failure mode is a
  // NEW query written months from now by someone who never reads this file, and
  // no runtime test can see a query that nobody calls yet.
  //
  // To resolve a failure: project the offending query. Use the shared list when
  // the consumer needs the whole row, or a narrower purpose-built list (an
  // `{ id }` existence check, say) when it does not — the ratchet is about
  // whole-row reads, not about forcing every query through these lists.
  describe("no whole-row reads of either table escape a projection", () => {
    const serverSrc = fileURLToPath(new URL("..", import.meta.url));
    const TABLES = ["companyMemberships", "principalPermissionGrants"] as const;

    const sourceFiles = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          return entry === "node_modules" || entry === "__tests__" ? [] : sourceFiles(full);
        }
        return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
      });

    const findings = sourceFiles(serverSrc).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      const where = (index: number) =>
        `${relative(serverSrc, file)}:${text.slice(0, index).split("\n").length}`;
      const hits: string[] = [];

      for (const table of TABLES) {
        const bareSelect = new RegExp(`\\.select\\(\\s*\\)\\s*\\.from\\(\\s*${table}\\s*\\)`, "g");
        for (const match of text.matchAll(bareSelect)) {
          hits.push(`${where(match.index ?? 0)} bare .select() on ${table}`);
        }

        // A bare `.returning()` hands back the whole row just as a bare
        // `.select()` does; `ensureMembership` was the live instance of this.
        const mutation = new RegExp(`\\.(?:update|insert|delete)\\(\\s*${table}\\s*\\)`, "g");
        for (const match of text.matchAll(mutation)) {
          const start = match.index ?? 0;
          const end = text.indexOf(";", start);
          const statement = text.slice(start, end === -1 ? text.length : end);
          if (/\.returning\(\s*\)/.test(statement)) {
            hits.push(`${where(start)} bare .returning() on ${table}`);
          }
        }
      }
      return hits;
    });

    it("finds no bare .select() or .returning()", () => {
      expect(findings).toEqual([]);
    });

    it("actually scanned the files it claims to cover", () => {
      // Guards the silent-pass direction: a broken walk or a moved source root
      // would make the assertion above vacuous. These four files all read at
      // least one of the two tables today.
      const scanned = sourceFiles(serverSrc).map((file) => relative(serverSrc, file));
      for (const file of [
        "services/access.ts",
        "services/plugin-host-services.ts",
        "services/authorization.ts",
        "routes/access.ts",
      ]) {
        expect(scanned).toContain(file);
      }
    });
  });

  // Done-when #3 of PEN-5273: the plugin host spreads `...member` and
  // `...grant` straight into values handed to third-party plugin code
  // (`access.listMembers`, `access.getMember`, `access.updateMember`,
  // `authorization.listGrants`, `authorization.setGrants`). Those spreads are
  // fed by `getMemberById` / `listMembers` / `listPrincipalGrants`, so pinning
  // the row type of those accessors to the decided lists is what makes the
  // plugin-facing field set a decision. This is a COMPILE-time assertion: it
  // fails `tsc`, not vitest, which is the point — the error lands on whoever
  // widens the accessor.
  type Access = ReturnType<typeof AccessModule.accessService>;
  type MemberRow = NonNullable<Awaited<ReturnType<Access["getMemberById"]>>>;
  type ListedMemberRow = Awaited<ReturnType<Access["listMembers"]>>[number];
  type GrantRow = Awaited<ReturnType<Access["listPrincipalGrants"]>>[number];
  type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

  const memberKeysAreDecided: Exactly<keyof MemberRow, keyof typeof membershipColumns> = true;
  const listedMemberKeysAreDecided: Exactly<keyof ListedMemberRow, keyof typeof membershipColumns> = true;
  const grantKeysAreDecided: Exactly<keyof GrantRow, keyof typeof principalGrantColumns> = true;

  it("pins the plugin-facing member and grant rows to the decided lists", () => {
    expect([memberKeysAreDecided, listedMemberKeysAreDecided, grantKeysAreDecided]).toEqual([
      true,
      true,
      true,
    ]);
  });
});
