import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import { assertCompanyAccess } from "../routes/authz.js";
import {
  grantsForHumanRole,
  membershipRoleIsNonViewer,
  normalizeHumanRole,
} from "../services/company-member-roles.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

/**
 * PEN-3954 — `company_memberships.membership_role` is a plain nullable `text`
 * column with no DB constraint, and the codebase used to read it through
 * THREE dispositions that disagreed with each other:
 *
 *   1. `normalizeHumanRole(v, "viewer")` — fails CLOSED. `services/authorization.ts`
 *      (`membershipRoleIsNonViewer`) and `routes/authz.ts` (`normalizedTranscriptRole`).
 *   2. `normalizeHumanRole(v, "operator")` — PRIVILEGED. The provisioning path
 *      (`services/principal-access-compatibility.ts`), `resolveHumanInviteRole`
 *      and four sites in `routes/access.ts`.
 *   3. raw `=== "viewer"` — failed OPEN. The two write bars in `routes/authz.ts`
 *      and the two in `routes/tool-access.ts` / `routes/tool-gateway.ts`.
 *
 * Two values reach those bars from outside `HUMAN_COMPANY_MEMBERSHIP_ROLES`:
 * `null` (accepted explicitly by `updateCompanyMemberSchema` and written
 * straight through by the member-update path) and `support` (written verbatim
 * by the cloud-tenant path in `middleware/auth.ts` — only `owner`/`admin`
 * collapse to `owner`). `support` is absent from the wider storable
 * `COMPANY_MEMBERSHIP_ROLES` too; the write only succeeds because the column
 * is unconstrained `text`.
 *
 * BOTH halves are now closed. The `null` half had no entitlement question
 * behind it. The `support` half did, and PEN-4964 ruled it on 2026-10-29
 * (owner: CTO): a cloud-tenant `support` principal gets READ, NOT WRITE.
 *
 * This suite pins all three dispositions AGREEING, which is the property the
 * ticket was actually about — any one of them drifting back is a regression,
 * and a regression in a different one each time is how this got to three.
 */

function boardRequest(
  method: string,
  membershipRole: string | null,
  status = "active",
): Request {
  return {
    method,
    actor: {
      type: "board",
      source: "cloud_tenant",
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole, status }],
    },
  } as unknown as Request;
}

/**
 * The OTHER bar in `routes/authz.ts`. `assertCompanyAccess` holds two
 * independent membership tests — this one for an agent acting on behalf of a
 * responsible user, and the board one above — and before PEN-3954 each
 * spelled the role question with its own raw comparison. They now call the
 * same predicate, but "same predicate" is a structural claim; this helper is
 * what lets the suite make the BEHAVIOURAL one at the second bar too.
 */
function onBehalfOfRequest(
  method: string,
  membershipRole: string | null,
  status = "active",
): Request {
  return {
    method,
    actor: {
      type: "agent",
      source: "agent_jwt",
      agentId: "agent-1",
      companyId: "company-1",
      onBehalfOfUserId: "user-1",
      onBehalfOfMemberships: [{ companyId: "company-1", membershipRole, status }],
    },
  } as unknown as Request;
}

/**
 * The `onBehalfOf` bar degrades to log-only when shadow mode is on, so a
 * deny assertion is meaningless unless the mode is pinned off. Reading the
 * ambient environment would make the test pass vacuously wherever the var
 * happens to be set.
 */
function withResponsibleUserEnforcement<T>(run: () => T): T {
  const previousShadow = process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW;
  const previousMode = process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE;
  delete process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW;
  delete process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE;
  try {
    return run();
  } finally {
    if (previousShadow === undefined) delete process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW;
    else process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW = previousShadow;
    if (previousMode === undefined) delete process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE;
    else process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE = previousMode;
  }
}

function expectResponsibleUserWriteDenied(req: Request) {
  try {
    assertCompanyAccess(req, "company-1");
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect((err as HttpError).details).toMatchObject({ code: "RESPONSIBLE_USER_UNAUTHORIZED" });
    return;
  }
  throw new Error("Expected a responsible-user company access denial");
}

