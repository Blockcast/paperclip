import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  approvals,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueApprovals,
  issueRelations,
  issueThreadInteractions,
  issues,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocked-inbox parity tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// `listBlockedInboxIssues` projects `substring(description, 1, ISSUE_LIST_DESCRIPTION_MAX_CHARS)`
// to bound payload size. Anything the blocked-inbox classifier reads out of a description has to
// survive that cutoff, so the fixtures below deliberately straddle it.
const ISSUE_LIST_DESCRIPTION_MAX_CHARS = 1200;

const EXTERNAL_WAIT_DECLARATION = [
  "External owner: Staging Traffic Ops operator",
  "External action: Approve and execute the one-off repair, then attach the audit trail.",
].join("\n");

/** A description whose external-wait declaration sits past the list projection's cutoff. */
function parkDeclaredLate(marker: string) {
  const preamble = `${marker} `.repeat(200);
  const body = preamble.slice(0, ISSUE_LIST_DESCRIPTION_MAX_CHARS + 200);
  return `${body}\n\n${EXTERNAL_WAIT_DECLARATION}\n`;
}

/** The same park, declared in the first line — inside the cutoff. */
function parkDeclaredEarly() {
  return `${EXTERNAL_WAIT_DECLARATION}\n\nContext follows.\n${"filler ".repeat(400)}`;
}

const EXTERNAL_OWNER = "Staging Traffic Ops operator";

/**
 * A late-declared park that also names the owner in prose *inside* the cutoff.
 *
 * This is the shape that makes the redaction contract observable. The `External owner:` /
 * `External action:` lines are past the projection cutoff either way, so line-stripping alone
 * cannot be caught — only a needle set carried from the classifier removes the owner from the
 * preview the response actually returns.
 */
function parkDeclaredLateWithOwnerNamedEarly() {
  const lede = `Waiting on the ${EXTERNAL_OWNER} to run the repair.`;
  const body = `${lede}\n${"context ".repeat(200)}`.slice(0, ISSUE_LIST_DESCRIPTION_MAX_CHARS + 200);
  return `${body}\n\n${EXTERNAL_WAIT_DECLARATION}\n`;
}

