// PEN-4518. This adapter carries its own copy of the pre-push hook path
// constants (see the header of `github-git-hooks-path.ts` for why the obvious
// import is not available to a package that is built standalone). A copy that
// nothing compares is the exact defect PEN-4518 was: the seed, the runtime and
// the Job manifest each spelled this path independently, every suite was green,
// and the fleet could not push for 2h17m. So the copy is only acceptable with
// this test holding it down.
//
// Same trade, and the same reason, as `pod-log-redactor.test.ts` makes against
// `command-redaction.ts`.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import {
  DEFAULT_DATA_MOUNT_PATH,
  DEFAULT_HOOKS_DIR,
  GIT_HOOKS_SUBPATH,
  hooksDirForDataMount,
} from "./github-git-hooks-path.js";

const LOCAL_SOURCE_PATH = fileURLToPath(new URL("./github-git-hooks-path.ts", import.meta.url));
const CANONICAL_SOURCE_PATH = fileURLToPath(
  new URL("../../../../packages/adapter-utils/src/github-git-hooks-path.ts", import.meta.url),
);

/**
 * Strip comments and collapse whitespace, leaving only executable content.
 *
 * Conservative on purpose: whole-line `//` and `*` continuations only, never a
 * mid-line `//`, so the `/\/+$/` in `hooksDirForDataMount` cannot be eaten as a
 * comment. The two files differ ONLY in their header prose, so once that is
 * gone the remainder has to match byte for byte.
 */
function executableContent(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//") && !line.startsWith("*"))
    .join(" ")
    .replace(/\s+/g, " ");
}

describe("github-git-hooks-path stays in parity with packages/adapter-utils", () => {
  it("can see the canonical declaration", () => {
    // Vacuity control. Every assertion below reads this file; if the path ever
    // stops resolving they would all pass against an empty string instead.
    expect(
      existsSync(CANONICAL_SOURCE_PATH),
      `canonical source not found at ${CANONICAL_SOURCE_PATH} — if the monorepo layout moved, repoint this test rather than deleting it`,
    ).toBe(true);
  });

  it("is byte-identical to the canonical file once header prose is removed", () => {
    const local = executableContent(readFileSync(LOCAL_SOURCE_PATH, "utf8"));
    const canonical = executableContent(readFileSync(CANONICAL_SOURCE_PATH, "utf8"));

    // Second vacuity control: if `executableContent` ever over-strips, both
    // sides collapse to "" and the equality below passes for the wrong reason.
    expect(canonical).toContain("GIT_HOOKS_SUBPATH");
    expect(canonical).toContain("hooksDirForDataMount");
    expect(canonical.length).toBeGreaterThan(200);

    // Catches all three drift shapes at once: a changed literal, a reimplemented
    // function body, and an export added on one side only.
    expect(local).toBe(canonical);
  });

  it("composes the directory the egress runtime will actually look in", () => {
    expect(GIT_HOOKS_SUBPATH).toBe(".local/share/paperclip-git-hooks");
    expect(DEFAULT_DATA_MOUNT_PATH).toBe("/paperclip");
    expect(DEFAULT_HOOKS_DIR).toBe("/paperclip/.local/share/paperclip-git-hooks");
  });

  it("normalises the mount point rather than emitting a root-relative path", () => {
    expect(hooksDirForDataMount("/data")).toBe(`/data/${GIT_HOOKS_SUBPATH}`);
    expect(hooksDirForDataMount("/data/")).toBe(`/data/${GIT_HOOKS_SUBPATH}`);
    expect(hooksDirForDataMount("/data///")).toBe(`/data/${GIT_HOOKS_SUBPATH}`);
    // `//.local/...` would miss the mount silently; fall back instead.
    expect(hooksDirForDataMount("")).toBe(DEFAULT_HOOKS_DIR);
    expect(hooksDirForDataMount("///")).toBe(DEFAULT_HOOKS_DIR);
  });
});

