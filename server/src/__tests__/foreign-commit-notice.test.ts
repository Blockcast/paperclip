/**
 * Foreign-commit detection (BLO-19528).
 *
 * These are pure tests: no database, no GitHub token, no network. The decision
 * boundary is the whole point of the feature -- the original filing's proposed
 * check was inverted and would have fired on every squash-merge and on the
 * assignee's own REST-path commits -- so each exclusion gets an explicit case.
 */

import { describe, expect, it } from "vitest";
import {
  agentUrlKeyFromAuthorEmail,
  buildForeignCommitNoticeBody,
  foreignCommitNoticeIdempotencyKey,
  resolveAgentByAuthorEmail,
  selectForeignCommits,
  type CommitAuthorRef,
  type NotifiableAgentRef,
} from "../services/foreign-commit-notice.js";

const CTO: NotifiableAgentRef = { id: "agent-cto", name: "CTO" };
const BACKEND: NotifiableAgentRef = { id: "agent-backend", name: "Backend Engineer Go" };
const SRE: NotifiableAgentRef = { id: "agent-sre", name: "Platform SRE Engineer" };
const AGENTS = [CTO, BACKEND, SRE];

function commit(overrides: Partial<CommitAuthorRef> & { sha: string }): CommitAuthorRef {
  return {
    authorEmail: "backend-engineer-go@paperclip.blockcast.net",
    authorName: "Backend Engineer Go",
    parentCount: 1,
    ...overrides,
  };
}

describe("agentUrlKeyFromAuthorEmail", () => {
  it("accepts the provisioned domain", () => {
    expect(agentUrlKeyFromAuthorEmail("platform-sre-engineer@paperclip.blockcast.net")).toBe(
      "platform-sre-engineer",
    );
  });

  it("accepts the legacy blockcast.net domain the #1292 witness carries", () => {
    expect(agentUrlKeyFromAuthorEmail("backend-engineer-go@blockcast.net")).toBe(
      "backend-engineer-go",
    );
  });

  it("is case and whitespace insensitive", () => {
    expect(agentUrlKeyFromAuthorEmail("  CTO@Paperclip.Blockcast.NET ")).toBe("cto");
  });

  it("rejects an unrelated domain so a human address cannot impersonate an agent", () => {
    expect(agentUrlKeyFromAuthorEmail("cto@example.invalid")).toBeNull();
    expect(agentUrlKeyFromAuthorEmail("cto@notblockcast.net")).toBeNull();
  });

  it("rejects a malformed address with an empty local part", () => {
    expect(agentUrlKeyFromAuthorEmail("@paperclip.blockcast.net")).toBeNull();
    expect(agentUrlKeyFromAuthorEmail("")).toBeNull();
    expect(agentUrlKeyFromAuthorEmail(null)).toBeNull();
  });
});

describe("resolveAgentByAuthorEmail", () => {
  it("inverts buildAgentGitIdentity's derivation, including spaced display names", () => {
    expect(
      resolveAgentByAuthorEmail("platform-sre-engineer@paperclip.blockcast.net", AGENTS)?.id,
    ).toBe(SRE.id);
    expect(resolveAgentByAuthorEmail("cto@paperclip.blockcast.net", AGENTS)?.id).toBe(CTO.id);
  });

  it("returns null for an address matching no agent in the company", () => {
    expect(resolveAgentByAuthorEmail("someone-else@paperclip.blockcast.net", AGENTS)).toBeNull();
  });

  it("fails closed on an ambiguous url key rather than naming the wrong teammate", () => {
    const ambiguous: NotifiableAgentRef[] = [
      { id: "a1", name: "Data Ops" },
      { id: "a2", name: "Data.Ops" },
    ];
    expect(resolveAgentByAuthorEmail("data-ops@paperclip.blockcast.net", ambiguous)).toBeNull();
  });
});

