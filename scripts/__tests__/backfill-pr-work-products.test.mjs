import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFile = promisify(execFileCb);

import {
  listAllIssues,
  namesIssue,
  prStatus,
  repoFromUrl,
  workProductBody,
} from "../ops/backfill-pr-work-products.mjs";

test("the written row keys off GitHub's repo casing, not the comment's", () => {
  // The dedup that matters is the webhook's, not this script's: the local `have`
  // set lowercases both sides, but upsertByExternalId matches by exact text, so
  // a row written with the comment's casing gets a second row beside it on the
  // next PR event.
  const pr = {
    title: "t",
    url: "https://github.com/Blockcast/paperclip/pull/1874",
    state: "OPEN",
    isDraft: false,
    headRefOid: "abc",
  };
  const body = workProductBody(pr, { repo: "blockcast/paperclip", number: 1874 });

  assert.equal(body.externalId, "Blockcast/paperclip#1874");
  assert.equal(body.metadata.repoFullName, "Blockcast/paperclip");
  assert.equal(body.status, "ready_for_review");
  assert.equal(body.metadata.merged, false);

  // A row with the comment's casing still beats no row.
  const noUrl = workProductBody({ ...pr, url: undefined }, { repo: "blockcast/paperclip", number: 1874 });
  assert.equal(noUrl.externalId, "blockcast/paperclip#1874");
});

// The cap is invisible — the route returns a bare array with no total and no
// cursor — and a re-run without `offset` replays the identical page, which is
// the remedy the old warning named. Paging is the only way to reach the tail.
test("the issue list is paged until a short page, not fetched once", async () => {
  const pages = [["a", "b"], ["c", "d"], ["e"]];
  const asked = [];
  const all = await listAllIssues((offset) => {
    asked.push(offset);
    return pages[offset / 2] ?? [];
  }, 2);

  assert.deepEqual(all, ["a", "b", "c", "d", "e"]);
  assert.deepEqual(asked, [0, 2, 4]);
});

test("a full last page still asks once more, and an empty page stops", async () => {
  // length === limit is indistinguishable from "there is more", so the loop
  // must not treat an exactly-full final page as the end.
  const asked = [];
  const all = await listAllIssues((offset) => {
    asked.push(offset);
    return offset === 0 ? ["a", "b"] : [];
  }, 2);

  assert.deepEqual(all, ["a", "b"]);
  assert.deepEqual(asked, [0, 2]);
});

test("the repo comes from GitHub's URL casing, not the comment's", () => {
  // The webhook keys externalId off `repository.full_name` and matches it by
  // exact text, so a lowercased URL in a comment must not produce a second row.
  assert.equal(repoFromUrl("https://github.com/Blockcast/paperclip/pull/1874"), "Blockcast/paperclip");
  assert.equal(repoFromUrl("http://github.com/Blockcast/onprem-k8s/pull/1"), "Blockcast/onprem-k8s");
  assert.equal(repoFromUrl("https://github.com/Blockcast/paperclip/issues/1874"), null);
  assert.equal(repoFromUrl(undefined), null);
});

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

test("the body arm inherits the three defenses a merged-pattern copy dropped", () => {
  const id = "BLO-32239";

  // 1. The house labels require a colon; the closing verbs do not. An earlier
  // revision folded both alternations under one optional-colon pattern, which
  // linked off ordinary English — `Issue` is a noun as well as a label.
  assert.equal(namesIssue({ body: `Issue filed a related bug, see ${id}` }, id), false);
  assert.equal(namesIssue({ body: `Issue description for ${id} is attached.` }, id), false);

  // 2. Fenced code declares nothing a reader can see. Both forms matter: a
  // root-level fence and one nested in a list item — this repo's own issue
  // bodies quote example PR bodies in exactly the second shape.
  assert.equal(namesIssue({ body: "```\nRefs: " + id + "\n```" }, id), false);
  assert.equal(namesIssue({ body: "- Example body:\n  ```md\n  Refs: " + id + "\n  ```" }, id), false);

  // 3. A trailing non-owning label on the same line owns nothing: the owning
  // reference is BLO-1, and this issue is explicitly marked `Related`.
  assert.equal(namesIssue({ body: `Refs: BLO-1; Related: ${id}` }, id), false);
  assert.equal(namesIssue({ body: `Closes BLO-1, see also: ${id}` }, id), false);

  // Controls: the narrowing above must not cost recall on the real forms.
  assert.equal(namesIssue({ body: `Fixes: ${id}` }, id), true);
  assert.equal(namesIssue({ body: `Closes ${id}` }, id), true);
  assert.equal(namesIssue({ body: `Issue: ${id}` }, id), true);
  assert.equal(namesIssue({ body: `- Refs: ${id}` }, id), true);
});

