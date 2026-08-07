/**
 * BLO-20886 round 7: which issue a merged PR is persisted against.
 *
 * `issue-pull-requests.ts` ranks link sources with the branch FIRST, while
 * `resolveOwningPaperclipIdentifiers` ranks the branch LAST -- deliberately, on
 * the measurement that branches get repurposed and are the wrong issue in every
 * case where they disagree with a curated title. Those two orderings coexisted
 * harmlessly only while a lowercase branch failed to classify at all. Once
 * classification became case-insensitive (round 6), a STALE branch ref started
 * outranking the curated title owner and the merged PR was recorded against the
 * wrong issue.
 *
 * These tests pin the reconciliation: ownership decides, link-source strength
 * only breaks ties among equally-owning (or equally-unowning) candidates.
 */
import { describe, expect, it } from "vitest";
import { __test_selectIssuePerCompany as selectIssuePerCompany } from "../services/issue-pull-requests.js";

const COMPANY = "company-1";

describe("merged-PR issue selection defers to ownership (BLO-20886)", () => {
  // The exact case from the review: the branch names a stale issue, the title
  // names the issue the PR actually fixes, and the body mentions the stale one
  // under a non-owning label.
  const staleBranchFields = {
    branch: "fix/blo-1-stale",
    title: "Fix BLO-2",
    body: "Related: BLO-1",
  };

  it("persists against the curated title owner, not the stale branch ref", () => {
    const chosen = selectIssuePerCompany(
      [
        { id: "issue-stale", companyId: COMPANY, identifier: "BLO-1" },
        { id: "issue-owner", companyId: COMPANY, identifier: "BLO-2" },
      ],
      staleBranchFields,
    ).get(COMPANY);

    expect(chosen?.identifier).toBe("BLO-2");
    expect(chosen?.issueId).toBe("issue-owner");
    // Provenance still describes how the winner was found, and stays accurate.
    expect(chosen?.linkSource).toBe("title_ref");
  });

  it("is independent of the order the matched issues arrive in", () => {
    // The pre-fix rule was strength-then-first-seen, so iteration order was
    // load-bearing. Both orders must now agree.
    for (const matched of [
      [
        { id: "issue-owner", companyId: COMPANY, identifier: "BLO-2" },
        { id: "issue-stale", companyId: COMPANY, identifier: "BLO-1" },
      ],
      [
        { id: "issue-stale", companyId: COMPANY, identifier: "BLO-1" },
        { id: "issue-owner", companyId: COMPANY, identifier: "BLO-2" },
      ],
    ]) {
      expect(selectIssuePerCompany(matched, staleBranchFields).get(COMPANY)?.identifier).toBe("BLO-2");
    }
  });

  it("still prefers the branch when the branch IS the owner", () => {
    // Ownership consults the branch when nothing curated resolves, so a
    // branch-only owner must keep winning over a bare body mention. This is the
    // 21-recovered-wakes case the branch tier exists for.
    const chosen = selectIssuePerCompany(
      [
        { id: "issue-mentioned", companyId: COMPANY, identifier: "BLO-99" },
        { id: "issue-owner", companyId: COMPANY, identifier: "BLO-20886" },
      ],
      { branch: "cto/blo-20886-round5", title: "no ref in title", body: "Related: BLO-99" },
    ).get(COMPANY);

    expect(chosen?.identifier).toBe("BLO-20886");
    expect(chosen?.linkSource).toBe("branch_ref");
  });

  it("falls back to link-source strength when ownership names nobody", () => {
    // No owning reference anywhere: no closing keyword, no `Refs:`, no house
    // label. Behaviour here is unchanged from before the fix -- strongest
    // source wins -- so this pins that the fix did not repurpose the fallback.
    const chosen = selectIssuePerCompany(
      [
        { id: "issue-body", companyId: COMPANY, identifier: "BLO-8" },
        { id: "issue-branch", companyId: COMPANY, identifier: "BLO-7" },
      ],
      { branch: "cto/blo-7-work", title: "no ref", body: "loosely mentions BLO-8" },
    ).get(COMPANY);

    expect(chosen?.identifier).toBe("BLO-7");
    expect(chosen?.linkSource).toBe("branch_ref");
  });

  it("keeps one row per company", () => {
    const selected = selectIssuePerCompany(
      [
        { id: "a", companyId: "company-A", identifier: "BLO-1" },
        { id: "b", companyId: "company-B", identifier: "BLO-2" },
      ],
      staleBranchFields,
    );

    expect(selected.size).toBe(2);
    expect(selected.get("company-A")?.identifier).toBe("BLO-1");
    expect(selected.get("company-B")?.identifier).toBe("BLO-2");
  });

  it("skips issues with no identifier", () => {
    const selected = selectIssuePerCompany(
      [{ id: "no-ident", companyId: COMPANY, identifier: null }],
      staleBranchFields,
    );

    expect(selected.size).toBe(0);
  });
});
