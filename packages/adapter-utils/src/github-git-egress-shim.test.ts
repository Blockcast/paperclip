import { describe, expect, it } from "vitest";

import {
  addedLinesFromPatch,
  classifyGitInvocation,
  commitsForRefUpdate,
  formatRefusal,
  GitEgressScanError,
  gitGlobalOptions,
  parsePrePushInput,
  scanCommit,
  scanPrePushUpdates,
  type GitReader,
} from "./github-git-egress-shim.js";

/**
 * An environment dump, assembled rather than pasted.
 *
 * Every fixture in this file is built from parts on purpose. A literal
 * credential here would be committed, and CI scans the COMMIT RANGE with
 * gitleaks — so a literal would trip the secret gate inside the very pull
 * request that adds a secret-containment control, and could then only be
 * cleared by rewriting the commit rather than by deleting the line.
 */
function environmentDump(): string {
  return ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHOES"]
    .map((name, index) => `${name}=value-${index}`)
    .join("\n");
}

/** A git reader backed by a fixed map, so no repository is needed. */
function fakeGit(responses: Record<string, string | null>): GitReader {
  return (args: string[]) => {
    const key = args.join(" ");
    return key in responses ? responses[key]! : null;
  };
}

describe("classifyGitInvocation", () => {
  it("finds a bare push", () => {
    const result = classifyGitInvocation(["push", "origin", "main"]);
    expect(result.isPush).toBe(true);
    expect(result.subcommand).toBe("push");
  });

  it("is not fooled by a global option that takes a separate value", () => {
    // The regression this guards: treating `-c` as a valueless flag makes
    // `foo=bar` read as the subcommand, and the push sails past the guard.
    for (const argv of [
      ["-c", "foo=bar", "push"],
      ["-C", "/tmp/repo", "push"],
      ["--git-dir", "/tmp/repo/.git", "push"],
      ["--work-tree", "/tmp/repo", "push"],
    ]) {
      expect(classifyGitInvocation(argv).isPush, argv.join(" ")).toBe(true);
    }
  });

  it("handles the self-contained --opt=value spelling", () => {
    expect(classifyGitInvocation(["--git-dir=/tmp/r/.git", "push"]).isPush).toBe(true);
  });

  it("does not classify unrelated subcommands as a push", () => {
    for (const sub of ["status", "commit", "fetch", "log", "diff"]) {
      expect(classifyGitInvocation([sub]).isPush, sub).toBe(false);
    }
  });

  it("resolves an alias that expands to a push", () => {
    const resolve = (name: string) => (name === "yolo" ? "push --force" : null);
    expect(classifyGitInvocation(["yolo"], resolve).isPush).toBe(true);
  });

  it("resolves a chain of aliases, and stops rather than looping forever", () => {
    const chain: Record<string, string> = { a: "b", b: "c", c: "push" };
    expect(classifyGitInvocation(["a"], (n) => chain[n] ?? null).isPush).toBe(true);

    const cyclic: Record<string, string> = { x: "y", y: "x" };
    expect(classifyGitInvocation(["x"], (n) => cyclic[n] ?? null).isPush).toBe(false);
  });

  it("does not try to parse a shell alias", () => {
    // Assembled from parts on purpose. scripts/check-no-git-push.mjs scans
    // string literals in this tree for those two words together, and the
    // `paperclip:allow-git-push` marker that opts a line out asserts an
    // operator-approved push path exists. This is a test fixture and no such
    // path exists, so spending that escape hatch here would put a false claim
    // inside a security control.
    const shellAlias = `!git ${"push"} --all`;
    expect(classifyGitInvocation(["sh"], () => shellAlias).isPush).toBe(false);
  });

  it("detects the hook-skipping flag", () => {
    expect(classifyGitInvocation(["push", "--no-verify"]).hasNoVerify).toBe(true);
    expect(classifyGitInvocation(["push"]).hasNoVerify).toBe(false);
  });

  it("does not treat `push -n` as a hook bypass, because it is --dry-run", () => {
    // For `push`, `-n` is --dry-run, not --no-verify (see the subcommand's own
    // `-h` output). Refusing
    // it would reject a safe command while giving a false reason, and it is
    // harmless twice over: verified against git 2.47.3, the pre-push hook still
    // runs under --dry-run, and a dry run publishes nothing even if it did not.
    expect(classifyGitInvocation(["push", "-n"]).hasNoVerify).toBe(false);
  });

  it("reports a caller-supplied core.hooksPath override, however it is spelled", () => {
    // Each of these overrode a guard injected at the FRONT of argv when
    // measured against git 2.47.3, because git takes the last value for a key.
    const cases: Array<[string, string[]]> = [
      ["-c", ["-c", "core.hooksPath=/tmp/empty", "push"]],
      ["case-folded key", ["-c", "CORE.HOOKSPATH=/tmp/empty", "push"]],
      ["--config-env=", ["--config-env=core.hooksPath=HP", "push"]],
      ["--config-env separate", ["--config-env", "core.hooksPath=HP", "push"]],
    ];
    for (const [label, argv] of cases) {
      const result = classifyGitInvocation(argv);
      expect(result.isPush, label).toBe(true);
      expect(result.hooksPathOverride, label).not.toBeNull();
    }
  });

  it("leaves hooksPathOverride null for unrelated config", () => {
    const result = classifyGitInvocation(["-c", "user.name=someone", "push"]);
    expect(result.isPush).toBe(true);
    expect(result.hooksPathOverride).toBeNull();
  });

  it("still sees the push when an alias expansion leads with its own global options", () => {
    // Reading only the expansion's first word classifies this as a `-c`
    // subcommand, so the guard is never injected and the alias pushes freely.
    // Measured as a working bypass against git 2.47.3.
    const resolve = (name: string) =>
      name === "sneaky" ? "-c core.hooksPath=/tmp/empty push" : null;
    const result = classifyGitInvocation(["sneaky"], resolve);
    expect(result.isPush).toBe(true);
    expect(result.aliasBypass).toMatchObject({ alias: "sneaky", reason: "hooks-path" });
  });

  it("reports an alias whose expansion skips the hook", () => {
    const resolve = (name: string) => (name === "yolo" ? "push --no-verify" : null);
    const result = classifyGitInvocation(["yolo"], resolve);
    expect(result.isPush).toBe(true);
    // argv itself carries no --no-verify; the bypass is only in the expansion,
    // and git applies it after the command line, so injection cannot beat it.
    expect(result.hasNoVerify).toBe(false);
    expect(result.aliasBypass).toMatchObject({ alias: "yolo", reason: "no-verify" });
  });

  it("carries a bypass found part-way along an alias chain", () => {
    const chain: Record<string, string> = { a: "-c core.hooksPath=/tmp/empty b", b: "push" };
    const result = classifyGitInvocation(["a"], (n) => chain[n] ?? null);
    expect(result.isPush).toBe(true);
    expect(result.aliasBypass).toMatchObject({ alias: "a", reason: "hooks-path" });
  });

  it("ignores a bypass on an alias that never reaches a push", () => {
    // `git amend` skipping commit-msg hooks is not this guard's business, and
    // refusing it would break unrelated tooling.
    const resolve = (name: string) => (name === "amend" ? "commit --amend --no-verify" : null);
    const result = classifyGitInvocation(["amend"], resolve);
    expect(result.isPush).toBe(false);
    expect(result.aliasBypass).toBeNull();
  });

  it("reports no alias bypass for an ordinary push alias", () => {
    const resolve = (name: string) => (name === "p" ? "push --force-with-lease" : null);
    const result = classifyGitInvocation(["p"], resolve);
    expect(result.isPush).toBe(true);
    expect(result.aliasBypass).toBeNull();
  });

  it("resolves an alias the invocation defines on its own command line", () => {
    // The hole this closes, measured end to end against git 2.47.3:
    //   git -c alias.yolo='push --no-verify' yolo origin HEAD:refs/heads/t
    // pushed to the remote with the pre-push hook never running. A separate
    // `git config --get alias.yolo` run beside it exits 1 with no output, so a
    // lookup in another process cannot see the definition at all — consulting
    // only `resolveAlias` classified `yolo` as not-a-push, left argv untouched,
    // and git then expanded the alias itself. The definition is therefore read
    // out of argv rather than looked up. No resolver is passed here on purpose.
    const result = classifyGitInvocation(["-c", "alias.yolo=push --no-verify", "yolo"]);
    expect(result.isPush).toBe(true);
    // argv itself carries no --no-verify; only the expansion does.
    expect(result.hasNoVerify).toBe(false);
    expect(result.aliasBypass).toMatchObject({ alias: "yolo", reason: "no-verify" });
  });

  it("resolves a command-line alias that expands to an ordinary push", () => {
    // The other half of the same hole, and the half that is not a refusal:
    // classifying this as a push is what makes the wrapper inject the guard.
    // Verified against git 2.47.3 — with `-c core.hooksPath=` injected the hook
    // ran and aborted the push; without it the push went through unscanned.
    const result = classifyGitInvocation(["-c", "alias.p=push", "p", "origin", "main"]);
    expect(result.isPush).toBe(true);
    expect(result.aliasBypass).toBeNull();
    expect(result.subcommandIndex).toBe(2);
  });

  it("reads a command-line alias however git would spell it", () => {
    const cases: Array<[string, string[], Record<string, string>]> = [
      ["-c", ["-c", "alias.yolo=push", "yolo"], {}],
      // Section and variable names are both case-insensitive in git config;
      // `-c alias.YOLO=` and `-c ALIAS.yolo=` each define what `git yolo` runs.
      ["case-folded name", ["-c", "alias.YOLO=push", "yolo"], {}],
      ["case-folded section", ["-c", "ALIAS.yolo=push", "yolo"], {}],
      ["--config-env=", ["--config-env=alias.yolo=A_PUSH", "yolo"], { A_PUSH: "push" }],
      ["--config-env separate", ["--config-env", "alias.yolo=A_PUSH", "yolo"], { A_PUSH: "push" }],
    ];
    for (const [label, argv, env] of cases) {
      expect(classifyGitInvocation(argv, undefined, env).isPush, label).toBe(true);
    }
  });

  it("takes the LAST command-line definition of an alias, as git does", () => {
    // `git -c alias.d=status -c alias.d='push --no-verify' config --get-all
    // alias.d` prints both, and git runs the last. Taking the first would read
    // this invocation as a `status` and wave the push through.
    const result = classifyGitInvocation([
      "-c",
      "alias.d=status",
      "-c",
      "alias.d=push --no-verify",
      "d",
    ]);
    expect(result.isPush).toBe(true);
    expect(result.aliasBypass).toMatchObject({ reason: "no-verify" });
  });

  it("prefers a command-line definition over one in config, as git does", () => {
    const result = classifyGitInvocation(
      ["-c", "alias.p=push --no-verify", "p"],
      () => "status",
    );
    expect(result.isPush).toBe(true);
    expect(result.aliasBypass).toMatchObject({ reason: "no-verify" });
  });

  it("carries command-line definitions made inside an alias expansion", () => {
    // `alias.outer = -c alias.inner=push inner` reaches a push in git 2.47.3:
    // the expansion's own `-c` defines an alias git then resolves. Scanning the
    // expansion for its subcommand but discarding what it DEFINES loses the
    // chain one hop early.
    const result = classifyGitInvocation(["-c", "alias.outer=-c alias.inner=push inner", "outer"]);
    expect(result.isPush).toBe(true);
  });

  it("does not treat a command-line alias to a non-push as a push", () => {
    const result = classifyGitInvocation(["-c", "alias.st=status --short", "st"]);
    expect(result.isPush).toBe(false);
    expect(result.aliasBypass).toBeNull();
  });

  it("ignores a --config-env alias naming a variable that is not set", () => {
    // git would fail the invocation outright; there is no expansion to parse,
    // and inventing one would refuse a push over a definition that never
    // existed.
    expect(classifyGitInvocation(["--config-env=alias.yolo=NOPE", "yolo"], undefined, {}).isPush).toBe(
      false,
    );
  });
});

