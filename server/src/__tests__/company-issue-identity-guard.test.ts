import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { linearAuthRoutes, raiseIssueCounterAfterImport } from "../routes/linear-auth.js";
import {
  ISSUE_IDENTITY_ACTIVITY_ACTION,
  normalizeIssuePrefix,
  planIssueIdentityChange,
  setCompanyIssueIdentity,
} from "../services/company-issue-identity.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// BLO-31228: `companies.issuePrefix` / `companies.issueCounter` are the identity
// of every issue in a company, and the Linear OAuth callback used to overwrite
// both unconditionally. On the Blockcast company that would have rewritten
// BLO -> EGY and moved the counter BACKWARDS 31222 -> 363, re-issuing
// identifiers that already exist. BLO-31227 made team selection deterministic;
// this is the other half — a wrong selection must not be destructive.

const BLOCKCAST = { issuePrefix: "BLO", issueCounter: 31222 };

describe("planIssueIdentityChange — prefix", () => {
  it("is a no-op when a reconnect computes the prefix the company already has", () => {
    const plan = planIssueIdentityChange(BLOCKCAST, { prefix: "BLO", counter: 31222 });
    expect(plan.changed).toBe(false);
    expect(plan.prefix).toBeNull();
    expect(plan.refusals).toEqual([]);
  });

  it("matches case-insensitively, so a lowercase team key is still a no-op", () => {
    expect(planIssueIdentityChange(BLOCKCAST, { prefix: "blo" }).changed).toBe(false);
  });

  it("REFUSES a different prefix when nothing confirmed the change", () => {
    // The exact BLO-31227 shape arriving at this guard: sole-team EGY resolved
    // for a company whose identity is BLO.
    const plan = planIssueIdentityChange(BLOCKCAST, { prefix: "EGY" });
    expect(plan.prefix).toBeNull();
    expect(plan.refusals).toContain("prefix-change-unconfirmed");
  });

  it("applies a different prefix only when explicitly confirmed", () => {
    const plan = planIssueIdentityChange(
      BLOCKCAST,
      { prefix: "EGY" },
      { confirmPrefixChange: true },
    );
    expect(plan.prefix).toBe("EGY");
    expect(plan.refusals).toEqual([]);
  });

  it("still auto-configures a company that has minted nothing yet", () => {
    // The useful first-time-connection behaviour this came from. The bug was
    // treating "already has an identity" the same as "has none".
    // `issue_prefix` is NOT NULL DEFAULT 'PAP', so a never-touched company is
    // "PAP"/0 — not blank. Keying on blankness would refuse every first
    // connection, which is the other way to get this wrong.
    const fresh = [
      { issuePrefix: "PAP", issueCounter: 0 },
      { issuePrefix: null, issueCounter: 0 },
      { issuePrefix: "", issueCounter: 0 },
    ];
    for (const current of fresh) {
      const plan = planIssueIdentityChange(current, { prefix: "EGY", counter: 363 });
      expect(plan.prefix).toBe("EGY");
      expect(plan.counter).toBe(363);
      expect(plan.refusals).toEqual([]);
    }
  });

  it("REFUSES once identifiers exist, even with a 0 counter", () => {
    // The Linear import's "start fresh" path leaves rows behind a 0 counter,
    // so the counter alone is not proof that nothing was minted.
    const plan = planIssueIdentityChange(
      { issuePrefix: "PAP", issueCounter: 0, hasMintedIdentifiers: true },
      { prefix: "EGY" },
    );
    expect(plan.prefix).toBeNull();
    expect(plan.refusals).toContain("prefix-change-unconfirmed");
  });
});

