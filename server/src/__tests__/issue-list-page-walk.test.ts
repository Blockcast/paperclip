import { describe, expect, it } from "vitest";
import { walkIssueListPages } from "../routes/issues.js";

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
});