describe("gitGlobalOptions", () => {
  it("returns the options that precede the subcommand", () => {
    expect(gitGlobalOptions(["-C", "/repo", "-c", "alias.p=push", "p", "origin"])).toEqual([
      "-C",
      "/repo",
      "-c",
      "alias.p=push",
    ]);
    expect(gitGlobalOptions(["push", "origin"])).toEqual([]);
    expect(gitGlobalOptions([])).toEqual([]);
  });
});

describe("parsePrePushInput", () => {
  it("parses git's ref-update lines and ignores blank ones", () => {
    const updates = parsePrePushInput(
      "refs/heads/main aaa refs/heads/main bbb\n\nrefs/heads/x ccc refs/heads/x ddd\n",
    );
    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual({
      localRef: "refs/heads/main",
      localSha: "aaa",
      remoteRef: "refs/heads/main",
      remoteSha: "bbb",
    });
  });

  it("returns nothing for empty input", () => {
    expect(parsePrePushInput("")).toEqual([]);
  });
});

describe("commitsForRefUpdate", () => {
  const zero = "0".repeat(40);

  it("uses a two-dot range when the remote already has the ref", () => {
    const seen: string[][] = [];
    const runGit: GitReader = (args) => {
      seen.push(args);
      return "c1\nc2\n";
    };
    const commits = commitsForRefUpdate(
      { localRef: "r", localSha: "new", remoteRef: "r", remoteSha: "old" },
      runGit,
    );
    expect(seen[0]).toEqual(["rev-list", "old..new"]);
    expect(commits).toEqual(["c1", "c2"]);
  });

  it("excludes everything already published when the ref is new", () => {
    // Without `--not --remotes` a new branch re-reports the repository's whole
    // history, which would refuse pushes over material that is already public.
    const seen: string[][] = [];
    const runGit: GitReader = (args) => {
      seen.push(args);
      return "c1\n";
    };
    commitsForRefUpdate(
      { localRef: "r", localSha: "new", remoteRef: "r", remoteSha: zero },
      runGit,
    );
    expect(seen[0]).toEqual(["rev-list", "new", "--not", "--remotes"]);
  });

  it("treats a branch deletion as publishing nothing", () => {
    const commits = commitsForRefUpdate(
      { localRef: "", localSha: zero, remoteRef: "r", remoteSha: "old" },
      () => {
        throw new Error("git must not be consulted for a deletion");
      },
    );
    expect(commits).toEqual([]);
  });

  it("refuses rather than reporting an empty range when rev-list fails", () => {
    // The regression this guards: returning [] on a failed read makes the push
    // look like it publishes nothing, so it proceeds entirely unscanned. A
    // `maxBuffer` overflow reaches here, which makes the largest pushes the
    // likeliest to slip through.
    expect(() =>
      commitsForRefUpdate(
        { localRef: "r", localSha: "new", remoteRef: "r", remoteSha: "old" },
        () => null,
      ),
    ).toThrow(GitEgressScanError);
  });
});