describe("planIssueIdentityChange — counter", () => {
  it("REFUSES a lower computed counter and keeps the stored one", () => {
    // 31222 -> 363 is the live regression: a backwards counter re-issues
    // identifiers that already exist, so it collides with history.
    const plan = planIssueIdentityChange(BLOCKCAST, { prefix: "BLO", counter: 363 });
    expect(plan.counter).toBeNull();
    expect(plan.changed).toBe(false);
    expect(plan.refusals).toContain("counter-regression");
  });

  it("refuses a regression even when the prefix change IS confirmed", () => {
    // Confirmation is about re-identifying the company; it never licenses
    // handing out an identifier twice.
    const plan = planIssueIdentityChange(
      BLOCKCAST,
      { prefix: "EGY", counter: 363 },
      { confirmPrefixChange: true },
    );
    expect(plan.prefix).toBe("EGY");
    expect(plan.counter).toBeNull();
    expect(plan.refusals).toContain("counter-regression");
  });

  it("raises the counter when the computed value is higher", () => {
    const plan = planIssueIdentityChange(BLOCKCAST, { counter: 40000 });
    expect(plan.counter).toBe(40000);
    expect(plan.refusals).toEqual([]);
  });

  it("raise-only: a counter at or below the stored one is a silent no-op, not a refusal", () => {
    // Ally I1 on #2471: the import asks "make the counter at least N". An
    // import that matched nothing new (N = 0) or re-imported an older subset
    // must not raise the counter-regression alarm meant for re-identification.
    for (const counter of [0, 363, 31222]) {
      const plan = planIssueIdentityChange(BLOCKCAST, { counter }, { raiseCounterOnly: true });
      expect(plan.counter).toBeNull();
      expect(plan.changed).toBe(false);
      expect(plan.refusals).toEqual([]);
    }
    expect(
      planIssueIdentityChange(BLOCKCAST, { counter: 40000 }, { raiseCounterOnly: true }).counter,
    ).toBe(40000);
  });

  it("floors before comparing, so a fractional no-op is not reported as a change", () => {
    const plan = planIssueIdentityChange(BLOCKCAST, { counter: 31222.5 });
    expect(plan.counter).toBeNull();
    expect(plan.changed).toBe(false);
  });

  it("ignores an absent or non-numeric counter rather than zeroing it", () => {
    for (const counter of [undefined, null, Number.NaN]) {
      const plan = planIssueIdentityChange(BLOCKCAST, { counter });
      expect(plan.counter).toBeNull();
      expect(plan.refusals).toEqual([]);
    }
  });
});

describe("normalizeIssuePrefix", () => {
  it("keeps the board endpoint's long-standing cleaning", () => {
    expect(normalizeIssuePrefix(" blo-1 ")).toBe("BLO1");
    expect(normalizeIssuePrefix("   ")).toBeNull();
    expect(normalizeIssuePrefix(null)).toBeNull();
  });
});

// ── AC3: every identity write goes through setCompanyIssueIdentity ──────────
//
// Scans all of server/src (not one file) for `update(companies).set(arg)`. An
// argument is identity-free only when it is an object literal with plain keys
// and none of them is issuePrefix/issueCounter; anything else — a variable, a
// spread, a computed key — cannot be proven safe and needs an allow-list entry.
// The allow-list is a decision someone has to re-make: it must match the
// findings exactly, so a stale entry fails too.

const IDENTITY_KEYS = new Set(["issuePrefix", "issueCounter"]);

const IDENTITY_WRITE_ALLOW_LIST: Record<string, string> = {
  "services/company-issue-identity.ts": "the one guarded, audited write path (BLO-31228)",
  "services/identifier-allocator.ts":
    "allocator bump: issueCounter = greatest(issueCounter, max(issue_number)) + 1, monotonic by construction",
  "services/companies.ts":
    "generic companyPatch spread; its routes validate with updateCompanySchema, which admits neither issuePrefix nor issueCounter",
};

