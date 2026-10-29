import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EGRESS_GUARD_BIN_DIR } from "./egress-guard-path.js";
import { defaultPathForPlatform, ensurePathInEnv } from "./server-utils.js";

/**
 * PEN-5030. ensurePathInEnv() supplies the `PATH` every child spawned through
 * runProcess() resolves against, so it is the chokepoint where the git egress
 * guard is kept or lost. Its substituted default is a hardcoded literal that
 * structurally cannot contain the guard directory, which is why the unset
 * branch needed the fix as much as the narrowed one.
 */
describe("ensurePathInEnv keeps the git egress guard (PEN-5030)", () => {
  const GUARD = EGRESS_GUARD_BIN_DIR;
  let realPath: string | undefined;

  beforeEach(() => {
    realPath = process.env.PATH;
  });

  afterEach(() => {
    if (realPath === undefined) delete process.env.PATH;
    else process.env.PATH = realPath;
  });

  describe("where the agent image has installed the wrapper", () => {
    beforeEach(() => {
      process.env.PATH = `${GUARD}:/usr/local/bin:/usr/bin:/bin`;
    });

    it("keeps the guard when PATH is unset — the hardcoded default cannot carry it", () => {
      const out = ensurePathInEnv({ FOO: "bar" });
      expect(out.PATH?.split(":")[0]).toBe(GUARD);
      // ...and the caller's substituted default is otherwise preserved intact.
      for (const entry of defaultPathForPlatform().split(":")) {
        expect(out.PATH?.split(":")).toContain(entry);
      }
      expect(out.FOO).toBe("bar");
    });

    it("keeps the guard when PATH is empty", () => {
      expect(ensurePathInEnv({ PATH: "" }).PATH?.split(":")[0]).toBe(GUARD);
    });

    it("restores the guard in front of a narrowed PATH", () => {
      expect(ensurePathInEnv({ PATH: "/tmp/stub:/usr/bin" }).PATH).toBe(
        `${GUARD}:/tmp/stub:/usr/bin`,
      );
    });

    it("leaves a PATH that already leads with the guard untouched", () => {
      // The production shape: runProcess() merges process.env first, so on the
      // agent image this branch is a no-op and nothing about dispatch changes.
      const ambient = `${GUARD}:/usr/local/bin:/usr/bin:/bin`;
      expect(ensurePathInEnv({ PATH: ambient }).PATH).toBe(ambient);
    });
  });

  describe("where no wrapper is installed (CI runner, laptop)", () => {
    beforeEach(() => {
      process.env.PATH = "/usr/local/bin:/usr/bin:/bin";
    });

    it("is an identity on a supplied PATH", () => {
      expect(ensurePathInEnv({ PATH: "/tmp/stub:/usr/bin" }).PATH).toBe("/tmp/stub:/usr/bin");
    });

    it("still substitutes exactly the default it always did", () => {
      expect(ensurePathInEnv({ FOO: "bar" }).PATH).toBe(defaultPathForPlatform());
    });
  });
});
