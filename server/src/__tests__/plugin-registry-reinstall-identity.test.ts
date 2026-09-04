import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, plugins } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { pluginRegistryService } from "../services/plugin-registry.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin registry reinstall identity tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const MANIFEST: PaperclipPluginManifestV1 = {
  id: "reinstall-identity-fixture",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Reinstall Identity Fixture",
  description: "Test fixture",
  author: "test",
  categories: ["connector"],
  capabilities: [],
  entrypoints: { worker: "./worker.js" },
};

/**
 * `plugins.id` is the namespace component of the plugin comment/invoke dedup
 * keys (`plugin:${pluginId}:<key>`, `plugin-host-services.ts`). The SDK
 * docstrings for `issues.createComment`'s `idempotencyKey` assert that those
 * keys survive an uninstall/reinstall cycle and are orphaned only by a purge.
 * That is a claim about the registry's row-reuse branch, not about the comment
 * path, so pin it here: if `install` ever stops reusing the existing row, the
 * docstrings silently become wrong and every plugin's dedup namespace rotates.
 */
describeEmbeddedPostgres("plugin registry: dedup namespace identity across reinstall", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-reinstall-id-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(plugins);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("preserves plugins.id across a soft uninstall and reinstall", async () => {
    const registry = pluginRegistryService(db);

    const installed = await registry.install({ packageName: "pkg-a" }, MANIFEST);
    expect(installed).not.toBeNull();
    const originalId = installed!.id;

    const softUninstalled = await registry.uninstall(originalId, false);
    expect(softUninstalled?.status).toBe("uninstalled");
    // Soft delete retains the row — the id is still resolvable.
    expect(softUninstalled?.id).toBe(originalId);

    const reinstalled = await registry.install({ packageName: "pkg-a" }, MANIFEST);
    expect(reinstalled?.status).toBe("installed");
    expect(reinstalled?.id).toBe(originalId);
  });

  it("mints a new plugins.id after a purge, orphaning earlier keys", async () => {
    const registry = pluginRegistryService(db);

    const installed = await registry.install({ packageName: "pkg-a" }, MANIFEST);
    const originalId = installed!.id;

    // Hard delete (the `?purge=true` path) removes the row outright.
    await registry.uninstall(originalId, true);
    expect(await registry.getByKey(MANIFEST.id)).toBeNull();

    const reinstalled = await registry.install({ packageName: "pkg-a" }, MANIFEST);
    expect(reinstalled?.id).not.toBe(originalId);
  });
});
