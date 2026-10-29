// Coverage for the two rules in `measure-absolute-path-git.mjs` that a future
// re-run silently depends on: WHICH binaries are watched, and WHETHER an
// observed invocation transited the wrapper.
//
// WHY THESE TWO
// -------------
// The sampling loop is a /proc reader whose correctness is established by
// running it (the PEN-4986 run records a positive and a negative control, and a
// measured catch rate). What CANNOT be re-established that way is a target set
// that quietly stops covering a path, or a classifier that quietly starts
// calling everything wrapped -- a regression in either turns a real finding
// into a zero, which is the direction that matters: this count is §7.2 trigger
// 4 of `docs/security/PEN-3183-git-egress-enforcement-boundary-decision.md`, so
// a false zero lets an ended acceptance keep running.
//
// The target-set tests exist because that is exactly what happened once. The
// first version watched the single path `/usr/bin/git` and so could not see
// `/usr/lib/git-core/git`, a separate inode holding a byte-identical copy of
// the same binary, reachable without the wrapper and authenticated all the
// same. Discovery is by content identity now, and these tests pin that.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyGitInvocation, discoverGitBinaries,
  PAPERCLIP_HELPER, WRAPPER, RUNTIME_JS,
} from "./measure-absolute-path-git.mjs";

// ---------------------------------------------------------------- target set

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pen4986-"));
  const bin = join(root, "bin");
  const core = join(root, "git-core");
  mkdirSync(bin); mkdirSync(core);
  const body = "#!/bin/false\n" + "g".repeat(4096); // stand-in for the git binary
  writeFileSync(join(bin, "git"), body);            // the reference
  writeFileSync(join(core, "git"), body);           // a SEPARATE inode, same bytes
  writeFileSync(join(core, "git-http-fetch"), "#!/bin/false\ndifferent program\n");
  writeFileSync(join(bin, "unrelated"), "#!/bin/false\nnot git at all, same-ish size\n");
  symlinkSync(join(core, "git"), join(core, "git-status"));   // alias of the copy
  linkSync(join(bin, "git"), join(bin, "git-upload-pack"));   // hardlink of the reference
  for (const p of ["bin/git", "git-core/git", "git-core/git-http-fetch", "bin/unrelated"]) {
    chmodSync(join(root, p), 0o755);
  }
  return { root, bin, core, reference: join(bin, "git") };
}

test("a byte-identical copy at another path is watched, not missed (the review finding)", () => {
  const f = fixture();
  const { realGit } = discoverGitBinaries({ reference: f.reference, dirs: [f.bin, f.core], gitCoreDir: f.core });
  const ids = [...realGit.keys()];
  assert.equal(ids.length, 2, "the reference and the separate-inode copy are two distinct targets");
  assert.ok(ids.includes(`${statSync(f.reference).dev}:${statSync(f.reference).ino}`));
  assert.ok(ids.includes(`${statSync(join(f.core, "git")).dev}:${statSync(join(f.core, "git")).ino}`),
    "/usr/lib/git-core/git is a copy, not a symlink -- watching one path cannot see it");
});

test("symlinks and hardlinks collapse onto the inode instead of multiplying targets", () => {
  const f = fixture();
  const { realGit } = discoverGitBinaries({ reference: f.reference, dirs: [f.bin, f.core], gitCoreDir: f.core });
  const refId = `${statSync(f.reference).dev}:${statSync(f.reference).ino}`;
  assert.deepEqual(realGit.get(refId).sort(), [join(f.bin, "git"), join(f.bin, "git-upload-pack")].sort());
  const copyId = `${statSync(join(f.core, "git")).dev}:${statSync(join(f.core, "git")).ino}`;
  assert.ok(realGit.get(copyId).includes(join(f.core, "git-status")), "the alias resolves to the same inode");
});

test("a different program is not a real-git target, but a git-core one is still watched", () => {
  const f = fixture();
  const { realGit, gitCore } = discoverGitBinaries({ reference: f.reference, dirs: [f.bin, f.core], gitCoreDir: f.core });
  const otherId = `${statSync(join(f.core, "git-http-fetch")).dev}:${statSync(join(f.core, "git-http-fetch")).ino}`;
  assert.ok(!realGit.has(otherId), "not byte-identical to git, so not part of §8's count");
  assert.ok(gitCore.has(otherId), "but it reads /etc/gitconfig itself, so it is observed separately");
  const unrelatedId = `${statSync(join(f.bin, "unrelated")).dev}:${statSync(join(f.bin, "unrelated")).ino}`;
  assert.ok(!realGit.has(unrelatedId) && !gitCore.has(unrelatedId), "outside git-core and not git");
});

test("the calibration copy is excluded, so calibrating cannot contaminate the count", () => {
  const f = fixture();
  const calibId = `${statSync(join(f.core, "git")).dev}:${statSync(join(f.core, "git")).ino}`;
  const { realGit } = discoverGitBinaries({
    reference: f.reference, dirs: [f.bin, f.core], gitCoreDir: f.core, excludeIds: [calibId],
  });
  assert.ok(!realGit.has(calibId));
  assert.equal(realGit.size, 1);
});

// --------------------------------------------------------------- classifier

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

test("the ancestor arm matches ARGV, because the wrapper is never a live exe", () => {
  // The wrapper is a `#!/bin/sh` script -- /proc/<pid>/exe reports /bin/sh --
  // and it execs away into the token shim and then node, so it is never an
  // ancestor process either. Only its path appearing in an ancestor's argv, or
  // the egress runtime's, is observable.
  assert.equal(classifyGitInvocation({
    argv: ["/usr/bin/git", "fetch"],
    ancestry: [{ pid: "9", comm: "sh", exe: "/bin/sh", argv: `/bin/sh ${WRAPPER} fetch` }],
  }).wrapped, true);

  assert.equal(classifyGitInvocation({
    argv: ["/usr/bin/git", "fetch"],
    ancestry: [{ pid: "9", comm: "node", exe: "/usr/local/bin/node", argv: `node /opt/x/${RUNTIME_JS} /usr/bin/git fetch` }],
  }).wrapped, true);
});

test("a git-core helper spawned by a wrapped git is wrapped via its ancestor's argv", () => {
  // git-remote-http carries neither the -c flags nor, reliably, the env var --
  // its evidence is the wrapped git above it. Without this arm the widened
  // class-B watch would manufacture findings out of ordinary wrapped traffic.
  const r = classifyGitInvocation({
    argv: ["/usr/lib/git-core/git-remote-http", "origin", "https://github.com/o/r"],
    gitConfigParameters: null,
    ancestry: [
      { pid: "40", comm: "git", exe: "/usr/bin/git",
        argv: `/usr/bin/git -c credential.https://github.com.helper=${PAPERCLIP_HELPER} fetch` },
    ],
  });
  assert.equal(r.wrapped, true);
  assert.equal(r.evidence.viaAncestor, true);
});

test("a bare absolute-path invocation is UNWRAPPED -- the finding this exists to catch", () => {
  const r = classifyGitInvocation({
    argv: ["/usr/lib/git-core/git", "push", "origin", "HEAD"],
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
