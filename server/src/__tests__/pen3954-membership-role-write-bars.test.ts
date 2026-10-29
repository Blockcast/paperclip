import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { assertCompanyAccess } from "../routes/authz.js";
import { normalizeHumanRole } from "../services/company-member-roles.js";

/**
 * PEN-3954 — `company_memberships.membership_role` is a plain nullable `text`
 * column with no DB constraint, and the codebase reads it through THREE
 * dispositions that disagree with each other:
 *
 *   1. `normalizeHumanRole(v, "viewer")` — fails CLOSED. `services/authorization.ts`
 *      (`membershipRoleIsNonViewer`) and `routes/authz.ts` (`normalizedTranscriptRole`).
 *   2. `normalizeHumanRole(v, "operator")` — PRIVILEGED. The provisioning path
 *      (`services/principal-access-compatibility.ts`), `resolveHumanInviteRole`
 *      and four sites in `routes/access.ts`.
 *   3. raw `=== "viewer"` — fails OPEN. The two write bars in `routes/authz.ts`
 *      and the two in `routes/tool-access.ts` / `routes/tool-gateway.ts`.
 *
 * Two values reach those bars from outside `HUMAN_COMPANY_MEMBERSHIP_ROLES`:
 * `null` (accepted explicitly by `updateCompanyMemberSchema` and written
 * straight through by the member-update path) and `support` (written verbatim
 * by the cloud-tenant path in `middleware/auth.ts` — only `owner`/`admin`
 * collapse to `owner`).
 *
 * This suite closes the `null` half and PINS the `support` half as the open
 * question it still is. The two halves are deliberately separated: `null` has
 * no entitlement question behind it, `support` does.
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

    it("denies a null role the same way the two tool bars already did", () => {
      // `routes/tool-access.ts` and `routes/tool-gateway.ts` have carried
      // `!membership.membershipRole ||` since before PEN-3954. The point of
      // this change is that all four bars now spell the guard identically.
      const toolAccess = readFileSync(
        fileURLToPath(new URL("../routes/tool-access.ts", import.meta.url)),
        "utf8",
      );
      const toolGateway = readFileSync(
        fileURLToPath(new URL("../routes/tool-gateway.ts", import.meta.url)),
        "utf8",
      );
      const authz = readFileSync(
        fileURLToPath(new URL("../routes/authz.ts", import.meta.url)),
        "utf8",
      );
      const guard = '!membership.membershipRole || membership.membershipRole === "viewer"';
      expect(toolAccess).toContain(guard);
      expect(toolGateway).toContain(guard);
      expect(authz).toContain(guard);
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
   * CHARACTERIZATION — these assert what the code does TODAY, not what it
   * should do. `support` is the unresolved half of PEN-3954: the entitlement
   * question ("what is a cloud-tenant support principal allowed to do?") is
   * routed to the CTO and is NOT settled by this suite.
   *
   * When that decision lands, these two assertions are the diff. If `support`
   * becomes read-only, the first flips to `.toThrow()` and the second's
   * fallback changes. Do not "fix" them in passing — flipping them without
   * the provisioning seed in `ensureHumanRoleDefaultGrants` just relocates the
   * disagreement onto the provisioning path, which is the whole reason this
   * was split out of #2444.
   */
  describe("support membership_role: the three dispositions still disagree (OPEN)", () => {
    it("is ADMITTED at the HTTP write bar (disposition 3, fails open)", () => {
      expect(() => assertCompanyAccess(boardRequest("POST", "support"), "company-1"))
        .not.toThrow();
    });

    it("is DENIED by the decider and SEEDED operator by provisioning (dispositions 1 and 2)", () => {
      // Disposition 1 — `membershipRoleIsNonViewer` in services/authorization.ts.
      expect(normalizeHumanRole("support", "viewer")).toBe("viewer");
      // Disposition 2 — `ensureHumanRoleDefaultGrants` seeds grantsForHumanRole(this).
      expect(normalizeHumanRole("support", "operator")).toBe("operator");
      // The disagreement, stated as one assertion so it cannot be read past:
      expect(normalizeHumanRole("support", "viewer"))
        .not.toBe(normalizeHumanRole("support", "operator"));
    });
  });

  /**
   * Ally's Suggestion 1 on #2444, in the form that is executable TODAY.
   *
   * A lint that forbids raw `=== "viewer"` outright cannot pass while the
   * four bars are still raw, and they must stay raw until the `support`
   * decision lands. So instead this pins the CENSUS: the exact set of files
   * carrying a raw bar, and how many each has. A FIFTH disposition cannot
   * appear without failing here, which is the invariant the suggestion was
   * actually after.
   *
   * When `support` is decided and the bars are converted, delete the entries
   * rather than bumping the numbers.
   */
  it("pins the census of raw `=== \"viewer\"` comparisons so a new one fails CI", () => {
    const expected: Record<string, number> = {
      // The `onBehalfOf` write bar and the `assertCompanyAccess` board write
      // bar. Both now also deny `null`; both still admit `support`.
      "routes/authz.ts": 2,
      "routes/tool-access.ts": 1,
      "routes/tool-gateway.ts": 1,
    };

    const actual: Record<string, number> = {};
    for (const relative of Object.keys(expected)) {
      const source = readFileSync(
        fileURLToPath(new URL(`../${relative}`, import.meta.url)),
        "utf8",
      );
      // Count CODE lines only. The comments beside these bars quote the
      // pattern they are documenting, and a prose mention must not read as a
      // new bar. Dropping comments can only ever undercount a mention, never
      // hide a real comparison — a live bar is not a comment line.
      actual[relative] = source
        .split("\n")
        .filter((line) => {
          const trimmed = line.trim();
          return !trimmed.startsWith("//") && !trimmed.startsWith("*");
        })
        .filter((line) => line.includes('=== "viewer"'))
        .length;
    }

    expect(actual).toEqual(expected);
  });
});
