/**
 * BLO-58502. `externalWaitDescriptionCandidate` is a SQL prefilter in front of
 * `externalWaitFromDescription`. It must never change that predicate's verdict (a
 * declared wait it hides is a parked row the liveness sweep reads as stranded), and it
 * must actually drop prose that cannot declare one, or it saves nothing.
 *
 * The mixed-case row is what fails if the prefilter is weakened to a case-sensitive
 * LIKE; the NULL assertions are what fail if it stops filtering at all.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, issues } from "@paperclipai/db";
import {
  externalWaitDescriptionCandidate,
  externalWaitFromDescription,
} from "../services/external-wait-declaration.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const DESCRIPTIONS: Array<{ description: string | null; declares: boolean }> = [
  { description: "external owner: ops\nexternal action: rotate the key", declares: true },
  { description: "Context\n  EXTERNAL Owner : Board\n\tExternal ACTION:\tapprove card", declares: true },
  { description: `${"long prose ".repeat(2000)}\nexternal owner: x\nexternal action: y`, declares: true },
  { description: "external owner: ops only, no action line", declares: false },
  { description: "mentions an external owner and an external action inline only", declares: false },
  { description: "nothing relevant here", declares: false },
  { description: null, declares: false },
];

describeEmbeddedPostgres("externalWaitDescriptionCandidate (BLO-58502)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-external-wait-candidate-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("keeps every declaring description and drops prose that cannot declare", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    for (const [i, row] of DESCRIPTIONS.entries()) {
      await db.insert(issues).values({
        id: randomUUID(),
        companyId,
        title: `row ${i}`,
        description: row.description,
        status: "blocked",
        priority: "medium",
      });
    }

    const rows = await db
      .select({
        title: issues.title,
        description: issues.description,
        candidate: externalWaitDescriptionCandidate,
      })
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(rows).toHaveLength(DESCRIPTIONS.length);

    for (const row of rows) {
      const { declares } = DESCRIPTIONS[Number(row.title.slice(4))]!;
      // Same verdict through the prefilter as over the full column.
      expect(externalWaitFromDescription(row.candidate)).toEqual(externalWaitFromDescription(row.description));
      expect(externalWaitFromDescription(row.description) !== null).toBe(declares);
      // Rows lacking either literal are not shipped at all.
      const hasBoth = /external owner/i.test(row.description ?? "") && /external action/i.test(row.description ?? "");
      expect(row.candidate).toBe(hasBoth ? row.description : null);
    }
    expect(rows.filter((r) => r.candidate === null).length).toBeGreaterThanOrEqual(3);
  });
});
