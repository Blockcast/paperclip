import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyEmbeddedPostgresTemplate,
  embeddedPostgresTemplateKey,
  ensureEmbeddedPostgresTemplate,
} from "./test-embedded-postgres.js";

const savedEnv = {
  EMBEDDED_POSTGRES_DATA_ROOT: process.env.EMBEDDED_POSTGRES_DATA_ROOT,
  PAPERCLIP_TEST_PG_TEMPLATE: process.env.PAPERCLIP_TEST_PG_TEMPLATE,
};

describe("embedded Postgres test template", () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function useDataRoot(): string {
    const dataRoot = makeTempDir("paperclip-pg-template-root-");
    process.env.EMBEDDED_POSTGRES_DATA_ROOT = dataRoot;
    delete process.env.PAPERCLIP_TEST_PG_TEMPLATE;
    return dataRoot;
  }

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keys the template on the migrations the migrator reads and the embedded-postgres version", () => {
    const migrations = makeTempDir("paperclip-pg-template-migrations-");
    fs.mkdirSync(path.join(migrations, "meta"));
    fs.writeFileSync(path.join(migrations, "0000_init.sql"), "CREATE TABLE a (id integer);");
    fs.writeFileSync(path.join(migrations, "meta", "_journal.json"), '{"entries":[]}');
    fs.writeFileSync(path.join(migrations, "meta", "0000_snapshot.json"), "{}");
    const key = embeddedPostgresTemplateKey(migrations, "18.1.0-beta.16");

    expect(embeddedPostgresTemplateKey(migrations, "18.1.0-beta.16")).toBe(key);
    expect(embeddedPostgresTemplateKey(migrations, "18.2.0")).not.toBe(key);

    // Only `drizzle-kit generate` reads the snapshots.
    fs.writeFileSync(path.join(migrations, "meta", "0000_snapshot.json"), '{"id":"changed"}');
    expect(embeddedPostgresTemplateKey(migrations, "18.1.0-beta.16")).toBe(key);

    const keys = new Set([key]);
    fs.writeFileSync(path.join(migrations, "0000_init.sql"), "CREATE TABLE a (id bigint);");
    keys.add(embeddedPostgresTemplateKey(migrations, "18.1.0-beta.16"));
    fs.writeFileSync(path.join(migrations, "0001_next.sql"), "CREATE TABLE b (id integer);");
    keys.add(embeddedPostgresTemplateKey(migrations, "18.1.0-beta.16"));
    fs.writeFileSync(path.join(migrations, "meta", "_journal.json"), '{"entries":[{"idx":0}]}');
    keys.add(embeddedPostgresTemplateKey(migrations, "18.1.0-beta.16"));
    expect(keys.size).toBe(4);
  });

  it("stays off without EMBEDDED_POSTGRES_DATA_ROOT and with PAPERCLIP_TEST_PG_TEMPLATE=0", async () => {
    const build = vi.fn(async () => makeTempDir("paperclip-pg-template-unused-"));
    delete process.env.EMBEDDED_POSTGRES_DATA_ROOT;
    delete process.env.PAPERCLIP_TEST_PG_TEMPLATE;
    expect(await ensureEmbeddedPostgresTemplate(build)).toBeNull();

    const dataRoot = useDataRoot();
    process.env.PAPERCLIP_TEST_PG_TEMPLATE = "0";
    expect(await ensureEmbeddedPostgresTemplate(build)).toBeNull();

    expect(build).not.toHaveBeenCalled();
    expect(fs.readdirSync(dataRoot)).toEqual([]);
  });

  it("builds once per data root, and a caller that finds the build claimed falls back at once", async () => {
    const dataRoot = useDataRoot();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const build = vi.fn(async () => {
      const dir = fs.mkdtempSync(path.join(dataRoot, "build-"));
      fs.writeFileSync(path.join(dir, "PG_VERSION"), "18\n");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return dir;
    });

    const [built, concurrent] = await Promise.all([
      ensureEmbeddedPostgresTemplate(build),
      ensureEmbeddedPostgresTemplate(build),
    ]);

    expect(concurrent).toBeNull();
    expect(built).toMatch(/paperclip-pg-template-[0-9a-f]{16}$/);
    expect(fs.readFileSync(path.join(String(built), "PG_VERSION"), "utf8")).toBe("18\n");
    expect(await ensureEmbeddedPostgresTemplate(build)).toBe(built);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failed build in the same data root", async () => {
    useDataRoot();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const build = vi.fn(async (): Promise<string> => {
      throw new Error("migration 0273 failed");
    });

    expect(await ensureEmbeddedPostgresTemplate(build)).toBeNull();
    expect(await ensureEmbeddedPostgresTemplate(build)).toBeNull();

    expect(build).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("migration 0273 failed");
  });

  it("gives up on a build that misses its deadline and removes it when it finishes late", async () => {
    const dataRoot = useDataRoot();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let lateDir = "";
    const build = vi.fn(async () => {
      lateDir = fs.mkdtempSync(path.join(dataRoot, "build-"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      return lateDir;
    });

    expect(await ensureEmbeddedPostgresTemplate(build, 10)).toBeNull();
    expect(String(warn.mock.calls[0]?.[0])).toContain("did not finish within 10 ms");
    expect(await ensureEmbeddedPostgresTemplate(build, 10)).toBeNull();
    await vi.waitFor(() => expect(fs.existsSync(lateDir)).toBe(false));

    expect(build).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(dataRoot).filter((name) => !name.endsWith(".lock"))).toEqual([]);
  });

  it.runIf(process.platform !== "win32")("copies the template into the suite's 0700 data directory", () => {
    const root = makeTempDir("paperclip-pg-template-copy-");
    const template = fs.mkdtempSync(path.join(root, "template-"));
    fs.mkdirSync(path.join(template, "base", "1"), { recursive: true });
    fs.writeFileSync(path.join(template, "base", "1", "1259"), "pg_class");
    // As startEmbeddedPostgresTestDatabase() does: copy into a fresh mkdtemp dir.
    const dataDir = fs.mkdtempSync(path.join(root, "suite-"));

    copyEmbeddedPostgresTemplate(template, dataDir);

    expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(dataDir)).toEqual(["base"]);
    expect(fs.readFileSync(path.join(dataDir, "base", "1", "1259"), "utf8")).toBe("pg_class");
  });
});
