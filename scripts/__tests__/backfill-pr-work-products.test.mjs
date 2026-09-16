import assert from "node:assert/strict";
import { test } from "node:test";

import { namesIssue, prStatus } from "../ops/backfill-pr-work-products.mjs";

test("a PR must name the issue to count as its delivery artifact", () => {
  const id = "BLO-32239";
  assert.equal(namesIssue({ title: "feat(evidence): BLO-32239 truth shapes" }, id), true);
  assert.equal(namesIssue({ body: "Closes BLO-32239." }, id), true);
  assert.equal(namesIssue({ headRefName: "blo-32239-b8-b10" }, id), true);

  // The live dry run proposed both of these off a bare URL in prose. Linking
  // them would point the truth probe at somebody else's pull request.
  assert.equal(namesIssue({ title: "Bump controller-runtime", body: "upstream" }, id), false);
  assert.equal(namesIssue({}, id), false);

  // Bounded: a longer identifier sharing this prefix is a different issue.
  assert.equal(namesIssue({ title: "BLO-322391 unrelated" }, id), false);
});

test("the body arm accepts only a labeled owning reference, never bare prose", () => {
  const id = "BLO-32239";

  // The hazard this narrowing closes (BLO-20886). A sibling PR that merely
  // MENTIONS this issue is not this issue's delivery artifact — and because the
  // probe aggregates with `every` over what is typically the only linked row,
  // one wrong link either denies evidence the issue earned or grants both truth
  // shapes vacuously off somebody else's merged PR.
  assert.equal(namesIssue({ body: "Related: BLO-32239 — sibling under the same epic" }, id), false);
  assert.equal(namesIssue({ body: "Stacked on BLO-32239, do not merge first." }, id), false);
  assert.equal(namesIssue({ body: "See BLO-32239 for the plan." }, id), false);

  // The owning forms the webhook honours.
  for (const label of ["Fixes", "Closes", "Resolves", "Refs", "Issue", "Paperclip task"]) {
    assert.equal(namesIssue({ body: `${label}: ${id}` }, id), true, label);
  }
  assert.equal(namesIssue({ body: `- Refs: ${id}` }, id), true);
  assert.equal(namesIssue({ body: `intro\n\nCloses ${id}\n\noutro` }, id), true);

  // Title and branch stay unconditional — they carry no prose to confuse.
  assert.equal(namesIssue({ title: `wip ${id}`, body: "Related: BLO-1" }, id), true);
});

test("PR state maps onto the work-product status enum", () => {
  assert.equal(prStatus({ state: "MERGED" }), "merged");
  assert.equal(prStatus({ state: "CLOSED" }), "closed");
  assert.equal(prStatus({ state: "OPEN", isDraft: true }), "draft");
  assert.equal(prStatus({ state: "OPEN", isDraft: false }), "ready_for_review");
  // Draft wins over CLOSED: a closed draft is not a decision anyone made.
  assert.equal(prStatus({ state: "CLOSED", isDraft: true }), "draft");
});
