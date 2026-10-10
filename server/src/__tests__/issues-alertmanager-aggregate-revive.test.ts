import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// BLO-40673: `issues_active_alertmanager_aggregate_creation_uq` is partial on
// `status NOT IN ('done','cancelled')`, so a terminal alertmanager row sits
// *outside* the index and re-enters it the moment any update moves it back to an
// active status. `create` has translated that 23505 into a typed 409 since
// BLO-15982; `update` did not, so the identical collision surfaced as a raw 500.
//
// This is not a hypothetical ordering: it is the steady state of every
// aggregate-deduped alertname. Alertmanager keys delivery on its own per-series
// fingerprint (stored as `originId`), while the dedupe slot is keyed on
// `originFingerprint`. Those are deliberately different cardinalities, so a
// closed row whose series re-fires while a sibling series holds the slot is the
// normal case, not an edge case. Measured in production on BLO-37470: ~3
// failures/minute for 11 days.
describeEmbeddedPostgres("issueService.update Alertmanager aggregate revival", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const AGGREGATE_KEY = 'alert-aggregate:v1:["ArcWorkflowJobQueuedCritical",null]';
  const COVER_KEY = "cover:ClusterAdminDrift:248571";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-alertmanager-revive-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  });

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const [company] = await db
      .insert(companies)
      .values({
        name: `alertmanager-revive ${randomUUID()}`,
        issuePrefix: `AM${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning();
    return company;
  }

  async function createMember(companyId: string, originId: string) {
    return await svc.create(companyId, {
      title: `aggregate member ${originId}`,
      description: `firing ${originId}`,
      originKind: "plugin:paperclip-plugin-alertmanager",
      originId,
      originFingerprint: AGGREGATE_KEY,
    });
  }

  async function createCover(companyId: string, originId: string) {
    return await svc.create(companyId, {
      title: `[user-cover] ${originId}`,
      description: `cover ${originId}`,
      originKind: "plugin:paperclip-plugin-alertmanager:escalation",
      originId,
      originFingerprint: COVER_KEY,
    });
  }

  it("rejects reviving a terminal member with a typed 409 when a sibling holds the slot", async () => {
    const company = await seedCompany();

    // Series 1 fires, is worked, and closes -> leaves the partial index.
    const first = await createMember(company.id, "series-1");
    await svc.update(first.id, { status: "done" });

    // Series 2 fires. The slot is free, so this is a genuinely new row, not an
    // arbitration winner handed back. Assert that, or the test below proves nothing.
    const second = await createMember(company.id, "series-2");
    expect(second.id).not.toBe(first.id);

    // Series 1 re-fires. The bridge looks it up by originId, finds the closed row,
    // and tries to reopen it -- straight into the slot `second` now holds.
    await expect(svc.update(first.id, { status: "todo" })).rejects.toMatchObject({
      status: 409,
      message: "Alertmanager aggregate creation conflict",
    });
  });

  it("still allows revival once the sibling has vacated the slot", async () => {
    const company = await seedCompany();

    const first = await createMember(company.id, "series-1");
    await svc.update(first.id, { status: "done" });
    const second = await createMember(company.id, "series-2");
    await svc.update(second.id, { status: "cancelled" });

    // Negative control. Without this the guard could reject *every* revival and
    // the test above would still pass -- the exact "filter matches everything"
    // failure this codebase has hit repeatedly in the merge-gate reader.
    const revived = await svc.update(first.id, { status: "todo" });
    expect(revived.status).toBe("todo");
  });

  it("does not fire on a non-status update to a terminal member", async () => {
    const company = await seedCompany();

    const first = await createMember(company.id, "series-1");
    await svc.update(first.id, { status: "done" });
    await createMember(company.id, "series-2");

    // A patch that leaves the row terminal never enters the partial index, so it
    // must still succeed while the sibling holds the slot. Verified against
    // production: `{priority}` returned 200 on BLO-37470 while `{status}` 500'd.
    const patched = await svc.update(first.id, { priority: "low" });
    expect(patched.priority).toBe("low");
    expect(patched.status).toBe("done");
  });

  // The cover index `issues_active_alert_escalation_cover_uq` has the same
  // predicate shape over the same three key columns, so it carries the identical
  // revive-into-a-held-slot collision. The plugin itself never revives a cover
  // (`escalation.ts` only ever moves one to `cancelled`), but any human or agent
  // PATCHing a cancelled `[user-cover]` row back to `todo` while a newer cover
  // from the same window holds the fingerprint hits it.
  it("rejects reviving a terminal escalation cover with a typed 409", async () => {
    const company = await seedCompany();

    const first = await createCover(company.id, "cover-series-1");
    await svc.update(first.id, { status: "cancelled" });
    const second = await createCover(company.id, "cover-series-2");
    expect(second.id).not.toBe(first.id);

    await expect(svc.update(first.id, { status: "todo" })).rejects.toMatchObject({
      status: 409,
      message: "Alert escalation cover conflict",
    });
  });

  it("still allows reviving a cover once the sibling has vacated the slot", async () => {
    const company = await seedCompany();

    const first = await createCover(company.id, "cover-series-1");
    await svc.update(first.id, { status: "cancelled" });
    const second = await createCover(company.id, "cover-series-2");
    await svc.update(second.id, { status: "done" });

    // Same negative control as the aggregate case: a guard that rejected every
    // cover revival would pass the test above on its own.
    const revived = await svc.update(first.id, { status: "todo" });
    expect(revived.status).toBe("todo");
  });
});
