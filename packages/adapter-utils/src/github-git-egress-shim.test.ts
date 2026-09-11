import { describe, expect, it } from "vitest";

import {
  addedLinesFromPatch,
  classifyGitInvocation,
  commitsForRefUpdate,
  formatRefusal,
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

  it("detects the hook-skipping flags", () => {
    expect(classifyGitInvocation(["push", "--no-verify"]).hasNoVerify).toBe(true);
    expect(classifyGitInvocation(["push", "-n"]).hasNoVerify).toBe(true);
    expect(classifyGitInvocation(["push"]).hasNoVerify).toBe(false);
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
