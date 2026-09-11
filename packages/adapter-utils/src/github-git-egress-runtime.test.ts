import { describe, expect, it } from "vitest";

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildGitArgv,
  DEFAULT_HOOKS_DIR,
  GitEgressRuntimeError,
  hooksDirectory,
  runGitEgressRuntime,
  runPrePushHook,
} from "./github-git-egress-runtime.js";
import type { GitReader } from "./github-git-egress-shim.js";

const HOOKS = "/hooks";

/** Real git, or null when this environment has none to drive. */
const GIT = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0 ? "git" : null;

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
    expect(() => buildGitArgv(["push", "--no-verify"], { hooksDir: HOOKS })).toThrow(
      /--no-verify is disabled/,
    );
  });

  it("allows `push -n`, which is --dry-run and not a hook bypass", () => {
    // `-n` means --dry-run for push. The hook still runs under it and nothing
    // is published either way, so refusing it rejected a safe command and gave
    // a reason that was not true.
    expect(buildGitArgv(["push", "-n"], { hooksDir: HOOKS })).toEqual([
      "-c",
      `core.hooksPath=${HOOKS}`,
      "push",
      "-n",
    ]);
  });

  it("injects the guard AFTER the caller's global options, so git reads it last", () => {
    // Git takes the last `-c` given for a key. Injecting at the front let
    // `git -c core.hooksPath=/tmp/empty push` override the guard and skip the
    // scanner while still traversing the wrapper — measured against git 2.47.3.
    const argv = buildGitArgv(["-C", "/repo", "--no-pager", "push", "origin", "main"], {
      hooksDir: HOOKS,
    });
    expect(argv).toEqual([
      "-C",
      "/repo",
      "--no-pager",
      "-c",
      `core.hooksPath=${HOOKS}`,
      "push",
      "origin",
      "main",
    ]);
    // The guard is the last core.hooksPath in the argv, and still ahead of the
    // subcommand, which is where git requires global options to sit.
    const positions = argv
      .map((token, index) => (token.toLowerCase().startsWith("core.hookspath=") ? index : -1))
      .filter((index) => index >= 0);
    expect(positions.at(-1)).toBe(argv.indexOf(`core.hooksPath=${HOOKS}`));
    expect(argv.indexOf(`core.hooksPath=${HOOKS}`)).toBeLessThan(argv.indexOf("push"));
  });

  it("refuses a push that sets core.hooksPath itself", () => {
    for (const argv of [
      ["-c", "core.hooksPath=/tmp/empty", "push"],
      ["-c", "CORE.HOOKSPATH=/tmp/empty", "push"],
      ["--config-env=core.hooksPath=HP", "push"],
    ]) {
      expect(() => buildGitArgv(argv, { hooksDir: HOOKS }), argv.join(" ")).toThrow(
        /sets core\.hooksPath itself/,
      );
    }
  });

  it("refuses an alias whose expansion carries the bypass", () => {
    // Injection cannot win here: git expands the alias after the command line,
    // so the expansion's own flag is the last thing git sees.
    expect(() =>
      buildGitArgv(["yolo"], {
        hooksDir: HOOKS,
        resolveAlias: (name) => (name === "yolo" ? "push --no-verify" : null),
      }),
    ).toThrow(/expands to a push that skips the pre-push hook/);

    expect(() =>
      buildGitArgv(["sneaky"], {
        hooksDir: HOOKS,
        resolveAlias: (name) =>
          name === "sneaky" ? "-c core.hooksPath=/tmp/empty push" : null,
      }),
    ).toThrow(/points core\.hooksPath somewhere else/);
  });

  it("still guards a push reached through an alias", () => {
    const argv = buildGitArgv(["yolo"], {
      hooksDir: HOOKS,
      resolveAlias: (name) => (name === "yolo" ? "push --force" : null),
    });
    expect(argv).toEqual(["-c", `core.hooksPath=${HOOKS}`, "yolo"]);
  });

  it("refuses an alias the command line defines for itself", () => {
    // `git -c alias.yolo='push --no-verify' yolo` pushed to a real remote with
    // the hook never running (git 2.47.3). The definition is unreachable from
    // the `git config --get` this wrapper runs — that lookup exits 1 with no
    // output — so no resolver is supplied here: the guard has to read the
    // definition out of argv or it does not hold at all.
    expect(() =>
      buildGitArgv(["-c", "alias.yolo=push --no-verify", "yolo"], { hooksDir: HOOKS }),
    ).toThrow(/expands to a push that skips the pre-push hook/);
  });

  it("guards a push reached through an alias the command line defines", () => {
    // The non-refusal half: an ordinary command-line alias must still be
    // recognised as a push so the guard is injected. Measured against git
    // 2.47.3, `git -c alias.p=push -c core.hooksPath=<dir> p origin HEAD:...`
    // ran the hook and the push aborted; without the injection it succeeded.
    const argv = buildGitArgv(["-c", "alias.p=push", "p", "origin", "main"], {
      hooksDir: HOOKS,
    });
    expect(argv).toEqual([
      "-c",
      "alias.p=push",
      "-c",
      `core.hooksPath=${HOOKS}`,
      "p",
      "origin",
      "main",
    ]);
    expect(argv.indexOf(`core.hooksPath=${HOOKS}`)).toBeLessThan(argv.indexOf("p"));
  });

  it("reads a --config-env alias through the environment it is given", () => {
    expect(() =>
      buildGitArgv(["--config-env=alias.yolo=A_PUSH", "yolo"], {
        hooksDir: HOOKS,
        env: { A_PUSH: "push --no-verify" },
      }),
    ).toThrow(/expands to a push that skips the pre-push hook/);
  });

  it("leaves a command-line alias to a non-push alone", () => {
    const argv = ["-c", "alias.st=status --short", "st"];
    expect(buildGitArgv(argv, { hooksDir: HOOKS })).toEqual(argv);
  });
});

