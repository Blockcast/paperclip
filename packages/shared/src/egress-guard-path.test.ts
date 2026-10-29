import { describe, expect, it } from "vitest";
import {
  CONFSTR_DEFAULT_PATH,
  EGRESS_GUARD_BIN_DIR,
  EGRESS_GUARD_BIN_DIRS,
  guardedChildEnv,
  guardedPath,
  guardEntriesOn,
} from "./egress-guard-path.js";

const GUARD = EGRESS_GUARD_BIN_DIR;
const AMBIENT_WITH_GUARD = `${GUARD}:/usr/local/bin:/usr/bin:/bin`;
const AMBIENT_WITHOUT_GUARD = "/usr/local/bin:/usr/bin:/bin";

describe("egress guard PATH construction (PEN-5030)", () => {
  it("pins the guard directory the agent image installs wrappers into", () => {
    expect(EGRESS_GUARD_BIN_DIR).toBe("/usr/local/libexec/paperclip/bin");
    expect(EGRESS_GUARD_BIN_DIRS).toContain(EGRESS_GUARD_BIN_DIR);
  });

  describe("guardEntriesOn", () => {
    it("finds the guard on an ambient PATH that has it", () => {
      expect(guardEntriesOn(AMBIENT_WITH_GUARD)).toEqual([GUARD]);
    });

    it("finds nothing where no wrapper is installed", () => {
      expect(guardEntriesOn(AMBIENT_WITHOUT_GUARD)).toEqual([]);
      expect(guardEntriesOn("")).toEqual([]);
    });

    it("defaults to the live ambient PATH, so `undefined` means `read it`", () => {
      // Not a no-op argument: `undefined` selects the default parameter, which
      // is process.env.PATH. Pass "" to mean "no ambient PATH at all".
      const live = guardEntriesOn();
      expect(guardEntriesOn(undefined)).toEqual(live);
      expect(guardEntriesOn("")).toEqual([]);
    });

    it("does not report a duplicate twice", () => {
      expect(guardEntriesOn(`${GUARD}:/usr/bin:${GUARD}`)).toEqual([GUARD]);
    });
  });

  describe("guardedPath", () => {
    it("restores the guard in front of a narrowed PATH", () => {
      expect(guardedPath(["/tmp/stub", "/usr/bin"], AMBIENT_WITH_GUARD)).toBe(
        `${GUARD}:/tmp/stub:/usr/bin`,
      );
    });

    it("is an identity on the caller's entries where no guard is installed", () => {
      // The `preserve, never add` invariant: adopting these helpers on a CI
      // runner or a laptop cannot introduce a resolution path the parent
      // process did not already have.
      expect(guardedPath(["/tmp/stub", "/usr/bin"], AMBIENT_WITHOUT_GUARD)).toBe(
        "/tmp/stub:/usr/bin",
      );
      expect(guardedPath(["/tmp/stub"], "")).toBe("/tmp/stub");
    });

    it("hoists rather than duplicates a guard the caller already listed", () => {
      expect(guardedPath(["/tmp/stub", GUARD], AMBIENT_WITH_GUARD)).toBe(`${GUARD}:/tmp/stub`);
    });

    it("drops empty segments", () => {
      expect(guardedPath(["", "  ", "/usr/bin"], AMBIENT_WITHOUT_GUARD)).toBe("/usr/bin");
    });
  });

  describe("guardedChildEnv", () => {
    it("cannot be handed an environment that expresses a guard-less PATH", () => {
      // Passing `{}` is the whole point of the unset branch.
      expect(guardedChildEnv({}, { ambient: AMBIENT_WITH_GUARD }).PATH).toBe(
        [GUARD, ...CONFSTR_DEFAULT_PATH].join(":"),
      );
    });

    it("treats an empty PATH as unset, the way execvp does", () => {
      expect(guardedChildEnv({ PATH: "" }, { ambient: AMBIENT_WITH_GUARD }).PATH).toBe(
        [GUARD, ...CONFSTR_DEFAULT_PATH].join(":"),
      );
    });

    it("keeps a caller's richer substituted default when one is supplied", () => {
      // server-utils' defaultPathForPlatform() shape: the caller's intent for
      // the unset case is preserved exactly, with the guard added in front.
      const fallback = ["/usr/local/bin", "/usr/bin", "/bin", "/sbin"];
      expect(guardedChildEnv({}, { ambient: AMBIENT_WITH_GUARD, fallback }).PATH).toBe(
        [GUARD, ...fallback].join(":"),
      );
    });

    it("narrows to the caller's own entries with the guard in front", () => {
      expect(
        guardedChildEnv({ PATH: "/tmp/stub:/usr/bin" }, { ambient: AMBIENT_WITH_GUARD }).PATH,
      ).toBe(`${GUARD}:/tmp/stub:/usr/bin`);
    });

    it("leaves every other variable alone", () => {
      const out = guardedChildEnv({ FOO: "bar" }, { ambient: AMBIENT_WITHOUT_GUARD });
      expect(out.FOO).toBe("bar");
    });

    it("is an identity on PATH where no guard is installed", () => {
      expect(
        guardedChildEnv({ PATH: "/tmp/stub:/usr/bin" }, { ambient: AMBIENT_WITHOUT_GUARD }).PATH,
      ).toBe("/tmp/stub:/usr/bin");
    });
  });
});