function isUpdateCompaniesChain(node: ts.Expression): boolean {
  let current: ts.Expression = node;
  for (;;) {
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "update" &&
        current.arguments.length === 1 &&
        ts.isIdentifier(current.arguments[0]!) &&
        current.arguments[0].text === "companies"
      ) {
        return true;
      }
      current = callee;
    } else if (ts.isPropertyAccessExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
    } else if (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else {
      return false;
    }
  }
}

function isProvablyIdentityFree(arg: ts.Expression | undefined): boolean {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
  return arg.properties.every((prop) => {
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) return false;
    if (ts.isComputedPropertyName(prop.name)) return false;
    const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
    return key !== null && !IDENTITY_KEYS.has(key);
  });
}

/** Lines of `update(companies).set(...)` calls that may write identity columns. */
function findUnguardedIdentityWrites(fileName: string, text: string): number[] {
  // Cheap pre-filter, no narrower than the AST match below: skip parsing files
  // that never name `update(companies` or raw `update companies set`.
  const raw = /update\s+"?companies"?\s+set/i.test(text);
  if (!raw && !/\bupdate\s*\(\s*companies\b/.test(text)) return [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "set" &&
      isUpdateCompaniesChain(node.expression.expression) &&
      !isProvablyIdentityFree(node.arguments[0])
    ) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  // Raw SQL bypasses the builder entirely; any of it on companies is a finding.
  if (raw) lines.push(0);
  return lines;
}

const SERVER_SRC = fileURLToPath(new URL("..", import.meta.url));

function listServerSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" || entry.name === "node_modules" ? [] : listServerSources(full);
    }
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$|\.d\.ts$/.test(entry.name) ? [full] : [];
  });
}

describe("identity writes across server/src", () => {
  it("flags the shapes a single-file, `[^}]*` regex missed", () => {
    // The exact shape this PR removed from /configure: assembled, then passed.
    expect(
      findUnguardedIdentityWrites(
        "configure.ts",
        `const updates: Record<string, unknown> = { updatedAt: new Date() };
         updates.issuePrefix = clean;
         await db.update(companies).set(updates).where(eq(companies.id, id));`,
      ),
    ).toEqual([3]);
    // An object-valued property ahead of the identity key.
    expect(
      findUnguardedIdentityWrites(
        "nested.ts",
        `await tx.update(companies).set({ meta: { a: 1 }, issueCounter: 5 }).where(x);`,
      ),
    ).toEqual([1]);
    expect(
      findUnguardedIdentityWrites("spread.ts", `await db.update(companies).set({ ...patch }).where(x);`),
    ).toEqual([1]);
    expect(
      findUnguardedIdentityWrites("raw.ts", "await db.execute(sql`UPDATE companies SET issue_prefix = 'X'`);"),
    ).toEqual([0]);
    // Positive control: an identity-free literal, and other tables, are clean.
    expect(
      findUnguardedIdentityWrites(
        "budget.ts",
        `await db.update(companies).set({ budgetMonthlyCents: 1, updatedAt: now }).where(x);
         await db.update(agents).set(patch).where(x);`,
      ),
    ).toEqual([]);
  });

  it("routes every identity write through the allow-listed paths, and the allow-list is exact", () => {
    const flagged: Record<string, number[]> = {};
    for (const file of listServerSources(SERVER_SRC)) {
      const lines = findUnguardedIdentityWrites(file, readFileSync(file, "utf8"));
      if (lines.length > 0) flagged[path.relative(SERVER_SRC, file).split(path.sep).join("/")] = lines;
    }
    // Positive control on the walker itself: it must have seen the allocator.
    expect(Object.keys(flagged)).toContain("services/identifier-allocator.ts");
    expect(Object.keys(flagged).sort()).toEqual(Object.keys(IDENTITY_WRITE_ALLOW_LIST).sort());
  });

  it("never passes confirmPrefixChange from the OAuth callback handler", () => {
    const file = fileURLToPath(new URL("../routes/linear-auth.ts", import.meta.url));
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const handlers: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "get" &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === "/callback"
      ) {
        handlers.push(node.getText(source));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(handlers).toHaveLength(1);
    expect(handlers[0]).toContain("confirmPrefixChange: false");
    expect(handlers[0]).not.toContain("confirmPrefixChange: true");
  });
});

