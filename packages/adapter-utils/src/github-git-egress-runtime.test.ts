import { describe, expect, it } from "vitest";

import {
  buildGitArgv,
  DEFAULT_HOOKS_DIR,
  GitEgressRuntimeError,
  hooksDirectory,
  runPrePushHook,
} from "./github-git-egress-runtime.js";
import type { GitReader } from "./github-git-egress-shim.js";

const HOOKS = "/hooks";

describe("buildGitArgv", () => {
  it("points a push at the hooks directory that holds the guard", () => {
    expect(buildGitArgv(["push", "origin", "main"], { hooksDir: HOOKS })).toEqual([
      "-c",
      `core.hooksPath=${HOOKS}`,
      "push",
      "origin",
      "main",
    ]);
  });

  it("puts the injected option before the subcommand", () => {
    // git only accepts global options ahead of the subcommand; appending it
    // would make git treat it as a push argument and the hook would not run.
    const argv = buildGitArgv(["push"], { hooksDir: HOOKS });
    expect(argv.indexOf("-c")).toBeLessThan(argv.indexOf("push"));
  });

  it("leaves every non-push invocation completely untouched", () => {
    // Scoping the injection matters: a hooks directory holding only `pre-push`
    // silently disables a repository's pre-commit and commit-msg hooks, so this
    // must not be set globally.
    for (const argv of [["status"], ["commit", "-m", "x"], ["fetch", "origin"], ["log"]]) {
      expect(buildGitArgv(argv, { hooksDir: HOOKS })).toEqual(argv);
    }
  });

  it("refuses the flag that would skip the hook", () => {
    // Without this the whole control is one flag away from being off.
    expect(() => buildGitArgv(["push", "--no-verify"], { hooksDir: HOOKS })).toThrow(
      GitEgressRuntimeError,
    );
    expect(() => buildGitArgv(["push", "-n"], { hooksDir: HOOKS })).toThrow(/--no-verify is disabled/);
  });

  it("still guards a push reached through an alias", () => {
    const argv = buildGitArgv(["yolo"], {
      hooksDir: HOOKS,
      resolveAlias: (name) => (name === "yolo" ? "push --force" : null),
    });
    expect(argv).toEqual(["-c", `core.hooksPath=${HOOKS}`, "yolo"]);
  });
});

describe("hooksDirectory", () => {
  it("defaults to the path the Helm seed writes", () => {
    expect(hooksDirectory({})).toBe(DEFAULT_HOOKS_DIR);
  });

  it("is overridable, so the guard is testable outside a pod", () => {
    expect(hooksDirectory({ PAPERCLIP_GIT_EGRESS_HOOKS_DIR: "/x" })).toBe("/x");
  });
});

describe("runPrePushHook", () => {
  const dump = ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHOES"]
    .map((name, index) => `${name}=value-${index}`)
    .join("\n");

  const dirtyGit: GitReader = (args) => {
    if (args[0] === "rev-list") return "c0ffee0000000000\n";
    if (args.includes("--format=%s")) return "wip";
    if (args.includes("--format=%B")) return `wip\n\n${dump}\n`;
    return "";
  };

  it("exits zero when there is nothing to publish", async () => {
    const code = await runPrePushHook({
      input: "",
      runGit: () => {
        throw new Error("git must not be consulted");
      },
    });
    expect(code).toBe(0);
  });

  it("exits zero for a clean push", async () => {
    const code = await runPrePushHook({
      input: "refs/heads/m a refs/heads/m b\n",
      runGit: (args) => {
        if (args[0] === "rev-list") return "abc\n";
        if (args.includes("--format=%s")) return "clean";
        if (args.includes("--format=%B")) return "clean\n";
        return "";
      },
    });
    expect(code).toBe(0);
  });

  it("aborts the push and explains which commit to amend", async () => {
    const errors: string[] = [];
    const code = await runPrePushHook({
      input: "refs/heads/m a refs/heads/m b\n",
      runGit: dirtyGit,
      stderr: (message) => errors.push(message),
    });
    // Non-zero is what actually stops the push; the text is what makes it
    // actionable rather than a bare rejection.
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("c0ffee000000");
    expect(errors.join("\n")).toContain("environment-dump");
  });
});
