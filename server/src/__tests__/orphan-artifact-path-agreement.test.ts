import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  readOrphanedRunTerminalResult,
  runLogBasePath,
} from "../services/orphaned-run-terminal-result.js";

/**
 * PEN-5124. One fact, asserted from both sides of a package boundary: the
 * address the ADAPTER writes the pod log to is inside the tree the SERVER's
 * orphan reader scans.
 *
 * Why this is worth a file of its own. PEN-2421's recovery reads
 * `<run>.pod.ndjson` to stop the vanished-Job reconciler recording successful
 * runs as `job_missing`. On the shared claim the artifact is written by the POD
 * and the agreement is incidental — both addresses are the same bytes because
 * both are the same volume, so nothing had to be true for the reader to find
 * it. PEN-4932's per-agent claim removes that: the pod's copy is on a volume
 * this process cannot open, and the only artifact the reader can reach is the
 * one PEN-5120's collector persists to the server's OWN `podLogPath`, rooted at
 * `SELF_POD_DATA_MOUNT_PATH`.
 *
 * That makes an incidental agreement load-bearing, and nothing was asserting
 * it. Either root could have moved — the adapter's `buildPodLogPath` template
 * or the server's `runLogBasePath()` — and the only symptom would have been the
 * reader quietly reporting `no_artifact` again for every opted-in agent, which
 * is precisely the pre-PEN-2421 behaviour PEN-5124 exists to keep from
 * returning unannounced. The decision recorded in
 * `docs/plans/2026-10-28-pen-4932-per-agent-volumes.md` §4 stage 4b accepts a
 * residual that is bounded *because* this agreement holds; if it stops holding,
 * the accepted residual is no longer the one that was accepted.
 *
 * ⚠️ Read as source text rather than imported. `paperclip-adapter-claude-k8s` is
 * vendored and is not a workspace member, so importing it from a server test
 * drags in a resolution path that does not exist here. The precedent is
 * `pod-failure-label-corpus.test.ts` and `mcp-seed-scrub-coverage.test.ts`,
 * which audit the same file the same way. The cost is that this pins the
 * adapter's *literal layout*, so a legitimate refactor of `buildPodLogPath`
 * fails here and has to be re-stated — which is the intended behaviour, not a
 * brittleness to work around.
 *
 * ⚠️ Known bound, pre-existing and NOT a per-agent-claim defect: the adapter
 * hardcodes `instances/default` where the server resolves
 * `PAPERCLIP_INSTANCE_ID`. The two agree only while the instance id is
 * `default`, which it is fleet-wide. This affects the shared claim identically,
 * so it is out of PEN-5124's scope — but it is the other way these roots can
 * drift, and it is why the assertions below fix the instance id explicitly
 * instead of reading whatever the ambient environment carries.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const adapterSrc = path.join(repoRoot, "vendor/paperclip-adapter-claude-k8s/src/server");

function readAdapterSource(file: string): string {
  return readFileSync(path.join(adapterSrc, file), "utf-8");
}

/**
 * The volume root from the DEPLOYMENT, not from the adapter.
 *
 * This is the independent anchor, and it is the whole reason the first
 * assertion is a test rather than a tautology: deriving the server's
 * `PAPERCLIP_HOME` from the adapter's own constant would compare a value with
 * itself and pass for any value. `values.yaml` states the binding in as many
 * words — *"Paperclip's `PAPERCLIP_HOME` defaults to `/paperclip`; keep these
 * aligned"* — so it is the right third party to hold both sides to.
 *
 * Scoped to the `persistence:` block rather than matched file-wide: `mountPath`
 * is a two-space key under `runtimeCache` and `runtimeConfig` too, so a
 * file-wide match reads the right value today only because `persistence`
 * happens to come first. Reorder the file and it would either fail with a
 * misleading mismatch or -- worse -- silently bind to a different volume's
 * mount.
 */
function deploymentMountPath(): string {
  const values = readFileSync(path.join(repoRoot, "deploy/helm/paperclip/values.yaml"), "utf-8");

  // From `persistence:` to the next top-level key, so sibling blocks are out of range.
  const block = /^persistence:[^\n]*\n([\s\S]*?)^(?=\S)/m.exec(values);
  expect(block, "values.yaml no longer has a top-level `persistence:` block").not.toBeNull();

  const mount = /^\s{2}mountPath:\s*(\S+)\s*$/m.exec(block![1]!);
  expect(mount, "persistence.mountPath is no longer a scalar in values.yaml").not.toBeNull();
  return mount![1]!;
}

