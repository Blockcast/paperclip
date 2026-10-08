// BLO-31227 / Ally I1 on #2323: the OAuth callback's team-refusal 409 used to
// return before the plugin-config write. The token secret was already stored,
// so `/status` reported connected, but the plugin reads its token only through
// `linearTokenRef` and threw "Not connected to Linear" from the very team
// picker the 409 told the operator to use. Both paths now go through
// persistLinearPluginConfig. This pins what it writes on the refusal shape (no
// resolved team) and that it touches no company identity.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, pluginConfig, plugins, pluginState } from "@paperclipai/db";
import { persistLinearPluginConfig } from "../routes/linear-auth.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("persistLinearPluginConfig", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-linear-plugin-config-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(pluginState);
    await db.delete(pluginConfig);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(withPlugin: boolean) {
    const [company] = await db
      .insert(companies)
      .values({ name: `linear-config ${randomUUID()}`, issuePrefix: "BLO", issueCounter: 31222 })
      .returning();
    if (withPlugin) {
      await db.insert(plugins).values({
        id: randomUUID(),
        pluginKey: "paperclip-plugin-linear",
        packageName: "paperclip-plugin-linear",
        version: "0.0.0",
        apiVersion: 1,
        categories: [],
        manifestJson: {} as never,
        status: "installed",
        installOrder: 1,
      });
    }
    return company!.id;
  }

  it("binds the token even when no team resolved, leaving the team blank and identity untouched", async () => {
    const companyId = await seed(true);
    const secretId = randomUUID();

    await expect(persistLinearPluginConfig(db, companyId, secretId, "")).resolves.toBe(true);

    const [row] = await db.select().from(pluginConfig).where(eq(pluginConfig.companyId, companyId));
    expect(row?.configJson).toMatchObject({ linearTokenRef: secretId, teamId: "" });
    const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(company).toMatchObject({ issuePrefix: "BLO", issueCounter: 31222 });
  });

  it("rewrites an existing config in place on reconnect", async () => {
    const companyId = await seed(true);
    await persistLinearPluginConfig(db, companyId, randomUUID(), "team-a");
    const rotated = randomUUID();

    await persistLinearPluginConfig(db, companyId, rotated, "team-a");

    const rows = await db.select().from(pluginConfig).where(eq(pluginConfig.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.configJson).toMatchObject({ linearTokenRef: rotated, teamId: "team-a" });
  });

  it("reports false and writes nothing when the plugin is not installed", async () => {
    const companyId = await seed(false);

    await expect(persistLinearPluginConfig(db, companyId, randomUUID(), "")).resolves.toBe(false);

    expect(await db.select().from(pluginConfig)).toHaveLength(0);
  });
});
