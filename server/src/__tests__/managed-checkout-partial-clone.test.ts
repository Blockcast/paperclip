/**
 * BLO-31351 / BLO-31338: the managed-checkout partial-clone guard.
 *
 * Driven against real git repositories rather than mocks, because the property
 * under test is one no mock can witness: whether a checkout can *serve* a clone.
 * The `file://` transport is mandatory throughout -- git clones a plain local
 * path by hardlinking objects, which never invokes `upload-pack` and therefore
 * passes even on a source that cannot serve. That silent pass is what let the
 * original defect hide, so the probe here uses `file://` for exactly the reason
 * the incident did.
 */

import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  countMissingObjects,
  ensureManagedCheckoutCanServeClones,
  PARTIAL_CLONE_MISSING_SCAN_CAP,
  REMOTE_ORIGIN_PARTIAL_CLONE_FILTER_KEY,
  REMOTE_ORIGIN_PROMISOR_KEY,
} from "../services/managed-checkout-partial-clone.js";

const execFile = promisify(execFileCallback);

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Partial Clone Test",
  GIT_AUTHOR_EMAIL: "partial-clone-test@example.invalid",
  GIT_COMMITTER_NAME: "Partial Clone Test",
  GIT_COMMITTER_EMAIL: "partial-clone-test@example.invalid",
};

async function git(args: string[], cwd: string) {
  return await execFile("git", args, { cwd, env: GIT_ENV, maxBuffer: 32 * 1024 * 1024 });
}

let root: string;
/**
 * Two upstreams, because the two states under test are produced by whether the
 * *server* honours the filter -- and that difference is the whole subject.
 *
 * - `uploadpack.allowFilter` off: git prints "filtering not recognized by
 *   server, ignoring", sends every object anyway, and *still* records
 *   `partialclonefilter`/`promisor` in the clone's config. That is the
 *   partial-config-but-nothing-missing shape, which serves clones perfectly
 *   well and is the latent trap.
 * - `uploadpack.allowFilter` on: the blobs are genuinely withheld, so the clone
 *   cannot pack them for anyone else. That is the shape that strands runs.
 *
 * Verified against git in this image: the second one reproduces the incident's
 * pod log byte-for-byte, while `git fsck` on it exits clean.
 */
let upstreamNoFilter: string;
let upstreamAllowFilter: string;

/** A source repo with enough distinct blobs that a filtered clone omits some. */
async function buildUpstream(dir: string, allowFilter: boolean) {
  await fs.mkdir(dir, { recursive: true });
  await git(["init", "--initial-branch=main", "--quiet"], dir);
  if (allowFilter) {
    await git(["config", "uploadpack.allowFilter", "true"], dir);
    await git(["config", "uploadpack.allowAnySHA1InWant", "true"], dir);
  }
  for (let index = 0; index < 4; index += 1) {
    await fs.writeFile(path.join(dir, `file-${index}.txt`), `contents ${index}\n${"padding ".repeat(64)}`);
    await git(["add", "."], dir);
    await git(["commit", "--quiet", "-m", `commit ${index}`], dir);
  }
}

async function readConfig(cwd: string, key: string): Promise<string | null> {
  return await git(["config", "--get", key], cwd)
    .then((result) => result.stdout.trim() || null)
    .catch(() => null);
}

/** The exact probe from the acceptance criteria. `file://` is load-bearing. */
async function cloneProbeExitCode(source: string): Promise<number> {
  const target = await fs.mkdtemp(path.join(root, "probe-"));
  await fs.rm(target, { recursive: true, force: true });
  try {
    await git(["clone", "--no-tags", "--single-branch", `file://${source}`, target], root);
    return 0;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "number" ? code : 1;
  }
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-partial-clone-"));
  upstreamNoFilter = path.join(root, "upstream-no-filter");
  upstreamAllowFilter = path.join(root, "upstream-allow-filter");
  await buildUpstream(upstreamNoFilter, false);
  await buildUpstream(upstreamAllowFilter, true);
}, 180_000);