/** The pod-log root the adapter addresses through the SERVER's own mount. */
function adapterServerViewBase(): string {
  const mount = /SELF_POD_DATA_MOUNT_PATH\s*=\s*"([^"]+)"/.exec(readAdapterSource("k8s-client.ts"));
  expect(mount, "SELF_POD_DATA_MOUNT_PATH is no longer a string literal in k8s-client.ts").not.toBeNull();

  // `buildPodLogPath`'s own template, so the layout is read from the producer
  // rather than restated here and left to drift.
  const template = /const base = `\$\{root\}([^`]+)`/.exec(readAdapterSource("job-manifest.ts"));
  expect(template, "buildPodLogPath's `base` template has changed shape").not.toBeNull();

  // `${companyId}/${agentId}` is the per-run tail; everything before it is the base.
  const layout = template![1]!;
  const tail = "/${companyId}/${agentId}";
  expect(layout.endsWith(tail), `buildPodLogPath base no longer ends in ${tail}`).toBe(true);
  return path.posix.join(mount![1]!, layout.slice(0, -tail.length));
}

describe("orphan artifact path agreement (adapter ↔ server)", () => {
  const saved = {
    base: process.env.RUN_LOG_BASE_PATH,
    home: process.env.PAPERCLIP_HOME,
    instance: process.env.PAPERCLIP_INSTANCE_ID,
  };
  const tmpDirs: string[] = [];

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
    }
    for (const [key, value] of [
      ["RUN_LOG_BASE_PATH", saved.base],
      ["PAPERCLIP_HOME", saved.home],
      ["PAPERCLIP_INSTANCE_ID", saved.instance],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("addresses the pod-log volume at the same root the deployment mounts it on", () => {
    // Catches the adapter's mount constant drifting away from the volume the
    // server actually holds — at which point every path below is still
    // internally consistent and all of them point off the volume.
    const mount = /SELF_POD_DATA_MOUNT_PATH\s*=\s*"([^"]+)"/.exec(readAdapterSource("k8s-client.ts"));
    expect(mount).not.toBeNull();
    expect(mount![1]!).toBe(deploymentMountPath());
  });

  it("resolves the server's run-log base to the adapter's server-view pod-log base", () => {
    // The deployed shape: no RUN_LOG_BASE_PATH override, home at the mount the
    // DEPLOYMENT declares, default instance id.
    delete process.env.RUN_LOG_BASE_PATH;
    process.env.PAPERCLIP_HOME = deploymentMountPath();
    process.env.PAPERCLIP_INSTANCE_ID = "default";

    expect(runLogBasePath()).toBe(adapterServerViewBase());
  });

  /**
   * Write an artifact exactly where `buildPodLogPath` would put it under a temp
   * root, and hand the reader the matching base. Real I/O rather than a string
   * comparison: if the `<co>/<agent>/<run>` tail or the filename suffix
   * diverged, this fails where the base-only assertion above would still pass.
   */
  async function seedAtAdapterLayout(isolationKey?: string) {
    const adapterBase = adapterServerViewBase();
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pen5124-path-agreement-"));
    tmpDirs.push(tmp);
    const base = path.join(tmp, adapterBase);

    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    process.env.RUN_LOG_BASE_PATH = base;

    const input = { companyId: randomUUID(), agentId: randomUUID(), runId: randomUUID() };

    // Taken from the WRITER's filename template, never from the reader's own
    // `POD_LOG_SUFFIX`: naming the file with the constant the reader is about
    // to look for would pass for any suffix, which is the same circularity the
    // deployment anchor above exists to avoid.
    const suffix = /return `\$\{dir\}\/\$\{runId\}([^`]+)`/.exec(readAdapterSource("job-manifest.ts"));
    expect(suffix, "buildPodLogPath's filename template has changed shape").not.toBeNull();

    // The nesting segment comes from the WRITER's own `isolationKey ? ... : base`
    // branch too. Hardcoding `"isolated"` here would be a third copy of a name
    // that already exists in both `buildPodLogPath` and `locatePodLogArtifact`,
    // and a third copy cannot witness the two agreeing.
    const nest = /const dir = isolationKey \? `\$\{base\}\/([^/]+)\/\$\{isolationKey\}`/
      .exec(readAdapterSource("job-manifest.ts"));
    expect(nest, "buildPodLogPath's isolated-layout branch has changed shape").not.toBeNull();

    const dir = isolationKey
      ? path.join(base, input.companyId, input.agentId, nest![1]!, isolationKey)
      : path.join(base, input.companyId, input.agentId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${input.runId}${suffix![1]!}`),
      // What `persist` appends: one accepted transcript line per write, the
      // terminal `result` last.
      `${JSON.stringify({ type: "system", subtype: "init" })}\n`
        + `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
      "utf-8",
    );
    return input;
  }

  it("finds a collector-persisted artifact written at the adapter's layout", async () => {
    expect(await readOrphanedRunTerminalResult(await seedAtAdapterLayout())).toMatchObject({
      outcome: "found",
      succeeded: true,
      subtype: "success",
    });
  });

  // `buildPodLogPath` nests an isolated run under `isolated/<key>/`, and
  // `locatePodLogArtifact` has a separate scan for that layout. The two agree
  // on the flat case without agreeing here, so it needs its own assertion.
  it("finds one written at the adapter's isolated layout", async () => {
    expect(await readOrphanedRunTerminalResult(await seedAtAdapterLayout("issue-4242"))).toMatchObject({
      outcome: "found",
      succeeded: true,
      subtype: "success",
    });
  });
});
