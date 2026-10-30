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

    it("drops empty segments — the one way the round trip is not a literal identity", () => {
      // PEN-5066. guardedChildEnv() splits and rejoins, so an empty segment
      // does not survive. Pinned rather than merely documented, because the
      // comment on ensurePathInEnv() now claims exactly this much and no more.
      // The direction is toward safety: an empty POSIX segment means the
      // current working directory, so this removes an implicit cwd-on-PATH.
      //
      // Mutation-testing this found the drop is enforced TWICE — split() in
      // egress-guard-path.ts filters empty entries, and guardedPath() filters
      // them again when it builds `rest`. Removing either one alone leaves
      // this case green; only removing both turns the round trip back into a
      // literal identity. So neither filter is independently load-bearing
      // here, and a future tidy-up that deletes "the redundant one" is a
      // behaviour change this case will not catch on its own.
      expect(ensurePathInEnv({ PATH: "/tmp/stub::/usr/bin" }).PATH).toBe("/tmp/stub:/usr/bin");
      expect(ensurePathInEnv({ PATH: "/tmp/stub: :/usr/bin" }).PATH).toBe("/tmp/stub:/usr/bin");
    });
  });

  describe("the Windows `Path` spelling", () => {
    // PEN-5066. The early return is keyed on the environment map, not on
    // process.platform, so it fires here on Linux too. Each case below is
    // tied to one conjunct of that guard and fails if the conjunct is removed.
    beforeEach(() => {
      process.env.PATH = `${GUARD}:/usr/local/bin:/usr/bin:/bin`;
    });

    it("returns an environment carrying only `Path` exactly as it was", () => {
      // Drop the early return entirely and this fails: with no `PATH` key,
      // guardedChildEnv() substitutes the guarded default and adds it.
      expect(ensurePathInEnv({ Path: "C:\\Windows\\System32", FOO: "bar" })).toEqual({
        Path: "C:\\Windows\\System32",
        FOO: "bar",
      });
    });

    it("still guards when both spellings are present — `PATH` is what the child reads", () => {
      // Drop the `!hasPath` conjunct and this fails: the environment returns
      // untouched and the narrowed PATH keeps no guard.
      expect(ensurePathInEnv({ PATH: "/tmp/stub", Path: "C:\\x" }).PATH).toBe(`${GUARD}:/tmp/stub`);
    });

    it("treats an empty `Path` as absent, exactly as it treats an empty `PATH`", () => {
      // Drop the `Path.length > 0` conjunct and this fails: the early return
      // fires on the empty string and no PATH is supplied at all.
      expect(ensurePathInEnv({ Path: "" }).PATH?.split(":")[0]).toBe(GUARD);
    });
  });
});