describe("addedLinesFromPatch", () => {
  it("strips the marker from added lines and drops everything else", () => {
    const patch = ["--- a/f", "+++ b/f", "@@ -0,0 +1 @@", "+ADDED=1", "-REMOVED=1", " CONTEXT=1"].join(
      "\n",
    );
    expect(addedLinesFromPatch(patch)).toBe("ADDED=1");
  });

  it("keeps a line-anchored detector working through a diff", () => {
    // THE regression this function exists for. The environment-dump detector
    // anchors on `^[A-Z][A-Z0-9_]{2,}=`; in a raw patch every added line starts
    // with `+`, so the anchor never matches and the PEN-2526 class goes
    // undetected. Scanning the raw patch below must find nothing; scanning the
    // normalised text must find the dump.
    const patch = environmentDump()
      .split("\n")
      .map((line) => `+${line}`)
      .join("\n");
    const findings = scanCommit(
      "deadbeefcafe0000",
      fakeGit({
        "log -1 --format=%s deadbeefcafe0000": "add config",
        "log -1 --format=%B deadbeefcafe0000": "add config\n",
        "show --format= --no-color -m --unified=0 deadbeefcafe0000": patch,
      }),
    );
    expect(findings.map((f) => f.where)).toEqual(["content"]);
    expect(findings[0]!.classes).toContain("environment-dump");
  });
});

