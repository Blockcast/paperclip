import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// BLO-18858: the agent-facing skills document the exact `expectedStatuses` payload agents send to
// POST /api/issues/{id}/checkout. Including `in_review` in that list is not a harmless widening —
// it inverts the documented behaviour.
//
// issueService.checkout runs its atomic UPDATE first, matching on
// `inArray(issues.status, expectedStatuses)`, and returns early when a row matches
// (server/src/services/issues.ts:9187-9235). The typed
// `422 issue_in_review_not_checkoutable` is only reachable when that UPDATE matches nothing
// (:9417-9433). So documenting `in_review` makes the 422 unreachable and silently flips an
// unlocked review/approval wait to `in_progress` — resuming active execution on an issue whose
// review state the caller was promised would be preserved.
//
// Omitting `in_review` costs nothing: the 422 branch is additionally guarded on
// `checkoutRunId == null && executionRunId == null`, so a *locked* in_review row still falls
// through to the generic 409 conflict either way.
//
// The behavioural side is pinned by "returns a typed 422 for an unlocked in_review issue" in
// issues-service.test.ts. This pins the documentation side, so the two cannot drift apart.
const FORBIDDEN_STATUS = "in_review";

const DOCUMENTED_CHECKOUT_PAYLOAD_FILES = [
  "skills/paperclip/SKILL.md",
  "packages/skills-catalog/catalog/bundled/paperclip-operations/issue-triage/SKILL.md",
] as const;

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function documentedExpectedStatuses(relativePath: string): string[][] {
  const source = readFileSync(new URL(relativePath, `file://${repoRoot}`), "utf8");
  return [...source.matchAll(/"expectedStatuses"\s*:\s*\[([^\]]*)\]/g)].map(([, body]) =>
    [...body.matchAll(/"([^"]+)"/g)].map(([, status]) => status),
  );
}

describe("documented checkout expectedStatuses payload", () => {
  it.each(DOCUMENTED_CHECKOUT_PAYLOAD_FILES)("%s documents at least one checkout payload", (file) => {
    // Guards against the assertion below passing vacuously if the snippet is reworded or moved.
    expect(documentedExpectedStatuses(file).length).toBeGreaterThan(0);
  });

  it.each(DOCUMENTED_CHECKOUT_PAYLOAD_FILES)("%s never documents in_review", (file) => {
    for (const statuses of documentedExpectedStatuses(file)) {
      expect(statuses).not.toContain(FORBIDDEN_STATUS);
    }
  });
});
