import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  resolvePaperclipInstanceRoot,
  resolveRunLogBasePath,
  resolveRunLogBasePathOverride,
} from "./home-paths.js";

// PEN-5466. `RUN_LOG_BASE_PATH` used to be read with `??` at both of its two
// call sites. `""` is not nullish, so it was honoured -- and `""` is a RELATIVE
// root, so run logs landed under whatever cwd the process happened to hold
// rather than under the instance root. A k8s env entry with `value: ""`
// produces exactly that. These pin the single resolver both call sites now
// share.
describe("run-log base path resolution", () => {
  const saved = process.env.RUN_LOG_BASE_PATH;

  afterEach(() => {
    if (saved === undefined) delete process.env.RUN_LOG_BASE_PATH;
    else process.env.RUN_LOG_BASE_PATH = saved;
  });

  /** The fallback, derived the same way the resolver does -- from PAPERCLIP_HOME. */
  const instanceDefault = () => path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");

  it("honours an override that names a directory", () => {
    const root = path.join(os.tmpdir(), "pen5466-explicit-root");
    process.env.RUN_LOG_BASE_PATH = root;
    expect(resolveRunLogBasePathOverride()).toBe(root);
    expect(resolveRunLogBasePath()).toBe(root);
  });

  it("falls back to the instance root when the override is unset", () => {
    delete process.env.RUN_LOG_BASE_PATH;
    expect(resolveRunLogBasePathOverride()).toBeUndefined();
    expect(resolveRunLogBasePath()).toBe(instanceDefault());
  });

  // The regression itself. Whitespace-only rides along: it cannot be a usable
  // root either, and the `?.trim() || undefined` read the run-log store already
  // uses for its S3 settings folds both onto the same branch.
  for (const blank of ["", " ", "\t\n "]) {
    it(`treats ${JSON.stringify(blank)} as unset rather than as a cwd-relative root`, () => {
      process.env.RUN_LOG_BASE_PATH = blank;
      expect(resolveRunLogBasePathOverride()).toBeUndefined();
      const resolved = resolveRunLogBasePath();
      expect(resolved).toBe(instanceDefault());
      // The property that actually costs someone an hour: a relative root moves
      // with the process. Asserting absoluteness catches a future resolver that
      // returns the blank value by some other route.
      expect(path.isAbsolute(resolved)).toBe(true);
    });
  }

  it("trims a padded override, matching the store's own S3 reads", () => {
    const root = path.join(os.tmpdir(), "pen5466-padded-root");
    process.env.RUN_LOG_BASE_PATH = `  ${root}\n`;
    expect(resolveRunLogBasePathOverride()).toBe(root);
    expect(resolveRunLogBasePath()).toBe(root);
  });
});
