import { describe, it, expect, vi } from "vitest";
import { ensureProjectLink, markDuplicate } from "../src/linear.js";

// gql() (linear.ts:222) calls fetch(LINEAR_API, {..., body: JSON.stringify({query, variables})}),
// checks res.ok, then res.json() -> { data, errors }. Mock that contract.
function mockFetch(jsonResponses: unknown[]) {
  const fn = vi.fn();
  for (const r of jsonResponses) {
    fn.mockResolvedValueOnce({ ok: true, json: async () => r });
  }
  return fn as unknown as typeof fetch;
}

describe("markDuplicate", () => {
  it("creates a duplicate relation dupe -> keeper when none exists", async () => {
    const fetch = mockFetch([
      { data: { issue: { relations: { nodes: [] } } } },
      { data: { issueRelationCreate: { success: true, issueRelation: { id: "rel-1" } } } },
    ]);
    const res = await markDuplicate(fetch, "tok", "dupe-id", "keeper-id");
    expect(res).toEqual({ success: true, issueRelationId: "rel-1", alreadyRelated: false });
    const mutationBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    expect(mutationBody.variables).toEqual({
      input: { issueId: "dupe-id", relatedIssueId: "keeper-id", type: "duplicate" },
    });
  });

  it("is idempotent: existing duplicate relation -> no create, alreadyRelated=true", async () => {
    const fetch = mockFetch([
      { data: { issue: { relations: { nodes: [
        { id: "rel-x", type: "duplicate", relatedIssue: { id: "keeper-id" } },
      ] } } } },
    ]);
    const res = await markDuplicate(fetch, "tok", "dupe-id", "keeper-id");
    expect(res).toEqual({ success: true, issueRelationId: "rel-x", alreadyRelated: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rethrows non-duplicate API errors", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { issue: { relations: { nodes: [] } } } }) })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" }) as unknown as typeof fetch;
    await expect(markDuplicate(fetch, "tok", "d", "k")).rejects.toThrow(/Linear API error: 500/);
  });

  it("handles race: create returns a duplicate-error after the pre-check passed", async () => {
    // pre-check sees no relation, then the create mutation loses a race and the
    // API reports it already exists -> swallow as idempotent success (id null).
    const fetch = mockFetch([
      { data: { issue: { relations: { nodes: [] } } } },
      { data: null, errors: [{ message: "Issue relation already exists" }] },
    ]);
    const res = await markDuplicate(fetch, "tok", "dupe-id", "keeper-id");
    expect(res).toEqual({ success: true, issueRelationId: null, alreadyRelated: true });
  });
});

describe("ensureProjectLink", () => {
  it("creates a Linear project link when no existing Paperclip link is present", async () => {
    const fetch = mockFetch([
      { data: { project: { externalLinks: { nodes: [] } } } },
      {
        data: {
          entityExternalLinkCreate: {
            success: true,
            entityExternalLink: {
              id: "plink-1",
              url: "https://paperclip.blockcast.net/BLO/projects/sync",
              label: "Paperclip project",
            },
          },
        },
      },
    ]);

    const res = await ensureProjectLink(fetch, "tok", {
      projectId: "lin-proj-1",
      url: "https://paperclip.blockcast.net/BLO/projects/sync",
      label: "Paperclip project",
    });

    expect(res.created).toBe(true);
    const mutationBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    expect(mutationBody.variables.input).toEqual({
      projectId: "lin-proj-1",
      url: "https://paperclip.blockcast.net/BLO/projects/sync",
      label: "Paperclip project",
    });
  });

  it("updates an existing Paperclip project link when the URL changed", async () => {
    const fetch = mockFetch([
      {
        data: {
          project: {
            externalLinks: {
              nodes: [
                {
                  id: "plink-1",
                  url: "https://paperclip.blockcast.net/BLO/projects/old",
                  label: "Paperclip project",
                },
              ],
            },
          },
        },
      },
      {
        data: {
          entityExternalLinkUpdate: {
            success: true,
            entityExternalLink: {
              id: "plink-1",
              url: "https://paperclip.blockcast.net/BLO/projects/new",
              label: "Paperclip project",
            },
          },
        },
      },
    ]);

    const res = await ensureProjectLink(fetch, "tok", {
      projectId: "lin-proj-1",
      url: "https://paperclip.blockcast.net/BLO/projects/new",
      label: "Paperclip project",
    });

    expect(res.updated).toBe(true);
    const mutationBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    expect(mutationBody.variables).toEqual({
      id: "plink-1",
      input: {
        url: "https://paperclip.blockcast.net/BLO/projects/new",
        label: "Paperclip project",
      },
    });
  });
});
