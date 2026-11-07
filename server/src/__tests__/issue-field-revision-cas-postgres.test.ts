import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { HttpError } from "../errors.js";

/**
 * PEN-5876 — the compare-and-set and the revision history for an issue's
 * scalar text field set, against a real database.
 *
 * These have to run here rather than against mocks. The guard is a WHERE-clause
 * equality re-evaluated by Postgres against the latest row version, and the
 * revision numbering depends on the `FOR UPDATE` row lock the update already
 * takes — neither is observable in a test that stubs the DB, and a mocked
 * version would stay green if the precondition matched nothing at all, which is
 * the failure mode this issue exists to prevent (a check that cannot fire reads
 * exactly like a check that passes).
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    "Skipping embedded Postgres issue field-revision tests on this host: "
    + (embeddedPostgresSupport.reason ?? "unsupported environment"),
  );
}

describeEmbeddedPostgres("issue title/description compare-and-set (PEN-5876)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-field-revision-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  });

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE issue_field_revisions, issues, heartbeat_runs, agents, companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(description = "original text") {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Carrier issue",
      description,
      status: "in_progress",
      priority: "medium",
    });
    return { companyId, issueId };
  }

  it("leaves an unguarded write unchecked, so phase 1 breaks no existing caller", async () => {
    const { issueId } = await seedIssue();
    const updated = await svc.update(issueId, { description: "written with no precondition" });
    expect(updated?.description).toBe("written with no precondition");
  });

  it("records a revision even when no precondition was supplied", async () => {
    // History must not be opt-in. A lost update is only detectable after the
    // fact if the history covers every writer, including the ones that never
    // asked to be guarded.
    const { issueId } = await seedIssue("text before anyone wrote");
    await svc.update(issueId, { description: "text after" });

    const revisions = await svc.listFieldRevisions(issueId);
    expect(revisions).toHaveLength(2);
    // Newest first.
    expect(revisions[0].revisionNumber).toBe(2);
    expect(revisions[0].description).toBe("text after");
    // The baseline seeded from the PRE-write state: the one revision anybody
    // actually wants back is the text that was just overwritten.
    expect(revisions[1].revisionNumber).toBe(1);
    expect(revisions[1].description).toBe("text before anyone wrote");
  });

  it("accepts a write whose base revision is still current", async () => {
    const { issueId } = await seedIssue();
    const first = await svc.update(issueId, { description: "first" });
    const base = first!.latestFieldRevisionId!;
    expect(base).toBeTruthy();

    const second = await svc.update(issueId, {
      description: "second",
      expectedCurrentFieldRevisionId: base,
    });
    expect(second?.description).toBe("second");
    expect(second?.latestFieldRevisionId).not.toBe(base);
    expect(second?.latestFieldRevisionNumber).toBe(3);
  });

  it("refuses a stale write with 409 stale_base_revision instead of overwriting", async () => {
    const { issueId } = await seedIssue();
    const first = await svc.update(issueId, { description: "first" });
    const staleBase = first!.latestFieldRevisionId!;

    // A sibling run writes in between — exactly the measured incident.
    await svc.update(issueId, { description: "the sibling's text" });

    await expect(
      svc.update(issueId, {
        description: "the text that would have clobbered the sibling",
        expectedCurrentFieldRevisionId: staleBase,
      }),
    ).rejects.toMatchObject({ status: 409 });

    // The decisive assertion: the sibling's content SURVIVED. A 409 that still
    // wrote would be worse than no guard at all.
    const after = await svc.getById(issueId);
    expect(after?.description).toBe("the sibling's text");
  });

  it("carries the current revision in the conflict details so a loser can rebase", async () => {
    const { issueId } = await seedIssue();
    const first = await svc.update(issueId, { description: "first" });
    const staleBase = first!.latestFieldRevisionId!;
    await svc.update(issueId, { description: "sibling" });

    let caught: unknown;
    try {
      await svc.update(issueId, {
        description: "mine",
        expectedCurrentFieldRevisionId: staleBase,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(HttpError);
    const details = (caught as HttpError).details as Record<string, unknown>;
    expect(details.code).toBe("stale_base_revision");
    expect(details.expectedRevisionId).toBe(staleBase);
    // "Write, and be told you lost" is only useful if the caller can then
    // re-read and retry without a second round trip.
    expect(details.latestRevisionId).toBeTruthy();
    expect(details.latestRevisionId).not.toBe(staleBase);
  });

  it("refuses any base revision on a row that has never been revised", async () => {
    const { issueId } = await seedIssue();
    await expect(
      svc.update(issueId, {
        description: "mine",
        expectedCurrentFieldRevisionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("accepts `null` as the base revision on a row that has never been revised", async () => {
    // Every row predating this feature has a NULL pointer, so this is the
    // common case rather than an edge one. `null` means "expect no revision
    // yet" and is enforced; omitting the field means unchecked. A guid-only
    // contract collapsed the two and left the first edit of every legacy row
    // unprotectable — any uuid is stale by construction against NULL, so two
    // runs that both read such a row could only write unguarded, which is the
    // exact lost update this issue was filed for. (Ally review of #3509.)
    const { issueId } = await seedIssue("legacy text");
    const before = await svc.getById(issueId);
    expect(before?.latestFieldRevisionId ?? null).toBeNull();

    const updated = await svc.update(issueId, {
      description: "first guarded edit of a legacy row",
      expectedCurrentFieldRevisionId: null,
    });
    expect(updated?.description).toBe("first guarded edit of a legacy row");
    expect(updated?.latestFieldRevisionId).toBeTruthy();
  });

  it("refuses the SECOND of two writers that both read a never-revised row", async () => {
    // The null arm has to be a real IS NULL test rather than an equality — and
    // it has to stop being satisfiable the moment a revision exists. If `null`
    // were merely accepted and not enforced, this second write would land.
    const { issueId } = await seedIssue("legacy text");

    await svc.update(issueId, {
      description: "writer A",
      expectedCurrentFieldRevisionId: null,
    });

    await expect(
      svc.update(issueId, {
        description: "writer B, from the same pre-revision read",
        expectedCurrentFieldRevisionId: null,
      }),
    ).rejects.toMatchObject({ status: 409 });

    const after = await svc.getById(issueId);
    expect(after?.description).toBe("writer A");
  });

  it("lets exactly one of two CONCURRENT writes against one base revision win", async () => {
    // Every other case in this file runs sequentially, which exercises the
    // pre-check and not the WHERE clause. The whole reason this suite needs a
    // real Postgres is that the guard is re-evaluated against the latest row
    // version when the statement blocks on a concurrent transaction — so one
    // test has to actually block on one. (Ally review of #3509.)
    const { issueId } = await seedIssue();
    const first = await svc.update(issueId, { description: "first" });
    const base = first!.latestFieldRevisionId!;

    const results = await Promise.allSettled([
      svc.update(issueId, { description: "racer A", expectedCurrentFieldRevisionId: base }),
      svc.update(issueId, { description: "racer B", expectedCurrentFieldRevisionId: base }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    // ⛔ The ONLY path that reaches the zero-matched-rows fallback. Every
    // precondition in the WHERE is also pre-checked against a read taken
    // BEFORE the row lock, so single-threaded the pre-check always fires
    // first — which is why this assertion cannot be made anywhere else in
    // this file, and why the branch that decides whether to stamp
    // `stale_base_revision` is only exercised here.
    const loserDetails = ((rejected[0] as PromiseRejectedResult).reason as HttpError)
      .details as Record<string, unknown>;
    expect(loserDetails.expectedRevisionId).toBe(base);
    expect(loserDetails.code).toBe("stale_base_revision");

    // The decisive assertion is not the 409 but that the winner's text is what
    // the row holds, and that the loser left no revision behind.
    const winner = (fulfilled[0] as PromiseFulfilledResult<any>).value;
    const after = await svc.getById(issueId);
    expect(after?.description).toBe(winner.description);
    expect(["racer A", "racer B"]).toContain(after?.description);

    const revisions = await svc.listFieldRevisions(issueId);
    expect(revisions[0].description).toBe(after?.description);
    expect(revisions.map((r) => r.revisionNumber)).toEqual([3, 2, 1]);
  });

  it("guards `title` on the same contract — description is not special", async () => {
    // The gap sits in `updateIssueSchema`, above any individual field, so a
    // description-only precondition would leave this race wide open.
    const { issueId } = await seedIssue();
    const first = await svc.update(issueId, { title: "first title" });
    const staleBase = first!.latestFieldRevisionId!;
    await svc.update(issueId, { title: "sibling title" });

    await expect(
      svc.update(issueId, { title: "mine", expectedCurrentFieldRevisionId: staleBase }),
    ).rejects.toMatchObject({ status: 409 });

    const after = await svc.getById(issueId);
    expect(after?.title).toBe("sibling title");
  });

  it("attributes each revision to the authoring run and agent", async () => {
    // The second measured instance was a write that landed and announced
    // itself on no row at all. Attribution survived only because the author
    // happened to self-attribute in prose and `executionRunId` happened not to
    // have been released yet — both luck, neither a record. Text-only history
    // answers "did I lose?"; only this column answers "whose text is this?".
    const { companyId, issueId } = await seedIssue();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Cto", role: "cto" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });

    await svc.update(issueId, {
      description: "written by a named run",
      actorAgentId: agentId,
      actorRunId: runId,
    });

    const revisions = await svc.listFieldRevisions(issueId);
    expect(revisions[0].description).toBe("written by a named run");
    expect(revisions[0].createdByRunId).toBe(runId);
    expect(revisions[0].createdByAgentId).toBe(agentId);
    // The lazily-seeded baseline predates any known author, so it claims none
    // rather than misattributing the prior text to this run.
    expect(revisions[1].revisionNumber).toBe(1);
    expect(revisions[1].createdByRunId).toBeNull();
  });

  it("records a revision for the pr_review dedupe rewrite, so a later stale PATCH is refused", async () => {
    // ⛔ `update:` is not the field set's only writer. The `pr_review` dedupe
    // branch in `create:` rewrites `title` and `description` on an EXISTING
    // row. Left out of the history it would leave `latest_field_revision_id`
    // pointing at the pre-rewrite revision, so a later PATCH carrying that id
    // as `baseRevisionId` MATCHES and overwrites text the compare-and-set was
    // meant to protect — a guard that reads as protection and is not one, which
    // is the exact end state this issue's rejected "harder rule" bullet warns
    // about. (Ally review of #3509.)
    const { companyId } = await seedIssue();
    const target = { repoFullName: "Blockcast/paperclip", prNumber: 4242 };
    // Identical head in both titles, so the dedupe branch takes no GitHub
    // round trip: this test is about the revision record, not the stale-head
    // guard that sits above it.
    const title = "Review Blockcast/paperclip PR #4242 exact head abc1234";

    const first = await svc.create(companyId, {
      title,
      description: "the first filing",
      status: "todo",
      priority: "medium",
      prReviewTarget: target,
    } as any);

    const baseAfterCreate = (await svc.getById(first.id))?.latestFieldRevisionId ?? null;

    // A duplicate filing for the same PR: dedupes onto the existing row and
    // rewrites its description.
    const second = await svc.create(companyId, {
      title,
      description: "the dedupe rewrite",
      status: "todo",
      priority: "medium",
      prReviewTarget: target,
    } as any);
    expect(second.id).toBe(first.id);

    const afterDedupe = await svc.getById(first.id);
    expect(afterDedupe?.description).toBe("the dedupe rewrite");

    // The pointer MOVED, and the pre-rewrite text is recoverable.
    expect(afterDedupe?.latestFieldRevisionId).not.toBe(baseAfterCreate);
    const revisions = await svc.listFieldRevisions(first.id);
    expect(revisions[0].description).toBe("the dedupe rewrite");
    expect(revisions.some((r) => r.description === "the first filing")).toBe(true);

    // And the consequence that makes it matter: a PATCH rebased on what the
    // row read BEFORE the dedupe is now refused rather than silently winning.
    if (baseAfterCreate) {
      await expect(
        svc.update(first.id, {
          description: "clobbers the dedupe rewrite",
          expectedCurrentFieldRevisionId: baseAfterCreate,
        }),
      ).rejects.toMatchObject({ status: 409 });
    } else {
      await expect(
        svc.update(first.id, {
          description: "clobbers the dedupe rewrite",
          expectedCurrentFieldRevisionId: null,
        }),
      ).rejects.toMatchObject({ status: 409 });
    }
    expect((await svc.getById(first.id))?.description).toBe("the dedupe rewrite");
  });

  it("does not record a revision for a write that touches neither field", async () => {
    const { issueId } = await seedIssue();
    await svc.update(issueId, { priority: "high" });
    expect(await svc.listFieldRevisions(issueId)).toHaveLength(0);
  });

  it("honours a base revision on a write that touches neither field", async () => {
    // A supplied precondition is never silently dropped. Accepting it, ignoring
    // it and answering 200 would be a payload doing something other than what
    // it said — the defect class this issue is about.
    const { issueId } = await seedIssue();
    const first = await svc.update(issueId, { description: "first" });
    const base = first!.latestFieldRevisionId!;

    // Still current: a status-only write carrying a live base revision passes.
    const ok = await svc.update(issueId, {
      priority: "high",
      expectedCurrentFieldRevisionId: base,
    });
    expect(ok?.priority).toBe("high");

    // Stale: the field moved under it, so the caller is told rather than
    // silently proceeding on an assumption that no longer holds.
    await svc.update(issueId, { description: "sibling" });
    await expect(
      svc.update(issueId, { priority: "low", expectedCurrentFieldRevisionId: base }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