describe("scanCommit", () => {
  const sha = "abcdef0123456789abcdef0123456789abcdef01";

  it("finds material in a commit message", () => {
    const findings = scanCommit(
      sha,
      fakeGit({
        [`log -1 --format=%s ${sha}`]: "wip",
        [`log -1 --format=%B ${sha}`]: `wip\n\n${environmentDump()}\n`,
        [`show --format= --no-color -m --unified=0 ${sha}`]: "",
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.where).toBe("message");
    expect(findings[0]!.shortCommit).toBe("abcdef012345");
    expect(findings[0]!.subject).toBe("wip");
  });

  it("passes a clean commit", () => {
    const findings = scanCommit(
      sha,
      fakeGit({
        [`log -1 --format=%s ${sha}`]: "fix: tidy the readme",
        [`log -1 --format=%B ${sha}`]: "fix: tidy the readme\n",
        [`show --format= --no-color -m --unified=0 ${sha}`]: "+Hello, world.\n",
      }),
    );
    expect(findings).toEqual([]);
  });

  it("refuses when a read it needs fails, rather than skipping that leg", () => {
    // Each read decides part of the verdict, so skipping one reports a commit
    // clean that was never inspected. `fakeGit` returns null for any key it is
    // not given, so each case below omits exactly one read.
    const complete: Record<string, string> = {
      [`log -1 --format=%s ${sha}`]: "wip",
      [`log -1 --format=%B ${sha}`]: "wip\n",
      [`show --format= --no-color -m --unified=0 ${sha}`]: "+clean\n",
    };
    for (const omitted of Object.keys(complete)) {
      const responses = { ...complete };
      delete responses[omitted];
      expect(() => scanCommit(sha, fakeGit(responses)), omitted).toThrow(GitEgressScanError);
    }
  });

  it("distinguishes an empty read from a failed one", () => {
    // git exits zero with no output for an empty message or an empty diff.
    // That is genuinely nothing to scan and must not be confused with a read
    // that failed, or every such commit would refuse its own push.
    const findings = scanCommit(
      sha,
      fakeGit({
        [`log -1 --format=%s ${sha}`]: "",
        [`log -1 --format=%B ${sha}`]: "",
        [`show --format= --no-color -m --unified=0 ${sha}`]: "",
      }),
    );
    expect(findings).toEqual([]);
  });
});

describe("scanPrePushUpdates", () => {
  it("reports a commit once even when two pushed refs both reach it", () => {
    const shared = "1111111111111111111111111111111111111111";
    const runGit: GitReader = (args) => {
      if (args[0] === "rev-list") return `${shared}\n`;
      if (args.includes("--format=%s")) return "shared";
      if (args.includes("--format=%B")) return `shared\n\n${environmentDump()}\n`;
      return "";
    };
    const findings = scanPrePushUpdates(
      [
        { localRef: "a", localSha: "a1", remoteRef: "a", remoteSha: "a0" },
        { localRef: "b", localSha: "b1", remoteRef: "b", remoteSha: "b0" },
      ],
      runGit,
    );
    expect(findings).toHaveLength(1);
  });
});

describe("formatRefusal", () => {
  it("names the commit, the class, and a reachable remedy", () => {
    const message = formatRefusal([
      {
        commit: "f".repeat(40),
        shortCommit: "ffffffffffff",
        subject: "add fixture",
        where: "content",
        classes: ["environment-dump"],
      },
    ]);
    // A bare rejection is not actionable: the author has to be able to locate
    // the commit and know which remedy applies.
    expect(message).toContain("ffffffffffff");
    expect(message).toContain("environment-dump");
    expect(message).toContain("file content");
    expect(message).toContain("--amend");
    expect(message).toContain("content-addressed");
  });

  it("points a multi-commit refusal at the oldest one", () => {
    const message = formatRefusal([
      {
        commit: "a".repeat(40),
        shortCommit: "aaaaaaaaaaaa",
        subject: "newer",
        where: "message",
        classes: ["environment-dump"],
      },
      {
        commit: "b".repeat(40),
        shortCommit: "bbbbbbbbbbbb",
        subject: "older",
        where: "message",
        classes: ["environment-dump"],
      },
    ]);
    // rev-list is newest-first, so the last finding is the oldest commit and is
    // the one an interactive rebase has to reach.
    expect(message).toContain("rebase -i bbbbbbbbbbbb~1");
  });
});