describeEmbeddedPostgres("blocked-inbox count/list parity (BLO-31839)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-inbox-parity-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 120_000);

  afterEach(async () => {
    await db.delete(workspaceOperations);
    await db.delete(issueThreadInteractions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

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
    return { companyId, agentId };
  }

  async function insertIssue(input: {
    companyId: string;
    identifier: string;
    title: string;
    status: string;
    parentId?: string | null;
    assigneeAgentId?: string | null;
    description?: string | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.title,
      status: input.status,
      priority: "medium",
      parentId: input.parentId ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
      originKind: "manual",
      originFingerprint: "default",
      description: input.description ?? null,
    });
    return id;
  }

  /**
   * Seeds the BLO-28618 shape: a blocked row parked on an external owner, whose only blocker is
   * *covered* by a live run. "Covered" is load-bearing — it means the `blocked_chain_stalled`
   * fallback does not fire, so the external-wait declaration is the sole reason the row belongs in
   * the blocked inbox. A row whose blocker reads `needs_attention` (BLO-16065) is caught by that
   * fallback on both paths and therefore hides this defect.
   */
  async function seedExternallyParkedRowWithCoveredBlocker(prefix: string, description: string) {
    const { companyId, agentId } = await createCompany(prefix);
    const parkedId = await insertIssue({
      companyId,
      identifier: `${prefix}-1`,
      title: "Externally parked parent",
      status: "blocked",
      assigneeAgentId: agentId,
      description,
    });
    const blockerId = await insertIssue({
      companyId,
      identifier: `${prefix}-2`,
      title: "Blocker with a live run",
      status: "todo",
      parentId: parkedId,
      assigneeAgentId: agentId,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: parkedId,
      type: "blocks",
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId: blockerId },
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, blockerId));
    return { companyId, parkedId };
  }

  it("counts and enumerates the same rows when a park is declared past the description cutoff", async () => {
    const { companyId, parkedId } = await seedExternallyParkedRowWithCoveredBlocker(
      "PKL",
      parkDeclaredLate("preamble"),
    );
    const filters = { attention: "blocked" as const, status: "blocked" };

    const [count, rows] = await Promise.all([
      svc.count(companyId, filters),
      svc.list(companyId, filters),
    ]);

    // The oracle and its own list must agree. Before BLO-31839 this read 1 vs 0: the count saw the
    // full description and classified the row `external_wait`, while the list saw only the first
    // 1200 characters, found no declaration, and dropped the row for having no attention at all.
    expect(count).toBe(rows.length);

    // Cardinality parity alone is satisfied by dropping the row on *both* sides, which would keep
    // the oracle honest while hiding a legitimately parked row from the inbox. Pin the row itself.
    expect(rows.map((row) => row.id)).toEqual([parkedId]);
    expect((rows[0] as { blockedInboxAttention?: { state?: string; reason?: string } }).blockedInboxAttention)
      .toMatchObject({ state: "external_wait", reason: "external_owner_action" });
  });

  it("classifies a park identically wherever it is declared in the description", async () => {
    const late = await seedExternallyParkedRowWithCoveredBlocker("PKA", parkDeclaredLate("preamble"));
    const early = await seedExternallyParkedRowWithCoveredBlocker("PKB", parkDeclaredEarly());
    const filters = { attention: "blocked" as const, status: "blocked" };

    const [lateRows, earlyRows] = await Promise.all([
      svc.list(late.companyId, filters),
      svc.list(early.companyId, filters),
    ]);

    // Position in the description is not part of the external-wait contract, so the two must be
    // indistinguishable. This is what makes the first test a position test rather than a
    // "does the marker exist at all" test.
    const state = (rows: typeof lateRows) =>
      (rows[0] as { blockedInboxAttention?: { state?: string } } | undefined)?.blockedInboxAttention?.state;
    expect(lateRows).toHaveLength(1);
    expect(earlyRows).toHaveLength(1);
    expect(state(lateRows)).toBe("external_wait");
    expect(state(earlyRows)).toBe(state(lateRows));
  });

  it("actually redacts the external owner it reports as redacted, on a late-declared park", async () => {
    const { companyId, parkedId } = await seedExternallyParkedRowWithCoveredBlocker(
      "PKR",
      parkDeclaredLateWithOwnerNamedEarly(),
    );

    const rows = await svc.list(companyId, { attention: "blocked" as const, status: "blocked" });
    expect(rows.map((row) => row.id)).toEqual([parkedId]);
    const row = rows[0] as {
      description?: string | null;
      blockedInboxAttention?: { redaction?: { externalDetailsRedacted?: boolean } };
    };

    // The response asserts the owner/action details were stripped...
    expect(row.blockedInboxAttention?.redaction?.externalDetailsRedacted).toBe(true);
    // ...so they have to actually be gone. Redaction used to re-derive its needles by re-parsing
    // the truncated preview, which returns `null` for a park declared past the cutoff — so for
    // exactly the population the parity fix surfaces, the flag was set and no value substitution
    // ran, returning the owner verbatim. The needles now come from the classifier's own parse.
    expect(row.description ?? "").not.toContain(EXTERNAL_OWNER);
    expect(row.description ?? "").toContain("[redacted external wait detail]");
  });

  it("keeps count and list in parity for a q term past the description cutoff", async () => {
    const marker = "zqxjlate";
    const { companyId } = await seedExternallyParkedRowWithCoveredBlocker("PKQ", parkDeclaredEarly());
    // Push a distinctive token past the cutoff on the same parked row.
    await db
      .update(issues)
      .set({ description: `${parkDeclaredEarly()}\n${"pad ".repeat(400)}\n${marker}\n` })
      .where(eq(issues.identifier, "PKQ-1"));

    const filters = { attention: "blocked" as const, status: "blocked", q: marker };
    const [count, rows] = await Promise.all([
      svc.count(companyId, filters),
      svc.list(companyId, filters),
    ]);

    // The blocked-inbox `q` filter runs over the row's *response* text, which is truncated. The
    // count previously searched the untruncated column, so a term past the cutoff was countable
    // but not enumerable — the mirror image of the external-wait divergence.
    expect(count).toBe(rows.length);
    // Pin the value, not just the parity: both sides are legitimately 0 here, so `count ===
    // rows.length` alone would also pass if a regression made this fixture return 1 on both
    // sides. The zero-zero control below runs on a different fixture and cannot catch that.
    expect(count).toBe(0);
  });

  it("keeps count and list in parity for a q term inside the description cutoff", async () => {
    const { companyId } = await seedExternallyParkedRowWithCoveredBlocker("PKI", parkDeclaredEarly());

    const filters = { attention: "blocked" as const, status: "blocked", q: "Context follows" };
    const [count, rows] = await Promise.all([
      svc.count(companyId, filters),
      svc.list(companyId, filters),
    ]);

    // Control for the test above: a term the list *can* match must be counted, so the parity
    // assertion there is not passing merely because both sides return zero.
    expect(count).toBe(rows.length);
    expect(count).toBe(1);
  });
});
