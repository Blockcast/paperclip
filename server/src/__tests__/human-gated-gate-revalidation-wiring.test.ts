/**
 * Wiring tests for the gate re-validation pass (BLO-30608).
 *
 * These deliberately drive the **real** `humanGatedAgeingProducer` against
 * seeded rows rather than calling the pure classifier, for the reason BLO-29420
 * exists: a 683-line module sat on master with 35 green tests and zero
 * production importers, because every test imported it directly and a test that
 * imports the module cannot tell wired from inert. The pure classifier is
 * covered separately in `human-gated-gate-revalidation.test.ts`; what is proved
 * here is that the producer actually runs the pass, actually withholds the rows
 * it resolves, and actually renders both sections.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  companies,
  companyMemberships,
  createDb,
  issueApprovals,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  humanGatedAgeingProducer,
  loadGateEvidence,
} from "../services/human-gated-ageing-digest.js";
import { logger } from "../middleware/logger.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres gate re-validation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const NOW = new Date("2026-08-28T12:00:00.000Z");
const HUMAN_USER_ID = "user_human_owner";

function daysAgo(days: number, from: Date = NOW): Date {
  return new Date(from.getTime() - days * 86_400_000);
}

describeEmbeddedPostgres("gate re-validation (wired into the digest producer)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-gate-revalidation-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueRelations);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  let nextIssueNumber = 5000;

  async function createCompany(prefix: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${prefix} Agent`,
      role: "engineer",
      status: "idle",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: HUMAN_USER_ID,
      status: "active",
      membershipRole: "owner",
    });
    return { companyId, agentId };
  }

  async function insertIssue(input: {
    companyId: string;
    identifier: string;
    status?: string;
    priority?: string;
    createdAt: Date;
    /** `undefined` means human-gated; pass `null` for an agent-owned row. */
    assigneeUserId?: string | null;
  }) {
    const id = randomUUID();
    nextIssueNumber += 1;
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      issueNumber: nextIssueNumber,
      identifier: input.identifier,
      title: `Title for ${input.identifier}`,
      status: input.status ?? "blocked",
      priority: input.priority ?? "critical",
      assigneeUserId: input.assigneeUserId === undefined ? HUMAN_USER_ID : input.assigneeUserId,
      originKind: "manual",
      originFingerprint: "default",
      createdAt: input.createdAt,
    });
    return id;
  }

  /** `issueId` is the blocker, `relatedIssueId` the blocked row. */
  async function blockWith(companyId: string, blockedId: string, blockerId: string) {
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedId,
      type: "blocks",
    });
  }

  async function linkApproval(companyId: string, issueId: string, status: string) {
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status,
      payload: { title: "Please decide" },
    });
    await db.insert(issueApprovals).values({ companyId, issueId, approvalId });
    return approvalId;
  }

  function collect(companyId: string) {
    return humanGatedAgeingProducer.collect({ db, companyId, now: NOW, logger });
  }

  it("loads blocker and approval evidence, and gives every row an entry", async () => {
    const { companyId } = await createCompany("GEV");
    const blocked = await insertIssue({ companyId, identifier: "GEV-1", createdAt: daysAgo(40) });
    const blocker = await insertIssue({
      companyId,
      identifier: "GEV-2",
      status: "done",
      createdAt: daysAgo(60),
    });
    await blockWith(companyId, blocked, blocker);
    const bare = await insertIssue({ companyId, identifier: "GEV-3", createdAt: daysAgo(40) });
    await linkApproval(companyId, bare, "pending");

    const evidence = await loadGateEvidence(db, companyId, [
      { id: blocked, identifier: "GEV-1" },
      { id: bare, identifier: "GEV-3" },
    ]);

    expect(evidence).toHaveLength(2);
    expect(evidence[0].blockers).toEqual([
      { blockerIssueId: blocker, blockerIdentifier: "GEV-2", blockerStatus: "done" },
    ]);
    // A row with no blockers gets an entry with empty evidence, not no entry —
    // a missing entry would drop it from the counts and understate exactly the
    // `unverifiable` number BLO-30608 asks us to measure.
    expect(evidence[1].blockers).toEqual([]);
    expect(evidence[1].approvals[0]).toMatchObject({ approvalStatus: "pending" });
  });

  it("withholds a resolved-but-open row from the age-ranked list and reports it separately", async () => {
    // The BLO-29399 shape: a critical row `blocked` by a blocker that has since
    // completed. Before this pass it aged forever, indistinguishable from a row
    // genuinely still waiting.
    const { companyId } = await createCompany("GRW");
    const stale = await insertIssue({ companyId, identifier: "GRW-1", createdAt: daysAgo(41) });
    const blocker = await insertIssue({
      companyId,
      identifier: "GRW-2",
      status: "done",
      createdAt: daysAgo(60),
      assigneeUserId: null,
    });
    await blockWith(companyId, stale, blocker);

    const section = await collect(companyId);
    expect(section).not.toBeNull();
    const markdown = section!.markdown;

    // Reported in its own section...
    expect(markdown).toContain("Resolved but still open — 1");
    expect(markdown).toContain("GRW-1 (41.0d silent)");
    expect(markdown).toContain("GRW-2=done");
    // ...and NOT aged as if still blocked.
    expect(markdown).toContain("Human-gated work past its human-silence threshold (0)");
  });

  it("names a cancelled blocker as a permanently stuck edge", async () => {
    // The sharpest case: dependency readiness resolves dependents on `done`
    // only, so this row can never be checked out again until an operator
    // clears the edge. Waiting cannot fix it, which is why the digest must say
    // so rather than just ageing it.
    const { companyId } = await createCompany("GRC");
    const stale = await insertIssue({ companyId, identifier: "GRC-1", createdAt: daysAgo(50) });
    const blocker = await insertIssue({
      companyId,
      identifier: "GRC-2",
      status: "cancelled",
      createdAt: daysAgo(60),
      assigneeUserId: null,
    });
    await blockWith(companyId, stale, blocker);

    const markdown = (await collect(companyId))!.markdown;
    expect(markdown).toContain("permanently un-checkoutable");
    expect(markdown).toContain("GRC-2=cancelled");
  });

  it("still ages a row whose blocker is genuinely open", async () => {
    const { companyId } = await createCompany("GRG");
    const stale = await insertIssue({ companyId, identifier: "GRG-1", createdAt: daysAgo(41) });
    const blocker = await insertIssue({
      companyId,
      identifier: "GRG-2",
      status: "in_progress",
      createdAt: daysAgo(60),
      assigneeUserId: null,
    });
    await blockWith(companyId, stale, blocker);

    const markdown = (await collect(companyId))!.markdown;
    expect(markdown).toContain("still-gated 1");
    expect(markdown).toContain("resolved-but-open 0");
    // The negative control for the test above: this row DOES stay in the age list.
    expect(markdown).toContain("Human-gated work past its human-silence threshold (1)");
    expect(markdown).toContain("GRG-1");
  });

  it("counts a row with no expressed gate as unverifiable and still ages it", async () => {
    const { companyId } = await createCompany("GRU");
    await insertIssue({ companyId, identifier: "GRU-1", createdAt: daysAgo(41) });

    const markdown = (await collect(companyId))!.markdown;
    expect(markdown).toContain("unverifiable 1");
    expect(markdown).toContain("express no machine-checkable gate");
    // Unverifiable is a finding, not a reason to withhold the row.
    expect(markdown).toContain("Human-gated work past its human-silence threshold (1)");
  });

  it("resolves the gate from a decided approval card without calling GitHub", async () => {
    // `approval-gate-reconciler.ts` already closes `gate.kind:
    // github_actions_run` cards when the run terminates, so reading the card's
    // status reuses that audited mechanism instead of building a second one.
    const { companyId } = await createCompany("GRA");
    const stale = await insertIssue({
      companyId,
      identifier: "GRA-1",
      status: "in_review",
      createdAt: daysAgo(41),
    });
    await linkApproval(companyId, stale, "approved");

    const markdown = (await collect(companyId))!.markdown;
    expect(markdown).toContain("Every linked approval has been decided");
    expect(markdown).toContain("Human-gated work past its human-silence threshold (0)");
  });

  it("keeps the row gated when a card is still pending", async () => {
    const { companyId } = await createCompany("GRP");
    const stale = await insertIssue({
      companyId,
      identifier: "GRP-1",
      status: "in_review",
      createdAt: daysAgo(41),
    });
    await linkApproval(companyId, stale, "pending");

    const markdown = (await collect(companyId))!.markdown;
    expect(markdown).toContain("still-gated 1");
    expect(markdown).toContain("Human-gated work past its human-silence threshold (1)");
  });

  it("emits a section for a resolved-but-open row even when nothing is overdue", async () => {
    // Withholding a row from the age list must never be able to make the whole
    // section vanish — that would be the false all-clear this seam refuses.
    const { companyId } = await createCompany("GRQ");
    const fresh = await insertIssue({ companyId, identifier: "GRQ-1", createdAt: daysAgo(1) });
    const blocker = await insertIssue({
      companyId,
      identifier: "GRQ-2",
      status: "done",
      createdAt: daysAgo(5),
      assigneeUserId: null,
    });
    await blockWith(companyId, fresh, blocker);

    const section = await collect(companyId);
    expect(section).not.toBeNull();
    expect(section!.markdown).toContain("Resolved but still open — 1");
  });

  it("mutates nothing: statuses and blocker edges are identical after a pass", async () => {
    // AC4. The pass reports; a human or an owning agent decides.
    const { companyId } = await createCompany("GRO");
    const stale = await insertIssue({ companyId, identifier: "GRO-1", createdAt: daysAgo(41) });
    const blocker = await insertIssue({
      companyId,
      identifier: "GRO-2",
      status: "cancelled",
      createdAt: daysAgo(60),
      assigneeUserId: null,
    });
    await blockWith(companyId, stale, blocker);

    const before = await db.select().from(issues);
    const edgesBefore = await db.select().from(issueRelations);

    await collect(companyId);

    const after = await db.select().from(issues);
    const edgesAfter = await db.select().from(issueRelations);
    expect(after).toEqual(before);
    expect(edgesAfter).toEqual(edgesBefore);
  });
});
