import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres description-truncation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Regression test for PEN-4450.
 *
 * The issues LIST projection clips `description` to a fixed character cap and used to say
 * nothing about having done so. A caller holding the cap's worth of text could not tell a
 * complete description from the first 8% of a long one — and in this corpus the discarded
 * tail is where acceptance criteria live, so the clip systematically removed the part that
 * answers "what would close this row" while leaving the part that says what it is.
 *
 * Every assertion below is written against the BOUNDARY, because the cap is only wrong in
 * one direction and only at the edge:
 *
 *   - exactly MAX  -> flag `false` (a description that merely IS the cap length is whole)
 *   - MAX + 1      -> flag `true`  (the smallest real clip)
 *   - astral       -> both of the above again, with a surrogate pair inside the prefix.
 *
 * The astral pair is the case that separates a correct implementation from the obvious
 * wrong one. The cap counts CODE POINTS (PG `substring(text, 1, n)` does, and so must the
 * flag); JS `String.length` counts UTF-16 units. An implementation written as
 * `raw.length > MAX` passes every ASCII case here and then reports a whole description as
 * truncated the moment one emoji appears inside it — false in the direction that makes
 * callers re-fetch rows that did not need it, and, in the mirror case, the reason an
 * `=== MAX` length probe in a caller misses 9 of 999 live rows.
 */
const MAX = 1200;
/** Outside the BMP, so it costs two UTF-16 units and one code point. */
const ASTRAL = "\u{1F600}";

describeEmbeddedPostgres("issue list description truncation flag (PEN-4450)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-description-truncation-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(descriptions: Array<string | null>) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Description Cap Co",
      issuePrefix: "DCP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "DCP Agent",
      role: "engineer",
      status: "idle",
    });
    const ids: string[] = [];
    for (const [index, description] of descriptions.entries()) {
      const id = randomUUID();
      await db.insert(issues).values({
        id,
        companyId,
        identifier: `DCP-${index + 1}`,
        title: `Row ${index + 1}`,
        status: "todo",
        priority: "medium",
        originKind: "manual",
        originFingerprint: "default",
        assigneeAgentId: agentId,
        description,
      });
      ids.push(id);
    }
    return { companyId, ids };
  }

  async function listRow(companyId: string, id: string) {
    const rows = (await svc.list(companyId, {})) as Array<Record<string, any>>;
    const row = rows.find((candidate) => candidate.id === id);
    expect(row, `issue ${id} missing from list`).toBeDefined();
    return row!;
  }

  it("reports false for a description exactly at the cap and true one code point past it", async () => {
    const atCap = "a".repeat(MAX);
    const pastCap = "a".repeat(MAX + 1);
    const { companyId, ids } = await seed([atCap, pastCap]);

    const whole = await listRow(companyId, ids[0]!);
    expect(whole.descriptionTruncated).toBe(false);
    expect(whole.description).toBe(atCap);

    const clipped = await listRow(companyId, ids[1]!);
    expect(clipped.descriptionTruncated).toBe(true);
    // The wire value is still exactly the cap: the probe code point selected by the SQL
    // slice is trimmed off before the row leaves the service, so this change adds a key
    // without lengthening the field any caller already parses.
    expect([...(clipped.description as string)]).toHaveLength(MAX);
    expect(clipped.description).toBe(atCap);
  });

  it("counts code points, not UTF-16 units, for an astral character inside the prefix", async () => {
    // Exactly MAX code points, but MAX + 1 UTF-16 units. A `raw.length > MAX` check calls
    // this truncated; it is whole.
    const wholeAstral = `${"a".repeat(MAX - 1)}${ASTRAL}`;
    expect(wholeAstral.length).toBe(MAX + 1);
    expect([...wholeAstral]).toHaveLength(MAX);

    // The same prefix with real text past the boundary: genuinely clipped, and the clip
    // must land on the code point rather than splitting the surrogate pair.
    const clippedAstral = `${wholeAstral} and then a great deal more text past the cap.`;

    const { companyId, ids } = await seed([wholeAstral, clippedAstral]);

    const whole = await listRow(companyId, ids[0]!);
    expect(whole.descriptionTruncated).toBe(false);
    expect(whole.description).toBe(wholeAstral);

    const clipped = await listRow(companyId, ids[1]!);
    expect(clipped.descriptionTruncated).toBe(true);
    expect([...(clipped.description as string)]).toHaveLength(MAX);
    // The UTF-16 length is MAX + 1 — this is the live-corpus shape that defeats an
    // `=== MAX` probe in a caller and is why the flag exists rather than a length rule.
    expect((clipped.description as string).length).toBe(MAX + 1);
    expect(clipped.description as string).toContain(ASTRAL);
    // No lone surrogate at the cut.
    expect(/[\uD800-\uDBFF]$/.test(clipped.description as string)).toBe(false);
  });

  it("emits the key as an explicit false for short and null descriptions", async () => {
    const { companyId, ids } = await seed(["Short description.", null]);

    const short = await listRow(companyId, ids[0]!);
    // Key PRESENCE is the contract, not truthiness: a caller has to be able to tell this
    // server apart from one that predates the field, where the key is absent and the
    // question is unanswerable. `toHaveProperty` fails on absence; `toBe(false)` would
    // also pass for `undefined` under a loose read, so assert both.
    expect(short).toHaveProperty("descriptionTruncated");
    expect(short.descriptionTruncated).toBe(false);

    const empty = await listRow(companyId, ids[1]!);
    expect(empty).toHaveProperty("descriptionTruncated");
    expect(empty.descriptionTruncated).toBe(false);
    expect(empty.description).toBeNull();
  });
});