describe("selectForeignCommits", () => {
  it("AC(a): reports exactly one notice naming the committing identity and SHA", () => {
    const result = selectForeignCommits({
      commits: [commit({ sha: "d51b62a3aaaabbbbccccddddeeeeffff00001111" })],
      assigneeAgentId: CTO.id,
      agents: AGENTS,
    });

    expect(result.notify).toHaveLength(1);
    expect(result.notify[0]).toMatchObject({
      sha: "d51b62a3aaaabbbbccccddddeeeeffff00001111",
      agentId: BACKEND.id,
      agentName: "Backend Engineer Go",
    });
  });

  it("regression witness: #1292's d51b62a3 onto the CTO-assigned branch yields exactly one", () => {
    // The commit this feature exists to catch: a genuine per-agent `git push`
    // by BackendEngineerGo that landed on the CTO's branch.
    const result = selectForeignCommits({
      commits: [
        commit({
          sha: "d51b62a3",
          authorEmail: "backend-engineer-go@blockcast.net",
        }),
      ],
      assigneeAgentId: CTO.id,
      agents: AGENTS,
    });

    expect(result.notify).toHaveLength(1);
    expect(result.notify[0]?.agentId).toBe(BACKEND.id);
  });

  it("AC(b): the assignee's own commit produces no notice", () => {
    const result = selectForeignCommits({
      commits: [commit({ sha: "aaa111" })],
      assigneeAgentId: BACKEND.id,
      agents: AGENTS,
    });

    expect(result.notify).toHaveLength(0);
    expect(result.skipped).toEqual([{ sha: "aaa111", reason: "assignee_own_commit" }]);
  });

  it("AC(c): a merge commit produces no notice", () => {
    const result = selectForeignCommits({
      commits: [commit({ sha: "merge1", parentCount: 2 })],
      assigneeAgentId: CTO.id,
      agents: AGENTS,
    });

    expect(result.notify).toHaveLength(0);
    expect(result.skipped).toEqual([{ sha: "merge1", reason: "merge_commit" }]);
  });

  it("does not fire on a shared-App author: unattributable is not foreign", () => {
    // This is the inverted check from the original filing. An App-stamped
    // author is equally likely to be the assignee's own REST-path commit, so
    // reporting it would flag clean branches (4 hits on trafficcontrol#1326).
    const result = selectForeignCommits({
      commits: [
        commit({ sha: "app1", authorEmail: "allyblockcast[bot]@users.noreply.github.com" }),
        commit({
          sha: "app2",
          authorEmail: "290875700+allyblockcast[bot]@users.noreply.github.com",
        }),
      ],
      assigneeAgentId: CTO.id,
      agents: AGENTS,
    });

    expect(result.notify).toHaveLength(0);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      "shared_app_identity",
      "shared_app_identity",
    ]);
  });

  it("does not fire on an ordinary human contributor address", () => {
    const result = selectForeignCommits({
      commits: [commit({ sha: "human1", authorEmail: "omar@example.invalid" })],
      assigneeAgentId: CTO.id,
      agents: AGENTS,
    });

    expect(result.notify).toHaveLength(0);
    expect(result.skipped).toEqual([{ sha: "human1", reason: "unattributable_identity" }]);
  });

  it("deduplicates a replayed SHA within a single payload", () => {
    const result = selectForeignCommits({
      commits: [commit({ sha: "dupe" }), commit({ sha: "dupe" })],
      assigneeAgentId: CTO.id,
      agents: AGENTS,
    });

    expect(result.notify).toHaveLength(1);
  });

  it("reports each distinct foreign author on a mixed push", () => {
    const result = selectForeignCommits({
      commits: [
        commit({ sha: "s1", authorEmail: "backend-engineer-go@paperclip.blockcast.net" }),
        commit({ sha: "s2", authorEmail: "platform-sre-engineer@paperclip.blockcast.net" }),
        commit({ sha: "s3", authorEmail: "cto@paperclip.blockcast.net" }),
        commit({ sha: "s4", parentCount: 2 }),
      ],
      assigneeAgentId: CTO.id,
      agents: AGENTS,
    });

    expect(result.notify.map((c) => c.sha)).toEqual(["s1", "s2"]);
    expect(result.skipped).toEqual([
      { sha: "s3", reason: "assignee_own_commit" },
      { sha: "s4", reason: "merge_commit" },
    ]);
  });

  it("treats an unassigned issue as having no own-commits to exclude", () => {
    const result = selectForeignCommits({
      commits: [commit({ sha: "x1" })],
      assigneeAgentId: null,
      agents: AGENTS,
    });

    expect(result.notify).toHaveLength(1);
  });
});

describe("foreignCommitNoticeIdempotencyKey", () => {
  it("is stable across redelivery for the same (repo, pr, sha)", () => {
    const key = () =>
      foreignCommitNoticeIdempotencyKey({
        repoFullName: "Blockcast/trafficcontrol",
        prNumber: 1292,
        sha: "d51b62a3",
      });
    expect(key()).toBe(key());
    expect(key()).toBe("github-foreign-commit:Blockcast/trafficcontrol:1292:d51b62a3");
  });

  it("separates distinct commits and distinct PRs", () => {
    const base = { repoFullName: "Blockcast/trafficcontrol", prNumber: 1292 };
    expect(foreignCommitNoticeIdempotencyKey({ ...base, sha: "a" })).not.toBe(
      foreignCommitNoticeIdempotencyKey({ ...base, sha: "b" }),
    );
    expect(foreignCommitNoticeIdempotencyKey({ ...base, sha: "a" })).not.toBe(
      foreignCommitNoticeIdempotencyKey({ ...base, prNumber: 1326, sha: "a" }),
    );
  });
});

describe("buildForeignCommitNoticeBody", () => {
  it("names the committing identity, the short SHA, and the PR", () => {
    const body = buildForeignCommitNoticeBody({
      commit: {
        sha: "d51b62a3aaaabbbbccccddddeeeeffff00001111",
        agentId: BACKEND.id,
        agentName: "Backend Engineer Go",
        authorEmail: "backend-engineer-go@blockcast.net",
      },
      repoFullName: "Blockcast/trafficcontrol",
      prNumber: 1292,
      prUrl: "https://github.com/Blockcast/trafficcontrol/pull/1292",
    });

    expect(body).toContain("Backend Engineer Go");
    expect(body).toContain("d51b62a3aaaa");
    expect(body).toContain("backend-engineer-go@blockcast.net");
    expect(body).toContain("https://github.com/Blockcast/trafficcontrol/pull/1292");
  });

  it("degrades to a plain PR reference when no URL is available", () => {
    const body = buildForeignCommitNoticeBody({
      commit: {
        sha: "abc123",
        agentId: BACKEND.id,
        agentName: null,
        authorEmail: "backend-engineer-go@blockcast.net",
      },
      repoFullName: "Blockcast/trafficcontrol",
      prNumber: 1292,
      prUrl: null,
    });

    expect(body).toContain("Blockcast/trafficcontrol#1292");
    expect(body).toContain("backend-engineer-go@blockcast.net");
  });
});