afterAll(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("ensureManagedCheckoutCanServeClones", () => {
  it("no-ops on a directory carrying no git metadata", async () => {
    const plain = path.join(root, "plain-dir");
    await fs.mkdir(plain, { recursive: true });

    // This is the hazard `ensureCheckoutGitIdentity` documents: `git config`
    // walks UP from its cwd, so a repo-less managed dir nested under an ancestor
    // repository must not be probed at all. Assert we never shelled out.
    const calls: string[][] = [];
    const result = await ensureManagedCheckoutCanServeClones({
      cwd: plain,
      runGit: async (args) => {
        calls.push(args);
        return "";
      },
    });

    expect(result.state).toBe("not_a_checkout");
    expect(calls).toEqual([]);
    expect(result.warning).toBeNull();
    expect(result.fatalMessage).toBeNull();
  });

  it("no-ops on a null cwd", async () => {
    const result = await ensureManagedCheckoutCanServeClones({ cwd: null });
    expect(result.state).toBe("not_a_checkout");
  });

  it("leaves an ordinary full clone untouched and serving", async () => {
    const full = path.join(root, "full-clone");
    await git(["clone", "--quiet", `file://${upstreamNoFilter}`, full], root);

    const result = await ensureManagedCheckoutCanServeClones({ cwd: full });

    expect(result.state).toBe("not_partial");
    expect(result.warning).toBeNull();
    expect(result.fatalMessage).toBeNull();
    // The AC's own signal, on the healthy path.
    await expect(cloneProbeExitCode(full)).resolves.toBe(0);
  }, 60_000);

  it("clears the filter on a partial clone whose objects are all present, and keeps it servable", async () => {
    // Cloned from the upstream that refuses to filter, so the config is recorded
    // but nothing is actually withheld. This is the real-world latent shape:
    // measured on `magma-blo-29040`, which was `blob:none` + `promisor=true`
    // with `missing=0` and cloned exit 0.
    const partial = path.join(root, "partial-complete");
    await git(["clone", "--quiet", "--filter=blob:none", `file://${upstreamNoFilter}`, partial], root);

    expect(await readConfig(partial, REMOTE_ORIGIN_PARTIAL_CLONE_FILTER_KEY)).toBe("blob:none");
    await expect(countMissingObjects(partial)).resolves.toMatchObject({ count: 0 });

    const result = await ensureManagedCheckoutCanServeClones({ cwd: partial });

    expect(result.state).toBe("partial_repaired");
    expect(result.missingObjectCount).toBe(0);
    // The message must name the filter, per the AC.
    expect(result.warning).toContain("blob:none");
    expect(result.fatalMessage).toBeNull();

    // The whole point: the config that manufactures missing objects on every
    // later fetch is gone.
    expect(await readConfig(partial, REMOTE_ORIGIN_PARTIAL_CLONE_FILTER_KEY)).toBeNull();
    expect(await readConfig(partial, REMOTE_ORIGIN_PROMISOR_KEY)).toBeNull();
    await expect(cloneProbeExitCode(partial)).resolves.toBe(0);
  }, 120_000);

  it("refuses a partial clone that is missing objects, naming the filter and not calling it corruption", async () => {
    // Cloned from the upstream that DOES honour the filter, so the blobs are
    // genuinely absent. Verified separately: the `file://` clone probe against
    // this shape reproduces the incident pod log byte-for-byte while `git fsck`
    // exits clean -- nothing is corrupt.
    const unservable = path.join(root, "partial-missing");
    await git(
      ["clone", "--quiet", "--filter=blob:none", "--no-checkout", `file://${upstreamAllowFilter}`, unservable],
      root,
    );

    const missing = await countMissingObjects(unservable);
    expect(missing.count).toBeGreaterThan(0);
    // Guard the fixture itself: if a future git stops withholding here, this
    // test would silently start exercising the repair path instead.
    expect(await cloneProbeExitCode(unservable)).not.toBe(0);

    const result = await ensureManagedCheckoutCanServeClones({ cwd: unservable });

    expect(result.state).toBe("partial_cannot_serve");
    expect(result.missingObjectCount).toBeGreaterThan(0);
    expect(result.fatalMessage).toBeTruthy();
    // Error text names the real reason (the filter), per the AC.
    expect(result.fatalMessage).toContain("blob:none");
    expect(result.fatalMessage).toContain(REMOTE_ORIGIN_PARTIAL_CLONE_FILTER_KEY);
    // ...and explicitly contradicts git's misleading wording, which is the
    // diagnosis this whole change exists to stop people reaching for.
    expect(result.fatalMessage).toMatch(/which is false/i);
    // Evidence is structured for the workspaceValidation payload.
    expect(result.evidence).toMatchObject({ partialCloneFilter: "blob:none" });
    // It must not "repair" a repo it cannot repair: the config is untouched, so
    // the checkout can still lazily fetch what it lacks.
    expect(await readConfig(unservable, REMOTE_ORIGIN_PROMISOR_KEY)).toBe("true");
  }, 120_000);

  it("reports indeterminate rather than failing the run when the object scan errors", async () => {
    const partial = path.join(root, "partial-scan-error");
    await git(["clone", "--quiet", "--filter=blob:none", `file://${upstreamNoFilter}`, partial], root);

    const result = await ensureManagedCheckoutCanServeClones({
      cwd: partial,
      countMissing: async () => {
        throw new Error("git rev-list timed out after 120000ms");
      },
    });

    // Fail open: an inconclusive probe must not take a run down, but it must say
    // where a later fake-corruption error would be coming from.
    expect(result.state).toBe("indeterminate");
    expect(result.fatalMessage).toBeNull();
    expect(result.warning).toContain("blob:none");
    expect(result.warning).toMatch(/possible repository corruption/i);
    // Untouched, because we do not know whether unsetting is safe.
    expect(await readConfig(partial, REMOTE_ORIGIN_PARTIAL_CLONE_FILTER_KEY)).toBe("blob:none");
  }, 120_000);

  it("treats a lone promisor key as partial even without a filter key", async () => {
    // Either key alone makes later fetches manufacture missing objects, so the
    // detection is a union. A conjunction would miss a half-cleared repo.
    const promisorOnly = path.join(root, "promisor-only");
    await git(["clone", "--quiet", `file://${upstreamNoFilter}`, promisorOnly], root);
    await git(["config", REMOTE_ORIGIN_PROMISOR_KEY, "true"], promisorOnly);

    const result = await ensureManagedCheckoutCanServeClones({ cwd: promisorOnly });

    expect(result.state).toBe("partial_repaired");
    expect(result.promisor).toBe("true");
    expect(await readConfig(promisorOnly, REMOTE_ORIGIN_PROMISOR_KEY)).toBeNull();
  }, 120_000);

  it("surfaces a warning rather than a failure when the config unset is refused", async () => {
    const partial = path.join(root, "partial-unset-refused");
    await git(["clone", "--quiet", `file://${upstreamNoFilter}`, partial], root);
    await git(["config", REMOTE_ORIGIN_PROMISOR_KEY, "true"], partial);

    const result = await ensureManagedCheckoutCanServeClones({
      cwd: partial,
      runGit: async (args, cwd) => {
        if (args[0] === "config" && args[1] === "--unset") {
          throw new Error("could not lock config file .git/config: Permission denied");
        }
        return (await git(args, cwd)).stdout;
      },
    });

    // It still serves today, so an unwritable config must not fail the run.
    expect(result.state).toBe("partial_repair_failed");
    expect(result.fatalMessage).toBeNull();
    expect(result.warning).toContain("Permission denied");
  }, 120_000);

  it("counts missing objects as zero on a healthy full clone", async () => {
    const full = path.join(root, "full-for-count");
    await git(["clone", "--quiet", `file://${upstreamNoFilter}`, full], root);
    await expect(countMissingObjects(full)).resolves.toMatchObject({ count: 0, truncated: false });
  }, 60_000);

  it("still returns a verdict when the missing-object scan is truncated at the cap", async () => {
    // The cap path kills `git rev-list` mid-walk, and that kill (plus the
    // resulting write to a closed stdout) can surface as an `error` event racing
    // `close`. If an error won that race, a repository with more missing objects
    // than the cap would come back `indeterminate` -- warn-and-proceed on the
    // single worst case, which then dies later reporting fake corruption. So
    // truncation must beat any error, and a truncated count must still yield the
    // fatal verdict rather than the repair one.
    const unservable = path.join(root, "partial-missing-capped");
    await git(
      ["clone", "--quiet", "--filter=blob:none", "--no-checkout", `file://${upstreamAllowFilter}`, unservable],
      root,
    );

    const result = await ensureManagedCheckoutCanServeClones({
      cwd: unservable,
      // Simulate the cap firing. The real cap is 10k objects, which is too large
      // to build a fixture for; what matters is that a truncated count is still
      // treated as a decided verdict.
      countMissing: async () => ({ count: PARTIAL_CLONE_MISSING_SCAN_CAP, truncated: true }),
    });

    expect(result.state).toBe("partial_cannot_serve");
    expect(result.missingObjectCountTruncated).toBe(true);
    // Reported as a floor, not as an exact figure we did not measure.
    expect(result.fatalMessage).toContain(`at least ${PARTIAL_CLONE_MISSING_SCAN_CAP}`);
    expect(result.evidence).toMatchObject({ missingObjectCountTruncated: true });
  }, 120_000);
});