test("PR state maps onto the work-product status enum", () => {
  assert.equal(prStatus({ state: "MERGED" }), "merged");
  assert.equal(prStatus({ state: "CLOSED" }), "closed");
  assert.equal(prStatus({ state: "OPEN", isDraft: true }), "draft");
  assert.equal(prStatus({ state: "OPEN", isDraft: false }), "ready_for_review");
  // CLOSED wins over draft: a closed draft is abandoned work, and reporting it
  // as `draft` puts a permanently-stale live-looking row in front of a human.
  assert.equal(prStatus({ state: "CLOSED", isDraft: true }), "closed");
  // MERGED still wins over both — GitHub reports isDraft on merged PRs too.
  assert.equal(prStatus({ state: "MERGED", isDraft: true }), "merged");
});

// The module tail has now been the subject of two review findings — first a
// silent-green module guard, then an unbraced `if` that re-parented that
// guard's `else` and printed "no backfill performed" under every clean run,
// directly beneath the counts the runbook tells the operator to read. Both
// shipped under a green CI because nothing executed the script end to end.
// A stub API with no issues is enough: it reaches the tail on the RUN=true
// path, which is the only path either finding was ever on.
test("a real invocation prints the summary and NOT the module-guard message", async () => {
  const paths = [];
  // A FULL first page for one status is what forces a second iteration. With
  // every page empty the loop exits at offset=0 and an unpaged call site is
  // indistinguishable from a paging one — which is what the previous revision
  // of this test asserted, and it proved nothing.
  const PAGE = 1000; // LIMIT in the script; a full page is `=== limit`
  const fullPage = JSON.stringify(
    Array.from({ length: PAGE }, (_, i) => ({ id: `i${i}`, identifier: `BLO-${i}` })),
  );
  const server = createServer((req, res) => {
    paths.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(/status=in_review&.*offset=0\b/.test(req.url) ? fullPage : "[]");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const script = fileURLToPath(new URL("../ops/backfill-pr-work-products.mjs", import.meta.url));
    const { stdout, stderr } = await execFile(process.execPath, [script], {
      env: {
        ...process.env,
        PAPERCLIP_API_URL: `http://127.0.0.1:${server.address().port}`,
        PAPERCLIP_API_KEY: "test",
        PAPERCLIP_COMPANY_ID: "test",
      },
    });
    assert.match(stdout, /^done: created=0 would-create=0 /m);
    assert.doesNotMatch(stderr, /no backfill performed/);
    // The pager unit tests above pass even if the loop is never wired in. This
    // is the one assertion that the SHIPPED path pages: the `offset=1000` entry
    // exists only because the full first page sent the loop round again, so
    // replacing the call site with a single unpaged fetch fails here — and
    // fails nowhere else. Mutation-tested; re-run that mutation before trusting
    // any future edit to this case.
    const offsets = paths
      .filter((p) => p.includes("/issues?status="))
      .map((p) => new URL(p, "http://x").searchParams.get("offset"));
    assert.deepEqual(offsets, ["0", "1000", "0", "0"], paths.slice(0, 8).join(" "));
  } finally {
    server.close();
  }
});

// The control for the case above: imported rather than invoked, the guard
// message is the correct output. Without this, deleting the `else` entirely
// would pass the assertion above.
test("imported rather than invoked, the module guard reports it did nothing", async () => {
  const entry = fileURLToPath(new URL("../ops/backfill-pr-work-products.mjs", import.meta.url));
  const { stdout, stderr } = await execFile(process.execPath, [
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(pathToFileURL(entry).href)});`,
  ]);
  assert.match(stderr, /no backfill performed/);
  assert.doesNotMatch(stdout, /^done:/m);
});
