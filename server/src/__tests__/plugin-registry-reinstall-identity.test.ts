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

    // `false` here is the registry default (`plugin-registry.ts:279`), but the
    // docstring's claim is made at the HTTP surface, and getting there depends on
    // two defaults this suite does not exercise: `lifecycle.unload`'s own
    // `removeData = false` (`plugin-lifecycle.ts:560`, forwarded at `:590`) and
    // the route's `purge = req.query.purge === "true"` (`routes/plugins.ts:2368`,
    // passed at `:2377`). Flipping either would falsify the docstring with this
    // suite still green — check them too if this test ever has to be revisited.
    // `unload` reaches `registry.uninstall` from a second site, `:568`, which
    // hardcodes `true`; it is a purge either way and cannot silently flip, so it
    // does not participate in the defaults above — but an audit that walks only
    // `:590` will see one hard-delete entry point where there are two.
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
    // Assert through `!`, not behind an `expect(...).not.toBeNull()` guard: this
    // branch reaches the fresh-insert return (`plugin-registry.ts:204`), one of
    // only two un-coalesced `return rows[0]` in the registry, so a nullish result
    // here is `undefined`, not `null`. `toBeNull` is `Object.is(actual, null)` and
    // so admits `undefined` — after which `undefined?.id !== originalId` satisfies
    // the negative assertion without ever observing a new id. `!` throws on both.
    expect(reinstalled!.id).not.toBe(originalId);
  });
});