// ── setCompanyIssueIdentity and its callers, against a real database ───────

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("setCompanyIssueIdentity (db-backed)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let server: Server | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-identity-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    server?.close();
    await tempDb?.cleanup();
  });

  async function seedCompany(issuePrefix: string, issueCounter: number) {
    const [company] = await db
      .insert(companies)
      .values({ name: `issue-identity ${randomUUID()}`, issuePrefix, issueCounter })
      .returning();
    return company!.id;
  }

  async function identityOf(companyId: string) {
    const [row] = await db
      .select({ issuePrefix: companies.issuePrefix, issueCounter: companies.issueCounter })
      .from(companies)
      .where(eq(companies.id, companyId));
    return row;
  }

  async function auditRows(companyId: string) {
    return db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, ISSUE_IDENTITY_ACTIVITY_ACTION)));
  }

  it("adopts the team key on a real first connection: unique prefix, 0 counter, no issues", async () => {
    // Production shape: services/companies.ts allocates a unique non-default
    // prefix at insert time, so a first connection is e.g. ACM1/0 — not PAP/0.
    const companyId = await seedCompany(`A${randomUUID().slice(0, 5).toUpperCase()}`, 0);
    const result = await setCompanyIssueIdentity(db, {
      companyId,
      prefix: "EGY",
      counter: 363,
      confirmPrefixChange: false,
      reason: "test",
    });
    expect(result.refusals).toEqual([]);
    expect(await identityOf(companyId)).toEqual({ issuePrefix: "EGY", issueCounter: 363 });
  });

  it("reads hasMintedIdentifiers from the issues table: a 0-counter company with rows refuses", async () => {
    const prefix = `S${randomUUID().slice(0, 5).toUpperCase()}`;
    const companyId = await seedCompany(prefix, 0);
    await db.insert(issues).values({ companyId, title: "left behind by start fresh", identifier: `${prefix}-7` });
    const result = await setCompanyIssueIdentity(db, {
      companyId,
      prefix: "EGY",
      confirmPrefixChange: false,
      reason: "test",
    });
    expect(result.refusals).toEqual(["prefix-change-unconfirmed"]);
    expect(await identityOf(companyId)).toEqual({ issuePrefix: prefix, issueCounter: 0 });
  });

  it("writes an audit row for a refusal, with the stored and proposed values", async () => {
    const companyId = await seedCompany("BLO", 31222);
    await setCompanyIssueIdentity(db, { companyId, prefix: "EGY", counter: 363, reason: "test" });
    const rows = await auditRows(companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({
      reason: "test",
      from: { issuePrefix: "BLO", issueCounter: 31222 },
      to: { issuePrefix: "BLO", issueCounter: 31222 },
      proposed: { issuePrefix: "EGY", issueCounter: 363 },
      refusals: ["prefix-change-unconfirmed", "counter-regression"],
    });
    expect(await identityOf(companyId)).toEqual({ issuePrefix: "BLO", issueCounter: 31222 });
  });

  it("holds the floor when the allocator bumps the counter between the read and the write", async () => {
    const companyId = await seedCompany("BLO", 100);
    // Fire a concurrent allocator-style bump just before the guarded UPDATE
    // executes, i.e. after setCompanyIssueIdentity has planned against 100.
    let fired = false;
    const bumpFirst = <T extends object>(target: T): T =>
      new Proxy(target, {
        get(obj, prop) {
          const value = Reflect.get(obj, prop, obj);
          if (prop === "then" && typeof value === "function") {
            return (onFulfilled: unknown, onRejected: unknown) =>
              (fired
                ? Promise.resolve()
                : ((fired = true),
                  db.update(companies).set({ issueCounter: 500 }).where(eq(companies.id, companyId)))
              ).then(() => value.call(obj, onFulfilled, onRejected));
          }
          if (typeof value === "function") {
            return (...args: unknown[]) => {
              const out = value.apply(obj, args);
              return out && typeof out === "object" ? bumpFirst(out) : out;
            };
          }
          return value;
        },
      });
    const racingDb = new Proxy(db, {
      get(obj, prop) {
        const value = Reflect.get(obj, prop, obj);
        if (prop === "update") return (table: typeof companies) => bumpFirst(db.update(table));
        return typeof value === "function" ? value.bind(obj) : value;
      },
    });

    const result = await setCompanyIssueIdentity(racingDb, { companyId, counter: 200, reason: "test" });
    expect(fired).toBe(true);
    expect(result.issueCounter).toBe(500);
    expect(await identityOf(companyId)).toEqual({ issuePrefix: "BLO", issueCounter: 500 });
  });

  describe("linear import counter bump", () => {
    it("is a silent no-op when the import matched nothing new", async () => {
      // Ally I1 on #2471: highestImportedNumber starts at 0, so an empty team,
      // a filtered result or a re-imported older subset must not audit a
      // counter-regression refusal.
      const companyId = await seedCompany("BLO", 31222);
      for (const highest of [0, 363]) {
        await raiseIssueCounterAfterImport(db, companyId, highest, "user-1");
      }
      expect(await auditRows(companyId)).toEqual([]);
      expect(await identityOf(companyId)).toEqual({ issuePrefix: "BLO", issueCounter: 31222 });
    });

    it("raises the counter, audited, when the import saw a higher number", async () => {
      const companyId = await seedCompany("BLO", 31222);
      await raiseIssueCounterAfterImport(db, companyId, 31300, "user-1");
      expect(await identityOf(companyId)).toEqual({ issuePrefix: "BLO", issueCounter: 31300 });
      const rows = await auditRows(companyId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.details).toMatchObject({ reason: "linear-import", refusals: [] });
    });

    it("leaves a start-fresh (0) counter alone", async () => {
      const companyId = await seedCompany("BLO", 0);
      await raiseIssueCounterAfterImport(db, companyId, 31300, "user-1");
      expect(await identityOf(companyId)).toEqual({ issuePrefix: "BLO", issueCounter: 0 });
      expect(await auditRows(companyId)).toEqual([]);
    });
  });

  describe("POST /api/auth/linear/configure", () => {
    function app() {
      if (server) return server;
      const instance = express();
      instance.use(express.json());
      instance.use((req, _res, next) => {
        (req as any).actor = { type: "board", userId: "user-1", source: "local_implicit" };
        next();
      });
      instance.use("/api/auth/linear", linearAuthRoutes(db, {} as any));
      instance.use(errorHandler);
      server = instance.listen(0);
      return server;
    }

    it("returns 409 with the refusal, not 200, when startAt is below the stored counter", async () => {
      // Ally I2 on #2471: a refused write must not read as success.
      const companyId = await seedCompany("BLO", 31222);
      const res = await request(app())
        .post(`/api/auth/linear/configure?companyId=${companyId}`)
        .send({ startAt: 0 });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        issuePrefix: "BLO",
        issueCounter: 31222,
        changed: false,
        refusals: ["counter-regression"],
      });
      expect(res.body.error).toEqual(expect.any(String));
      expect(await identityOf(companyId)).toEqual({ issuePrefix: "BLO", issueCounter: 31222 });
    });

    it("returns 200 when every requested change was applied", async () => {
      const companyId = await seedCompany("BLO", 31222);
      const res = await request(app())
        .post(`/api/auth/linear/configure?companyId=${companyId}`)
        .send({ prefix: "egy", startAt: 40000 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ issuePrefix: "EGY", issueCounter: 40000, changed: true, refusals: [] });
    });
  });
});
