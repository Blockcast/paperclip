// Coverage for the classification rule in `measure-absolute-path-git.mjs`.
//
// WHY ONLY THE CLASSIFIER
// -----------------------
// The sampling loop is a /proc reader whose correctness is established by
// running it (the PEN-4986 run records a positive and a negative control, and a
// measured catch rate). What CANNOT be re-established that way on a future
// re-run is the rule that decides whether an observed /usr/bin/git transited
// the wrapper -- a silent regression there turns a real finding into a zero,
// which is the direction that matters: this count is §7.2 trigger 4 of
// `docs/security/PEN-3183-git-egress-enforcement-boundary-decision.md`, so a
// false zero lets an ended acceptance keep running. Hence the rule is pure and
// pinned here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyGitInvocation, PAPERCLIP_HELPER, WRAPPER, RUNTIME_JS } from "./measure-absolute-path-git.mjs";

test("direct wrapper exec is wrapped (argv carries the paperclip -c helper)", () => {
  const r = classifyGitInvocation({
    argv: ["/usr/bin/git", "-c", "credential.https://github.com.helper=", "-c",
           `credential.https://github.com.helper=${PAPERCLIP_HELPER}`, "status"],
  });
  assert.equal(r.wrapped, true);
  assert.equal(r.evidence.viaArgv, true);
});

test("a DESCENDANT git inherits via GIT_CONFIG_PARAMETERS even with a bare argv", () => {
  // git hands `-c` down to child processes this way. Without this arm every
  // sub-git a wrapped git spawns would be counted as an unwrapped invocation.
  const r = classifyGitInvocation({
    argv: ["/usr/bin/git", "rev-parse", "--git-dir"],
    gitConfigParameters: `'credential.https://github.com.helper=${PAPERCLIP_HELPER}'`,
  });
  assert.equal(r.wrapped, true);
  assert.equal(r.evidence.viaEnv, true);
  assert.equal(r.evidence.viaArgv, false);
});

test("ancestry alone is sufficient: wrapper exe, or the egress runtime in argv", () => {
  assert.equal(classifyGitInvocation({
    argv: ["/usr/bin/git", "fetch"],
    ancestry: [{ pid: "9", comm: "sh", exe: WRAPPER, argv: "/bin/sh" }],
  }).wrapped, true);

  assert.equal(classifyGitInvocation({
    argv: ["/usr/bin/git", "fetch"],
    ancestry: [{ pid: "9", comm: "node", exe: "/usr/local/bin/node", argv: `node /opt/x/${RUNTIME_JS} /usr/bin/git fetch` }],
  }).wrapped, true);
});

test("a bare absolute-path invocation is UNWRAPPED -- the finding this exists to catch", () => {
  const r = classifyGitInvocation({
    argv: ["/usr/bin/git", "push", "origin", "HEAD"],
    gitConfigParameters: null,
    ancestry: [
      { pid: "7", comm: "zsh", exe: "/usr/bin/zsh", argv: "/usr/bin/zsh" },
      { pid: "3", comm: "claude", exe: "/opt/claude/bin/claude.exe", argv: "claude" },
    ],
  });
  assert.equal(r.wrapped, false);
  assert.deepEqual(r.evidence, { viaArgv: false, viaEnv: false, viaAncestor: false });
});

test("a NON-paperclip credential helper does not count as having transited the wrapper", () => {
  // /etc/gitconfig's system helper (`!/usr/bin/gh auth git-credential`) authenticates
  // an unwrapped git all by itself -- §4 of the decision doc. Seeing *a* helper is
  // therefore not evidence of the wrapper; only the paperclip helper path is.
  const r = classifyGitInvocation({
    argv: ["/usr/bin/git", "-c", "credential.https://github.com.helper=!/usr/bin/gh auth git-credential", "push"],
  });
  assert.equal(r.wrapped, false);
});

test("missing fields default to unwrapped rather than throwing", () => {
  assert.equal(classifyGitInvocation({}).wrapped, false);
});
