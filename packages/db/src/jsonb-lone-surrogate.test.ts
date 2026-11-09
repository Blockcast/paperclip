import { sql } from "drizzle-orm";
import { json, jsonb, pgTable, serial } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, wellFormedJsonText } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

describe("wellFormedJsonText", () => {
  it("replaces lone surrogate escapes and leaves every other escape alone", () => {
    expect(wellFormedJsonText(JSON.stringify({ s: "ab\uD83D" }))).toBe('{"s":"ab\\ufffd"}');
    expect(wellFormedJsonText(JSON.stringify("\uDC00x"))).toBe('"\\ufffdx"');
    expect(wellFormedJsonText(JSON.stringify("\uD83D\uD83D\uDE00"))).toBe('"\\ufffd\u{1F600}"');
    expect(wellFormedJsonText('"\\uD83D\\uDE00 \\uD83D"')).toBe('"\\uD83D\\uDE00 \\ufffd"');
    expect(wellFormedJsonText(JSON.stringify({ "k\uD83D": 1 }))).toBe('{"k\\ufffd":1}');
    // An escaped backslash followed by the text "ud83d" is not an escape.
    expect(wellFormedJsonText(JSON.stringify("\\ud83d"))).toBe('"\\\\ud83d"');
    expect(wellFormedJsonText(JSON.stringify("\\\uD83D"))).toBe('"\\\\\\ufffd"');
  });

  it("returns non-strings and strings without a surrogate escape unchanged", () => {
    const text = JSON.stringify({ s: "\u{1F534} \u00e9 \\n" });
    expect(wellFormedJsonText(text)).toBe(text);
    const value = { s: "x" };
    expect(wellFormedJsonText(value)).toBe(value);
    expect(wellFormedJsonText(null)).toBe(null);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const samples = pgTable("lone_surrogate_samples", {
  id: serial("id").primaryKey(),
  doc: jsonb("doc"),
  raw: json("raw"),
});

// A `.slice(0, n)` that cut an emoji in half made Postgres reject the whole write
// (22P02, "Unicode low surrogate must follow a high surrogate").
describeEmbeddedPostgres("json/jsonb parameters with lone surrogates", () => {
  let db!: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-lone-surrogate-");
    cleanup = tempDb.cleanup;
    db = createDb(tempDb.connectionString);
    await db.execute(sql`create table lone_surrogate_samples (id serial primary key, doc jsonb, raw json)`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it("stores a drizzle jsonb and json column write", async () => {
    const snippet = `${"x".repeat(119)}\u{1F534}`.slice(0, 120);
    const [row] = await db
      .insert(samples)
      .values({ doc: { snippet, intact: "\u{1F534}" }, raw: { snippet } })
      .returning();

    expect(row.doc).toEqual({ snippet: `${"x".repeat(119)}\uFFFD`, intact: "\u{1F534}" });
    expect(row.raw).toEqual({ snippet: `${"x".repeat(119)}\uFFFD` });
  });

  it("stores a raw ::jsonb cast of stringified text", async () => {
    const text = JSON.stringify({ s: "y\uDC00" });
    const result = await db.execute(sql`select ${text}::jsonb as v`);

    expect(result[0]?.v).toEqual({ s: "y\uFFFD" });
  });
});