describe.skipIf(!GIT)("runGitEgressRuntime alias resolution", () => {
  // These drive REAL git, because the thing under test is whether the alias
  // lookup runs against the same configuration git will use. A stubbed
  // resolver would answer whatever the stub decided and prove nothing.

  it("resolves a file-based alias in the repository the invocation selects", () => {
    // `-C` chooses which config files an alias lookup reads. A bare `git config
    // --get` reads the WRAPPER's cwd instead, finds nothing, and classifies the
    // invocation as not-a-push. Measured against git 2.47.3 on a real remote:
    // before the caller's global options were forwarded to the lookup,
    // `git -C <repo> <push-alias>` published a commit carrying credential-shaped
    // material with the hook never running.
    const repo = mkdtempSync(path.join(tmpdir(), "git-egress-"));
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "config", "alias.yolo", "push --no-verify"]);

    // Refused during argv construction, so no push is ever attempted: reaching
    // the refusal at all is the proof that the alias resolved.
    // Thrown synchronously, before the promise is built — which is exactly why
    // the entrypoint wraps this call in a try/catch as well as a .catch().
    expect(() =>
      runGitEgressRuntime({ target: "git", argv: ["-C", repo, "yolo"], hooksDir: HOOKS }),
    ).toThrow(/expands to a push that skips the pre-push hook/);
  });

  it("prefers a command-line definition over the repository's own", () => {
    // Git takes the command-line one; so must the guard, or a benign on-disk
    // alias masks a hostile command-line redefinition of the same name.
    const repo = mkdtempSync(path.join(tmpdir(), "git-egress-"));
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "config", "alias.p", "status"]);

    expect(() =>
      runGitEgressRuntime({
        target: "git",
        argv: ["-C", repo, "-c", "alias.p=push --no-verify", "p"],
        hooksDir: HOOKS,
      }),
    ).toThrow(/expands to a push that skips the pre-push hook/);
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

  it("aborts the push when the scan cannot be completed", async () => {
    // A guard whose error path is "allow" is not a guard. Before this, a failed
    // rev-list reported an empty commit set and the push proceeded unscanned.
    const errors: string[] = [];
    const code = await runPrePushHook({
      input: "refs/heads/m a refs/heads/m b\n",
      runGit: () => null,
      stderr: (message) => errors.push(message),
    });
    expect(code).toBe(1);
    const text = errors.join("\n");
    expect(text).toContain("could not be completed");
    // It must not read as a detection: there is no commit to go and amend.
    expect(text).toContain("refusal, not a detection");
    expect(text).toContain("rev-list");
  });

  it("aborts the push on an unexpected scanner failure", async () => {
    // Anything thrown leaves the verdict unknown, which must refuse, not pass.
    const errors: string[] = [];
    const code = await runPrePushHook({
      input: "refs/heads/m a refs/heads/m b\n",
      runGit: () => {
        throw new Error("git went missing");
      },
      stderr: (message) => errors.push(message),
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("git went missing");
  });
});