describe("PEN-3954: membership_role at the HTTP write bars", () => {
  /**
   * Each deny below carries a control. Without one the deny does not
   * discriminate: a `null` row would read as denied just as well if
   * `assertCompanyAccess` refused cloud-tenant writes wholesale, or if the
   * membership lookup had simply missed. The control is what makes the test
   * about the ROLE VALUE rather than about the actor or the lookup.
   */
  describe("null membership_role is denied on writes (the half with no entitlement question)", () => {
    it("denies POST for a null role while allowing the same company's operator", () => {
      expect(() => assertCompanyAccess(boardRequest("POST", null), "company-1"))
        .toThrow(/read-only/i);

      // Control: the bar is not refusing every cloud-tenant write.
      expect(() => assertCompanyAccess(boardRequest("POST", "operator"), "company-1"))
        .not.toThrow();
    });

    it("still allows a null role to READ — this bar is write-only", () => {
      // Control for the control: the deny above is scoped to unsafe methods,
      // so a null row must keep its GET. If this ever starts throwing, the
      // guard has widened past its intent.
      for (const method of ["GET", "HEAD", "OPTIONS"]) {
        expect(() => assertCompanyAccess(boardRequest(method, null), "company-1"))
          .not.toThrow();
      }
    });

    it("routes the deny through the shared predicate, not a role literal", () => {
      // `membershipRoleIsNonViewer` is THE write bar (Ally's Suggestion 1 on
      // #2444). Asserting it directly means the four call sites are pinned by
      // one property instead of four copies of a string comparison.
      expect(membershipRoleIsNonViewer(null)).toBe(false);
      expect(membershipRoleIsNonViewer(undefined)).toBe(false);
      expect(membershipRoleIsNonViewer("viewer")).toBe(false);
      expect(membershipRoleIsNonViewer("")).toBe(false);
      // Controls: the predicate is not simply false for everything.
      expect(membershipRoleIsNonViewer("operator")).toBe(true);
      expect(membershipRoleIsNonViewer("member")).toBe(true);
      expect(membershipRoleIsNonViewer("owner")).toBe(true);
      expect(membershipRoleIsNonViewer("admin")).toBe(true);
    });

    it("keeps `member` and `viewer` behaving exactly as before", () => {
      // The blast-radius claim on PEN-3954: no ordinary member loses access.
      expect(() => assertCompanyAccess(boardRequest("POST", "member"), "company-1"))
        .not.toThrow();
      expect(() => assertCompanyAccess(boardRequest("POST", "viewer"), "company-1"))
        .toThrow(/read-only/i);
    });
  });

  /**
   * PEN-4964, decided 2026-10-29, owner CTO: a cloud-tenant `support`
   * principal gets READ, NOT WRITE.
   *
   * Two of these were CHARACTERIZATION tests until that ruling — they
   * recorded three layers giving three different answers. They are now the
   * ruling itself. The implementation is ONE branch (`support -> viewer` in
   * `normalizeHumanRole`) plus the four converted bars, so the layers move
   * together; asserting each layer separately is what makes a partial revert
   * visible rather than silently half-applied.
   */
  describe("support membership_role is read-only (PEN-4964)", () => {
    it("is DENIED at the HTTP write bar, with a control allow and a control read", () => {
      expect(() => assertCompanyAccess(boardRequest("POST", "support"), "company-1"))
        .toThrow(/read-only/i);

      // Control: the bar is not refusing every cloud-tenant write.
      expect(() => assertCompanyAccess(boardRequest("POST", "operator"), "company-1"))
        .not.toThrow();
      // Control: support keeps its READ. "Read, not write" is the ruling —
      // if this starts throwing, the change went further than was decided.
      for (const method of ["GET", "HEAD", "OPTIONS"]) {
        expect(() => assertCompanyAccess(boardRequest(method, "support"), "company-1"))
          .not.toThrow();
      }
    });

    it("normalizes to viewer under EVERY fallback, which is what makes the layers agree", () => {
      // Disposition 1 — the fail-closed bars. Unchanged by the ruling.
      expect(normalizeHumanRole("support", "viewer")).toBe("viewer");
      // Disposition 2 — the provisioning seed. This is the one that moved:
      // it used to fall through to the `operator` fallback.
      expect(normalizeHumanRole("support", "operator")).toBe("viewer");
      // Stated as one assertion so a partial revert cannot be read past: the
      // two dispositions that disagreed now return the same value.
      expect(normalizeHumanRole("support", "viewer"))
        .toBe(normalizeHumanRole("support", "operator"));
      // Control: the fallback still works for a value with no branch, so the
      // agreement above is `support`'s explicit branch and not a dead
      // parameter.
      expect(normalizeHumanRole("nonsense-role", "viewer")).toBe("viewer");
      expect(normalizeHumanRole("nonsense-role", "operator")).toBe("operator");
      // Control: `member` still folds UP to operator. The ruling narrowed
      // `support` only.
      expect(normalizeHumanRole("member", "viewer")).toBe("operator");
    });

    it("seeds a support row NO grants — and writes nothing at all, so it revokes nothing", async () => {
      // `grantsForHumanRole("viewer")` is empty, so
      // `insertMissingPrincipalGrants` returns before touching the database.
      // That is load-bearing: the seed is insert-only
      // (`onConflictDoNothing`, no delete), so stopping it cannot take
      // `tasks:assign` away from a support seat that already holds one.
      // Existing seats lose write at the HTTP bar above, not here.
      expect(grantsForHumanRole(normalizeHumanRole("support", "operator"))).toEqual([]);

      const exploding = new Proxy({}, {
        get(_target, property) {
          throw new Error(`ensureHumanRoleDefaultGrants touched db.${String(property)} for a support row`);
        },
      });
      await expect(ensureHumanRoleDefaultGrants(exploding as never, {
        companyId: "company-1",
        principalId: "user-1",
        membershipRole: "support",
        grantedByUserId: null,
      })).resolves.toBe(0);

      // Control: an operator row DOES reach the database, so the assertion
      // above is about `support` and not about the proxy never being called.
      await expect(ensureHumanRoleDefaultGrants(exploding as never, {
        companyId: "company-1",
        principalId: "user-1",
        membershipRole: "operator",
        grantedByUserId: null,
      })).rejects.toThrow(/touched db\./);
    });

    it("stays OUT of the role enums — the decision was read-side normalization, not a new role", async () => {
      // Adding `support` to `HUMAN_COMPANY_MEMBERSHIP_ROLES` was considered
      // and REJECTED on PEN-4964: it would make it a selectable UI role in
      // every tenant and in the public plugin SDK to fix an authz bug in one
      // deployment mode. It is absent from the wider storable set too, which
      // is why `middleware/auth.ts` can only write it into an unconstrained
      // `text` column.
      const shared = await import("@paperclipai/shared");
      expect(shared.HUMAN_COMPANY_MEMBERSHIP_ROLES).not.toContain("support");
      expect(shared.COMPANY_MEMBERSHIP_ROLES).not.toContain("support");
    });
  });

  /**
   * Ally's Suggestion 2 on head `8deb1a75`: until now the behavioural cases
   * all used `board` actors, so the `onBehalfOf` bar (`routes/authz.ts:107`)
   * was covered only STRUCTURALLY — by the predicate assertions above. Both
   * bars calling one predicate lowers that risk but does not close it: the
   * two bars differ in how they deny (`throw` vs the shadow-mode log-only
   * path) and in which membership list they read, and either of those could
   * be rewired without the predicate changing at all.
   */
  describe("the onBehalfOf bar denies the same two values, behaviourally", () => {
    it("denies a support responsible user on write, with an operator control", () => {
      withResponsibleUserEnforcement(() => {
        expectResponsibleUserWriteDenied(onBehalfOfRequest("PATCH", "support"));

        // Control: the bar is not refusing every on-behalf-of write.
        expect(() => assertCompanyAccess(onBehalfOfRequest("PATCH", "operator"), "company-1"))
          .not.toThrow();
      });
    });

    it("denies a null responsible-user role on write", () => {
      withResponsibleUserEnforcement(() => {
        expectResponsibleUserWriteDenied(onBehalfOfRequest("POST", null));
      });
    });

    it("leaves reads alone at this bar too — read-only, not no-access", () => {
      withResponsibleUserEnforcement(() => {
        for (const role of ["support", null]) {
          for (const method of ["GET", "HEAD", "OPTIONS"]) {
            expect(() => assertCompanyAccess(onBehalfOfRequest(method, role), "company-1"))
              .not.toThrow();
          }
        }
      });
    });

    it("still degrades to log-only under shadow mode", () => {
      // The deny above is real only because enforcement is on. Pinning the
      // shadow path keeps the three tests above honest: if shadow mode ever
      // became a no-op, they would pass for the wrong reason.
      const previous = process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW;
      process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW = "true";
      try {
        expect(() => assertCompanyAccess(onBehalfOfRequest("PATCH", "support"), "company-1"))
          .not.toThrow();
      } finally {
        if (previous === undefined) delete process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW;
        else process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW = previous;
      }
    });
  });

  /**
   * Ally's Suggestion 1 on #2444, now in the form it was originally asked
   * for. While the four bars had to stay raw this could only pin a CENSUS —
   * the exact per-file count — because a lint forbidding the pattern
   * outright could not pass. With all four converted the invariant is the
   * strong one: the comparison does not appear in server code at all.
   *
   * A new call site must go through `membershipRoleIsNonViewer`. Re-spelling
   * the comparison is what produced three disagreeing dispositions out of one
   * question, and the disagreement was invisible precisely because each site
   * read correct on its own.
   */
  it("admits no raw comparison against the `viewer` literal anywhere in server code", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const offenders: string[] = [];
    const sanctioned: string[] = [];

    // Every spelling of the comparison, not just the one the four bars
    // happened to use. Matching only `=== "viewer"` left `!== "viewer"` —
    // the EXACT shape `membershipRoleIsNonViewer` itself is written in, and
    // the one the `authorization.ts` docblock describes as the fail-open
    // form — plus `== "viewer"` and `'viewer'` free to reappear. The source
    // has none of those today, which is the moment to close them: the
    // invariant is about a question being re-spelled, and a census that only
    // knows one spelling is exactly the wrong shape for that.
    //
    // Ally's follow-up suggestion at `554f1571` named two more spellings:
    // `["viewer"].includes(role)` and `case "viewer":`. The array-membership
    // one is added below — it has no occurrence in the tree and no plausible
    // benign form, so it is free.
    //
    // `case "viewer":` is deliberately NOT matched, and the reason is
    // evidence rather than taste: adding it immediately flags
    // `services/company-member-roles.ts`, the `grantsForHumanRole` switch.
    // That arm takes a `HumanCompanyMembershipRole` — a value that has
    // ALREADY been through `normalizeHumanRole` — so it is structurally
    // incapable of being a write bar on a raw column value, which is the
    // only thing this census is about. Admitting it would cost either the
    // `toHaveLength(1)` marker pin (the property Ally singled out as what
    // makes the whitelist sound) or a by-name file exemption (which Ally
    // argued is strictly worse, because it would hide a second raw bar
    // placed in that file). Neither price is worth a pattern whose first
    // real-world match is a false positive.
    //
    // This stays an operator-level regex and can never be complete; a `Set`
    // lookup or a `startsWith` would slip past. It is a tripwire for the
    // re-spellings that actually happened, not a proof of absence.
    const rawComparison =
      /[!=]==?\s*["']viewer["']|["']viewer["']\s*[!=]==?|\[\s*["']viewer["']\s*\]\s*\.\s*includes/;
    // One comparison has to exist — the predicate's own body. It carries
    // this marker so the census can tell the definition from a re-spelling.
    // The marker alone is not enough to pass: `sanctioned` is asserted to be
    // exactly one line, in `services/company-member-roles.ts`, below. Pasting
    // it onto a second site fails just as loudly as leaving it off.
    const allowMarker = "pen3954-census-allow";

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          // `__tests__` is excluded on purpose: a test asserting on the old
          // behaviour must still be able to name the pattern it is about.
          if (entry.name === "__tests__" || entry.name === "node_modules") continue;
          walk(full);
          continue;
        }
        // `.mts`/`.tsx` do not exist under `server/src` today; including
        // them means adding one later cannot quietly fall outside the walk.
        if (!/\.(ts|mts|tsx)$/.test(entry.name)) continue;
        const source = readFileSync(full, "utf8");
        source.split("\n").forEach((line, index) => {
          const trimmed = line.trim();
          // Count CODE lines only. The comments beside the converted bars
          // quote the pattern they are documenting, and prose must not read
          // as a live bar. Dropping comment lines can only undercount a
          // mention, never hide a real comparison — a live bar is not a
          // comment line.
          if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
          if (!rawComparison.test(line)) return;
          const where = `${relative(root, full)}:${index + 1}`;
          if (line.includes(allowMarker)) sanctioned.push(where);
          else offenders.push(where);
        });
      }
    };
    walk(root);

    expect(offenders).toEqual([]);
    // The marker is a whitelist of exactly one, pinned to the file that
    // defines the predicate. Asserting the count rather than merely ignoring
    // marked lines is what keeps the marker from becoming an escape hatch.
    expect(sanctioned).toHaveLength(1);
    expect(sanctioned[0]).toMatch(/^services\/company-member-roles\.ts:\d+$/);
  });
});
