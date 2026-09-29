import { describe, expect, it } from "vitest";
import { WALK_MAX_PAGES, walkIssueListPages } from "../routes/issues.js";

const rows = Array.from({ length: 5 }, (_, index) => ({ id: `issue-${index}` }));

/** Serves pages the way listBlockedInboxIssues does: by offset only, ignoring afterId. */
function offsetOnlyFetcher() {
  let calls = 0;
  return async (page: { offset?: number; afterId?: string }) => {
    calls += 1;
    // A walk that never advances would spin forever; fail loudly instead.
    if (calls > rows.length + 2) throw new Error("walk did not advance");
    const offset = page.offset ?? 0;
    return rows.slice(offset, offset + 2);
  };
}

/** Serves pages by keyset over the id order, the general listing path. */
async function keysetFetcher(page: { offset?: number; afterId?: string }) {
  const start = page.afterId === undefined ? 0 : rows.findIndex((row) => row.id === page.afterId) + 1;
  return rows.slice(start, start + 2);
}

describe("walkIssueListPages", () => {
  it("advances by offset on the blocked path, whose listing ignores afterId", async () => {
    const seen: string[] = [];
    await walkIssueListPages(offsetOnlyFetcher(), { blocked: true, pageSize: 2 }, async (page) => {
      seen.push(...page.map((row) => row.id));
    });
    expect(seen).toEqual(rows.map((row) => row.id));
  });

  it("advances by keyset cursor on the general path", async () => {
    const seen: string[] = [];
    await walkIssueListPages(keysetFetcher, { blocked: false, pageSize: 2 }, async (page) => {
      seen.push(...page.map((row) => row.id));
    });
    expect(seen).toEqual(rows.map((row) => row.id));
  });

  // The two below drive the blocked/general mapping out of agreement with the listing it
  // mirrors — the failure a change to list()'s routing would introduce silently, across a
  // file boundary, with no conflict and no type error. Both must surface as a rejection:
  // the walk feeds a count endpoint, so the untended failure is a request that never
  // returns and a connection held open, not a wrong number.
  //
  // Each fetcher caps its own calls, and that cap is load-bearing rather than defensive.
  // Without the guard these walks do not merely run long: every iteration awaits an
  // already-resolved promise, so the loop never yields to the event loop and vitest's
  // timeout — a timer — can never fire. The suite hangs instead of failing. The cap makes
  // the unguarded case raise a DIFFERENT error, so the assertions below are on the guard's
  // own message and stay red-in-bounded-time when the guard is reverted.
  const capped = (serve: (page: { offset?: number; afterId?: string }) => Array<{ id: string }>) => {
    let calls = 0;
    return async (page: { offset?: number; afterId?: string }) => {
      calls += 1;
      if (calls > rows.length + 2) throw new Error("walk did not advance");
      return serve(page);
    };
  };

  it("throws rather than spinning when the general path's afterId never reaches list()", async () => {
    // An early return added to list() above its afterId predicate looks exactly like this:
    // the cursor is accepted and ignored, so page one comes back forever.
    await expect(
      walkIssueListPages(capped(() => rows.slice(0, 2)), { blocked: false, pageSize: 2 }, async () => {}),
    ).rejects.toThrow(/keyset cursor did not advance/);
  });

  it("throws rather than spinning when the blocked path's offset never reaches list()", async () => {
    // The route builds the blocked page args separately from the walk's `blocked` flag;
    // dropping `offset` there strands the walk on page one just as completely.
    await expect(
      walkIssueListPages(capped(() => rows.slice(0, 2)), { blocked: true, pageSize: 2 }, async () => {}),
    ).rejects.toThrow(/blocked page repeated/);
  });

  it("does not mistake a re-ranked repeat row on the blocked path for a stalled walk", async () => {
    // The blocked listing orders by mutable activity, so a row touched mid-walk can
    // legitimately reappear on the next page. Only a wholly identical page is a stall,
    // which is why the guard compares the page rather than its last id.
    const pages = [
      [{ id: "a" }, { id: "b" }],
      [{ id: "b" }, { id: "c" }],
      [{ id: "d" }],
    ];
    const seen: string[] = [];
    let call = 0;
    await walkIssueListPages(async () => pages[call++] ?? [], { blocked: true, pageSize: 2 }, async (page) => {
      seen.push(...page.map((row) => row.id));
    });
    expect(seen).toEqual(["a", "b", "b", "c", "d"]);
  });

  it("caps the walk when differing blocked pages never run out", async () => {
    // The blocked assertion only compares CONSECUTIVE pages, so a dropped `offset` plus
    // churn at the head of the mutable activity order serves a different full page every
    // time and slips past it. Nothing about the cursor is wrong here — the sequence simply
    // never ends — which is why the per-branch guards cannot catch this and a cap must.
    //
    // The fetcher caps itself for the same reason the two above do, just at a bound above
    // the cap under test: without it, reverting the cap does not fail this test, it HANGS
    // it. Every iteration awaits an already-resolved promise, so the loop never yields and
    // vitest's timer-based timeout cannot fire. Verified: uncapped, the mutation ran past
    // 90s with no output; capped, it fails on the wrong error in milliseconds.
    //
    // Both this bound and the expected message derive from WALK_MAX_PAGES so that tuning it
    // cannot silently invert what a red run means. The guard checks `page >= WALK_MAX_PAGES`
    // BEFORE fetching, so page indices 0..WALK_MAX_PAGES-1 issue exactly WALK_MAX_PAGES
    // calls and the throw lands on the next iteration with no further call; +2 clears that.
    const selfCap = WALK_MAX_PAGES + 2;
    let calls = 0;
    const neverEnding = async () => {
      calls += 1;
      if (calls > selfCap) throw new Error("walk ran past the page cap");
      return [{ id: `row-${calls}-a` }, { id: `row-${calls}-b` }];
    };
    await expect(
      walkIssueListPages(neverEnding, { blocked: true, pageSize: 2 }, async () => {}),
    ).rejects.toThrow(new RegExp(`exceeded ${WALK_MAX_PAGES} pages`));
  });
});
