import { randomUUID } from "node:crypto";
import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, approvals, companies, createDb, issueApprovals, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueApprovalService } from "../services/issue-approvals.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres link-coverage tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * PEN-5511. The sibling suite in `issue-approvals-service.test.ts` pins the three
 * VERDICTS `linkCoverageForIssue` can reach by mocking the query builder — which
 * means the SQL itself never runs there, and the SQL is where this report can be
 * wrong without any verdict looking wrong.
 *
 * Two clauses carry the whole candidate count, and a mock cannot exercise either:
 *
 *  1. The identifier boundary. `PEN-55` must not match a card that says `PEN-551`.
 *     A naive `LIKE '%' || id || '%'` passes every mocked test and then reports
 *     every card about rows 550-559 as a candidate for row 55 — an overcount in a
 *     report whose entire job is to be an honest bound.
 *  2. The `NOT EXISTS` exclusion. A card already linked to this row is not evidence
 *     of a gap; counting it would make `potentiallyUnlinkedCards` true for rows with
 *     perfect coverage, which trains readers to ignore the flag.
 *
 * So these run against real Postgres: the regex is a Postgres regex and the
 * exclusion is a correlated subquery, and neither means anything until one executes.
 */
describeEmbeddedPostgres("linkCoverageForIssue SQL (PEN-5511)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueApprovalService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-link-coverage-");
    db = createDb(tempDb.connectionString);
    svc = issueApprovalService(db);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const READABLE = { approvalReadAllowed: true } as const;

  /** `companies.issue_prefix` is globally unique, so a second company needs its own. */
  async function seedCompany(issuePrefix = "PEN") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Coverage Co ${issuePrefix}`,
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coverage Agent",
      role: "engineer",
      status: "idle",
    });
    return { companyId, agentId };
  }

  async function seedIssue(companyId: string, identifier: string | null) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      identifier,
      title: identifier ?? "Untitled",
      status: "in_progress",
      priority: "medium",
      originKind: "manual",
      originFingerprint: "default",
    });
    return id;
  }

  async function seedCard(
    companyId: string,
    agentId: string,
    payload: Record<string, unknown>,
    status = "pending",
  ) {
    const id = randomUUID();
    await db.insert(approvals).values({
      id,
      companyId,
      type: "request_board_approval",
      requestedByAgentId: agentId,
      status,
      payload,
    });
    return id;
  }

  async function link(companyId: string, issueId: string, approvalId: string) {
    await db.insert(issueApprovals).values({ companyId, issueId, approvalId });
  }

  it("counts a card that names the identifier and is not linked to the row", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue(companyId, "PEN-55");
    await seedCard(companyId, agentId, { title: "Escalation on PEN-55" });

    const coverage = await svc.linkCoverageForIssue(
      companyId,
      { id: issueId, identifier: "PEN-55" },
      READABLE,
    );

    expect(coverage.unlinkedMentionCandidateCount).toBe(1);
    expect(coverage.potentiallyUnlinkedCards).toBe(true);
    expect(coverage.basis).toBe("undecided_payload_identifier_mention");
  });

  it("does NOT count PEN-551 as a candidate for PEN-55", async () => {
    // The boundary the regex exists for. A substring match reports this as a gap on
    // PEN-55 that does not exist, and does so for every row whose number is a prefix
    // of another's — which in a tracker this size is most of them.
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue(companyId, "PEN-55");
    await seedCard(companyId, agentId, { title: "Unrelated ask about PEN-551" });
    await seedCard(companyId, agentId, { title: "Also unrelated: PEN-5511 and PEN-550" });

    const coverage = await svc.linkCoverageForIssue(
      companyId,
      { id: issueId, identifier: "PEN-55" },
      READABLE,
    );

    expect(coverage.unlinkedMentionCandidateCount).toBe(0);
    expect(coverage.potentiallyUnlinkedCards).toBe(false);
  });

  it("still matches the identifier inside JSON string and URL punctuation", async () => {
    // The payload is matched as `::text`, so the identifier is surrounded by JSON
    // quoting and, in practice, by URL separators. Those are boundaries, not
    // obstacles — a rule tightened to `\\m...\\M` style word edges would be fine, but
    // one written against bare whitespace would miss every card that cites a link.
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue(companyId, "PEN-55");
    await seedCard(companyId, agentId, {
      title: "See link",
      url: "https://paperclip.blockcast.net/PEN/issues/PEN-55",
    });

    const coverage = await svc.linkCoverageForIssue(
      companyId,
      { id: issueId, identifier: "PEN-55" },
      READABLE,
    );

    expect(coverage.unlinkedMentionCandidateCount).toBe(1);
  });

  it("excludes a card that is already linked to this row", async () => {
    // `NOT EXISTS`. A linked card is visible to the caller through the list itself,
    // so counting it as a candidate would report a gap that is already closed.
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue(companyId, "PEN-55");
    const linked = await seedCard(companyId, agentId, { title: "Linked ask on PEN-55" });
    await link(companyId, issueId, linked);

    const coverage = await svc.linkCoverageForIssue(
      companyId,
      { id: issueId, identifier: "PEN-55" },
      READABLE,
    );

    expect(coverage.linkedCount).toBe(1);
    expect(coverage.unlinkedMentionCandidateCount).toBe(0);
    expect(coverage.potentiallyUnlinkedCards).toBe(false);
  });

  it("counts a card linked to a DIFFERENT row, because that row is not this one", async () => {
    // The exclusion is per-issue, not global: a card attached to some other row can
    // still be a standing ask about this one. This is the PEN-5379 shape.
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue(companyId, "PEN-55");
    const otherIssueId = await seedIssue(companyId, "PEN-77");
    const card = await seedCard(companyId, agentId, { title: "Ask about PEN-55" });
    await link(companyId, otherIssueId, card);

    const coverage = await svc.linkCoverageForIssue(
      companyId,
      { id: issueId, identifier: "PEN-55" },
      READABLE,
    );

    expect(coverage.linkedCount).toBe(0);
    expect(coverage.unlinkedMentionCandidateCount).toBe(1);
  });

  it("scans only undecided cards, so a decided one is not a standing ask", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue(companyId, "PEN-55");
    await seedCard(companyId, agentId, { title: "Approved ask on PEN-55" }, "approved");
    await seedCard(companyId, agentId, { title: "Revision on PEN-55" }, "revision_requested");

    const coverage = await svc.linkCoverageForIssue(
      companyId,
      { id: issueId, identifier: "PEN-55" },
      READABLE,
    );

    // `revision_requested` is undecided and still standing; `approved` is answered.
    expect(coverage.unlinkedMentionCandidateCount).toBe(1);
  });

  it("does not reach across companies", async () => {
    const a = await seedCompany("PEN");
    const b = await seedCompany("OTH");
    const issueId = await seedIssue(a.companyId, "PEN-55");
    // Same identifier TEXT, different company. The prefixes differ only because the
    // column is globally unique — the card still literally says `PEN-55`, which is
    // what makes this a real test of the company predicate rather than of the regex.
    await seedCard(b.companyId, b.agentId, { title: "Other company, same text PEN-55" });

    const coverage = await svc.linkCoverageForIssue(
      a.companyId,
      { id: issueId, identifier: "PEN-55" },
      READABLE,
    );

    expect(coverage.unlinkedMentionCandidateCount).toBe(0);
  });

  it("runs no company-wide query for an actor outside the approval-read boundary", async () => {
    // Same seeded gap as the first case — one real candidate — but the actor may not
    // read approvals, so the answer is `null` rather than that count. Proving it
    // against a live database is the point: the row the oracle would have leaked
    // exists here.
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue(companyId, "PEN-55");
    await seedCard(companyId, agentId, { title: "Escalation on PEN-55" });

    const coverage = await svc.linkCoverageForIssue(
      companyId,
      { id: issueId, identifier: "PEN-55" },
      { approvalReadAllowed: false },
    );

    expect(coverage).toEqual({
      linkedCount: 0,
      unlinkedMentionCandidateCount: null,
      potentiallyUnlinkedCards: null,
      basis: "approval_read_unavailable",
    });
  });
});
