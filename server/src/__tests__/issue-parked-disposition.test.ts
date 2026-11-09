import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * PEN-6129: the park had two vocabularies and they did not overlap.
 *
 * `PATCH /api/issues/:id` accepts `parkedDisposition: {reason, until}` and REFUSES all
 * four flat keys; both read surfaces carried only the flat `parked_*` columns and never
 * `parkedDisposition`. So the obvious post-write check — write the nested key, GET, read
 * it back — was not a weak predicate but a CONSTANT: the key was absent on a parked row
 * and an unparked row alike, `jq` / `.get()` / optional chaining render absent as `null`,
 * and the standing defence against this class ("gate on key presence, not on value")
 * could not reach it either, because `has("parkedDisposition")` was false for BOTH
 * states. Measured 2026-11-08: a reader took `parkedDisposition: null` on a parked row to
 * mean the park was gone, and built a second claim — an invented sweep that had supposedly
 * dropped it — on top of the false reading.
 *
 * These tests assert the PAIR of read surfaces, not the new key on one of them, for the
 * reason `issue-list-monitor-status.test.ts` does: PEN-5481 shipped `monitorStatus` on the
 * list alone and PEN-5935 had to come back for the single-issue read, because a test that
 * exercises one arm passes on a tree where the other has been dropped. `list` and
 * `getById`/`getByIdentifier` derive this key from one function, and every assertion below
 * compares them rather than each against a literal.
 */
