import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  parseOriginUrlFromGitConfig,
  readGitOriginUrl,
  readOriginUrlFromGitConfig,
} from "../services/workspace-runtime.js";
import { parseGitConfigValue, readLocalGitConfigValue } from "../services/git-local-config-file.js";

// BLO-56438: readGitOriginUrl reads the config file instead of spawning git.

describe("parseOriginUrlFromGitConfig", () => {
  it("reads the last origin url and ignores other remotes", () => {
    const text = [
      "[core]",
      "\tbare = false",
      '[remote "upstream"]',
      "\turl = https://example.com/up.git",
      '[remote "origin"]',
      "\tURL = https://example.com/first.git",
      "\turl = https://example.com/origin.git  ",
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    ].join("\n");
    expect(parseOriginUrlFromGitConfig(text)).toBe("https://example.com/origin.git");
  });

  it("returns null when there is no origin", () => {
    expect(parseOriginUrlFromGitConfig('[remote "Origin"]\n\turl = x\n')).toBeNull();
    expect(parseOriginUrlFromGitConfig("[core]\n\tbare = false\n")).toBeNull();
  });

  it.each([
    ['[include]\n\tpath = other\n[remote "origin"]\n\turl = x\n'],
    ['[includeIf "gitdir:/a/"]\n\tpath = other\n'],
    ["[remote.origin]\n\turl = x\n"],
    ['[remote "origin"]\n\turl = "quoted"\n'],
    ['[remote "origin"]\n\turl = a#b\n'],
    ['[remote "origin"]\n\turl = a\\\n'],
  ])("defers to git when the shape is ambiguous: %j", (text) => {
    expect(parseOriginUrlFromGitConfig(text)).toBeUndefined();
  });
});

describe("readGitOriginUrl agrees with git", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "origin-reader-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const gitOrigin = (cwd: string) => {
    try {
      return git(cwd, "config", "--get", "remote.origin.url").trim();
    } catch {
      return null;
    }
  };

  it("matches for a plain repo, a repo without origin, and a linked worktree", async () => {
    const main = path.join(root, "main");
    git(root, "init", "-q", main);
    git(main, "remote", "add", "origin", "https://github.com/Example/repo.git");
    git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
    const wt = path.join(root, "wt");
    git(main, "worktree", "add", "-q", wt);
    const bare = path.join(root, "noorigin");
    git(root, "init", "-q", bare);

    for (const dir of [main, wt, bare]) {
      expect(await readOriginUrlFromGitConfig(dir)).not.toBeUndefined();
      expect(await readGitOriginUrl(dir)).toBe(gitOrigin(dir));
    }
    expect(await readGitOriginUrl(wt)).toBe("https://github.com/Example/repo.git");
  });

  it("defers to git for a directory without .git", async () => {
    const plain = path.join(root, "plain");
    git(root, "init", "-q", plain);
    const sub = path.join(plain, "sub");
    execFileSync("mkdir", [sub]);
    writeFileSync(path.join(sub, "f"), "");
    expect(await readOriginUrlFromGitConfig(sub)).toBeUndefined();
  });
});

// BLO-57549: the same reader now serves the push guard and the agent identity.
describe("readLocalGitConfigValue agrees with git config --local --get", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "local-config-reader-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const gitLocal = (cwd: string, key: string) => {
    try {
      return git(cwd, "config", "--local", "--get", key).replace(/\n$/, "");
    } catch {
      return null;
    }
  };

  it("matches for every key the push guard and identity read", async () => {
    const repo = path.join(root, "repo");
    git(root, "init", "-q", repo);
    git(repo, "config", "user.name", "Staff Engineer");
    git(repo, "config", "user.email", "staff@example.com");
    git(repo, "config", "receive.denyDeletes", "true");
    git(repo, "config", "receive.denyCurrentBranch", "refuse");
    git(repo, "config", "paperclip.pushGuard.displacedHooksPath", "/srv/hooks");
    git(repo, "config", "paperclip.pushguard.displacedHooksPath", "/wrong-subsection-case");
    const keys = [
      "user.name",
      "USER.EMAIL",
      "receive.denyDeletes",
      "receive.denyNonFastForwards",
      "receive.denyCurrentBranch",
      "paperclip.pushGuard.displacedHooksPath",
      "core.hooksPath",
    ];
    for (const key of keys) {
      expect(await readLocalGitConfigValue(repo, key), key).not.toBeUndefined();
      expect(await readLocalGitConfigValue(repo, key), key).toBe(gitLocal(repo, key));
    }
  });

  it.each([
    ["[receive]\n\tdenyDeletes\n", "receive.denyDeletes"],
    ['[user]\n\tname = "  padded  "\n', "user.name"],
    ["[user] name = inline\n", "user.name"],
    ["nokey", "nokey"],
  ])("defers to git when the shape is ambiguous: %j", (text, key) => {
    expect(parseGitConfigValue(text, key)).toBeUndefined();
  });
});
