import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENT_SUBJECT_EVALUATIONS,
  BOARD_ONLY_PERMISSION_KEYS,
  PERMISSION_KEYS,
  agentSubjectEvaluationForGrant,
  permissionKeyIsBoardOnly,
} from "@paperclipai/shared";

// PEN-6373. `BOARD_ONLY_PERMISSION_KEYS` claims that no agent-reachable call
// site evaluates these keys in the AGENT subject space, and `GET /agents/me`
// publishes that claim to the seat holding the grant. A comment cannot hold
// the property: the failure mode is an author who adds an agent-space reader
// and never opens `constants.ts`, after which the route tells a seat its live
// grant is inert.
//
// The direction matters. A stale `"none"` is the FALSE-NEGATIVE direction —
// it denies capability that exists, and nothing ever reports the work a false
// "inert" deterred. So these tests are built to fail when the list becomes
// over-inclusive, which is the opposite of what most authorization tests
// guard.
const serverSrc = fileURLToPath(new URL("..", import.meta.url));

// The complete set of non-test files allowed to name a board-only key. A THIRD
// file naming one is not a failure of this test — it is the prompt the
// docblock asks for: decide whether the key is still board-only, and either
// remove it from the list or add the file here having checked it is behind
// `assertBoard`.
const ALLOWED_READERS = ["routes/tool-access.ts", "routes/tool-gateway.ts"];

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "node_modules" || entry === "__tests__" ? [] : sourceFiles(full);
    }
    return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
  });

const filesNaming = (permissionKey: string) =>
  sourceFiles(serverSrc)
    .filter((file) => readFileSync(file, "utf8").includes(`"${permissionKey}"`))
    .map((file) => relative(serverSrc, file))
    .sort();

describe("board-only permission keys", () => {
  it("declares only real permission keys", () => {
    for (const key of BOARD_ONLY_PERMISSION_KEYS) {
      expect(PERMISSION_KEYS).toContain(key);
    }
  });

  it("has no vocabulary for asserting that an agent grant DOES work", () => {
    // Load-bearing, not cosmetic. No census of agent-evaluable keys has been
    // taken, so a `"supported"` member would be an assertion nobody verified —
    // and it would be read as capability by the one audience least able to
    // check it. Adding one needs that census first.
    expect([...AGENT_SUBJECT_EVALUATIONS].sort()).toEqual(["none", "unclassified"]);
  });

  it("classifies the same key differently per subject space", () => {
    // The whole finding is that `tools:admin` is LIVE in the `"user"` space
    // and inert in the `"agent"` one. A key-only signature would invite the
    // conflation this exists to remove.
    expect(agentSubjectEvaluationForGrant({ principalType: "agent", permissionKey: "tools:admin" }))
      .toBe("none");
    expect(agentSubjectEvaluationForGrant({ principalType: "user", permissionKey: "tools:admin" }))
      .toBe("unclassified");
  });

  it("reports an unlisted key as unclassified, never as live", () => {
    expect(agentSubjectEvaluationForGrant({ principalType: "agent", permissionKey: "tasks:assign" }))
      .toBe("unclassified");
    expect(permissionKeyIsBoardOnly("tasks:assign")).toBe(false);
  });

  it("is named by no reader outside the allowed set", () => {
    const unexpected = BOARD_ONLY_PERMISSION_KEYS.flatMap((key) =>
      filesNaming(key)
        .filter((file) => !ALLOWED_READERS.includes(file))
        .map((file) => `${key} named by ${file}`),
    );
    expect(unexpected).toEqual([]);
  });

  it("every allowed reader still gates on assertBoard", () => {
    // Membership of the list asserts that an agent is refused on ACTOR TYPE
    // before the key is read. If one of these files stops calling
    // `assertBoard`, that premise is gone and the key may have become
    // agent-reachable.
    for (const file of ALLOWED_READERS) {
      expect(readFileSync(join(serverSrc, file), "utf8")).toContain("assertBoard");
    }
  });

  it("tools:manage_profiles has no evaluator in any subject space", () => {
    // Its ground for membership is different from, and stronger than, the
    // other four — stated separately so neither argument is read as covering
    // the other. If this ever gains a reader it is no longer inert outright,
    // and whether it is still agent-inert must be re-decided.
    expect(filesNaming("tools:manage_profiles")).toEqual([]);
  });

  it("actually scanned the files it claims to cover", () => {
    // Guards the silent-pass direction: a moved source root or a broken walk
    // makes "named by no reader outside the allowed set" vacuously true, and a
    // vacuous pass is indistinguishable from a real one.
    const scanned = sourceFiles(serverSrc).map((file) => relative(serverSrc, file));
    for (const file of [...ALLOWED_READERS, "routes/agents.ts", "services/access.ts"]) {
      expect(scanned).toContain(file);
    }
  });

  it("the scan can still FIRE — it finds the readers that do exist", () => {
    // The other half of the vacuity guard. If the quoting or the walk regress,
    // `filesNaming` returns `[]` for everything and both scans above pass
    // while guarding nothing.
    expect(filesNaming("tools:admin")).toEqual(["routes/tool-access.ts", "routes/tool-gateway.ts"]);
  });
});