describeEmbeddedPostgres("parkedDisposition reads back under the name it is written with (PEN-6129)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  const PARKED_UNTIL = new Date("2099-03-01T09:00:00.000Z");
  const LAPSED_UNTIL = new Date("2020-03-01T09:00:00.000Z");
  const PARK_REASON = "Waiting on a human merge click on Blockcast/paperclip#3457.";

  // `[label, seeded park columns]`. Seeded directly so the LAPSED and HALF-WRITTEN shapes
  // are reachable at all: the real writer cannot produce either (it rejects a past `until`
  // and always writes both columns), and they are exactly the shapes a reader meets on a
  // row whose park has expired or whose columns drifted.
  const seeded: Array<[string, { parkedUntil: Date | null; parkedReason: string | null }]> = [
    ["unparked", { parkedUntil: null, parkedReason: null }],
    ["park lapsed", { parkedUntil: LAPSED_UNTIL, parkedReason: "Expired park, columns retained." }],
    ["park half-written", { parkedUntil: PARKED_UNTIL, parkedReason: null }],
  ];

  const issueIdByLabel = new Map<string, string>();
  /** The row parked through the REAL writer, not seeded. */
  let writtenParkIssueId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-parked-disposition-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Parked Disposition",
      issuePrefix: "PKD",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({ id: agentId, companyId, name: "Park Bot", role: "engineer" });

    for (const [index, [label, park]] of seeded.entries()) {
      const [row] = await db
        .insert(issues)
        .values({
          companyId,
          title: label,
          status: "in_progress",
          assigneeAgentId: agentId,
          // Set explicitly: nullable with no default, and the raw insert bypasses the
          // create path that normally allocates them. `getByIdentifier` is the branch
          // agents actually take — `paperclipGetIssue("PEN-6129")`, not a UUID.
          issueNumber: index + 1,
          identifier: `PKD-${index + 1}`,
          ...park,
          ...(park.parkedUntil ? { parkedAt: new Date("2026-11-08T00:00:00.000Z"), parkedByAgentId: agentId } : {}),
        })
        .returning();
      issueIdByLabel.set(label, row!.id);
    }

    const [written] = await db
      .insert(issues)
      .values({
        companyId,
        title: "park written through the real writer",
        status: "in_progress",
        assigneeAgentId: agentId,
        issueNumber: seeded.length + 1,
        identifier: `PKD-${seeded.length + 1}`,
      })
      .returning();
    writtenParkIssueId = written!.id;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // The defect in its original form: write the park with the only name the write route
  // accepts, then ask for it back by that name. Before PEN-6129 this read `undefined` on
  // every surface, on every row, forever. Driven through `issueService.update` rather than
  // seeded columns, because the round trip IS the claim — a test over seeded columns would
  // pass on a tree where the writer and the reader had drifted apart.
  it("round-trips a park written with parkedDisposition back under parkedDisposition", async () => {
    const svc = issueService(db);
    const until = new Date(Date.now() + 60 * 60 * 1000);
    await svc.update(writtenParkIssueId, {
      parkedDisposition: { reason: PARK_REASON, until: until.toISOString() },
      actorAgentId: agentId,
    });

    const issue = await svc.getById(writtenParkIssueId);
    expect(issue).not.toBeNull();
    expect(issue!.parkedDisposition).toEqual({ reason: PARK_REASON, until });

    // Two names, one value — not two independently-maintained copies. If these ever
    // disagree the surface has three vocabularies rather than one.
    expect(issue!.parkedDisposition!.until).toEqual(issue!.parkedUntil);
    expect(issue!.parkedDisposition!.reason).toBe(issue!.parkedReason);

    // And the un-park, by the same name, observed the same way.
    await svc.update(writtenParkIssueId, { parkedDisposition: null, actorAgentId: agentId });
    const unparked = await svc.getById(writtenParkIssueId);
    expect(unparked).toHaveProperty("parkedDisposition");
    expect(unparked!.parkedDisposition).toBeNull();
  });

  // `null` here means "no park is recorded on this row", and an ABSENT key renders as
  // `null` through every reader the fleet uses. So the only thing that can separate the
  // two is key presence — which is what the published contract tells callers to gate on,
  // and what neither read surface could satisfy for this name.
  it("reports an unparked row as a present key holding null, not as an absent key", async () => {
    const unparked = await issueService(db).getById(issueIdByLabel.get("unparked")!);
    expect(unparked).toHaveProperty("parkedDisposition");
    expect(Object.keys(unparked!)).toContain("parkedDisposition");
    expect(unparked!.parkedDisposition).toBeNull();
  });

  it("is present on every list row", async () => {
    const rows = await issueService(db).list(companyId);
    expect(rows.length).toBe(seeded.length + 1);
    for (const row of rows) {
      // `toHaveProperty` is the load-bearing assertion: comparing against null would pass
      // on the absent key that IS the defect.
      expect(row, `list projection for ${row.title}`).toHaveProperty("parkedDisposition");
    }
  });

  it("answers identically on the list and single-issue surfaces for every stored shape", async () => {
    const rows = await issueService(db).list(companyId);
    const listById = new Map(rows.map((row) => [row.id, row]));
    for (const [label] of seeded) {
      const id = issueIdByLabel.get(label)!;
      const listRow = listById.get(id)!;
      const issue = await issueService(db).getById(id);
      expect(issue, `getById returned no row for ${label}`).not.toBeNull();
      expect(issue, `single-issue projection for ${label}`).toHaveProperty("parkedDisposition");
      // Stated as a direct comparison so a future divergence names the two surfaces
      // rather than one of them and a literal.
      expect(issue!.parkedDisposition, `surfaces disagree for ${label}`).toEqual(listRow.parkedDisposition);
    }
  });

  // The identifier path is a second entry point into the same getter pair, and it is the
  // one agents actually use. It has its own `return`, so it could be fixed on one branch
  // and left on the other — which is how PEN-5935's sibling defect survived.
  it("answers identically when the row is fetched by identifier", async () => {
    const rows = await issueService(db).list(companyId);
    const listById = new Map(rows.map((row) => [row.id, row]));
    for (const [label] of seeded) {
      const id = issueIdByLabel.get(label)!;
      const identifier = listById.get(id)!.identifier!;
      expect(identifier).toBeTruthy();
      const byIdentifier = await issueService(db).getByIdentifier(identifier);
      expect(byIdentifier, `getByIdentifier returned no row for ${label}`).not.toBeNull();
      expect(byIdentifier!.id).toBe(id);
      expect(byIdentifier!.parkedDisposition, `identifier projection for ${label}`)
        .toEqual(listById.get(id)!.parkedDisposition);
    }
  });

  // ⚠️ NON-NULL MEANS RECORDED, NOT ACTIVE, and that is deliberate. Park expiry does not
  // clear the columns (`services/issue-park-expiry.ts`), so a lapsed park is still
  // described by the row — and this key mirrors the columns exactly. Making it null on a
  // lapsed park would have the two names disagree about the same row, which is the defect
  // this closes, reopened one state at a time. Suppression is `parkedUntil` in the future
  // (`isDeliberateParkActive`), on either name, and nothing here precomputes it.
  it("mirrors the columns on a LAPSED park rather than hiding it", async () => {
    const id = issueIdByLabel.get("park lapsed")!;
    const issue = await issueService(db).getById(id);
    expect(issue!.parkedUntil).toEqual(LAPSED_UNTIL);
    expect(issue!.parkedDisposition).not.toBeNull();
    expect(issue!.parkedDisposition!.until).toEqual(issue!.parkedUntil);

    const listRow = (await issueService(db).list(companyId)).find((row) => row.id === id)!;
    expect(listRow.parkedDisposition).toEqual(issue!.parkedDisposition);
  });

  // The projection keys on `parkedUntil` ALONE, so it agrees with `isDeliberateParkActive`
  // and the liveness classifier about which rows carry a park. A half-written row reports
  // the inconsistency instead of throwing, and instead of answering "not parked" — which
  // would hide exactly what a reader needs to see.
  it("reports a half-written park with a null reason rather than as unparked", async () => {
    const issue = await issueService(db).getById(issueIdByLabel.get("park half-written")!);
    expect(issue!.parkedDisposition).toEqual({ reason: null, until: PARKED_UNTIL });
  });
});
