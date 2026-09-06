import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    resolveSecretValue: async () => "fake-linear-pat-from-test",
  }),
}));

import {
  companies,
  createDb,
  issues,
  linearIssueLinks,
  pluginCompanySettings,
  plugins,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issueService.create Alertmanager aggregate arbitration", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let fetchSpy: any = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-alertmanager-create-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  });

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(async () => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
    await db.delete(linearIssueLinks);
    await db.delete(issues);
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedLinearConfiguredCompany() {
    const [company] = await db
      .insert(companies)
      .values({
        name: `alertmanager-linear ${randomUUID()}`,
        issuePrefix: `AM${randomUUID().slice(0, 6).toUpperCase()}`,
        identifierProvider: "linear",
      })
      .returning();
    const [plugin] = await db
      .insert(plugins)
      .values({
        pluginKey: "paperclip-plugin-linear",
        packageName: "@kkroo/paperclip-plugin-linear",
        version: "0.9.3",
        manifestJson: {} as never,
      })
      .returning();
    await db.insert(pluginCompanySettings).values({
      companyId: company.id,
      pluginId: plugin.id,
      settingsJson: {
        teamId: "team-id-test-aggregate",
        linearTokenRef: "00000000-0000-0000-0000-000000000001",
      },
    });
    return company;
  }

  it("returns an active aggregate winner before a second Linear allocation", async () => {
    const company = await seedLinearConfiguredCompany();
    fetchSpy!.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            issueCreate: {
              success: true,
              issue: {
                id: "linear-alertmanager-1",
                identifier: "BLO-7001",
                url: "https://linear.app/blockcast/issue/BLO-7001/alertmanager",
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const aggregateKey = 'alert-aggregate:v1:["CiliumPolicyDropsHigh",null]';
    const first = await svc.create(company.id, {
      title: "first aggregate member",
      description: "firing series one",
      originKind: "plugin:paperclip-plugin-alertmanager",
      originId: "series-1",
      originFingerprint: aggregateKey,
    });
    const second = await svc.create(company.id, {
      title: "second aggregate member",
      description: "firing series two",
      originKind: "plugin:paperclip-plugin-alertmanager",
      originId: "series-2",
      originFingerprint: aggregateKey,
    });

    expect(second.id).toBe(first.id);
    expect(second.identifier).toBe("BLO-7001");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
