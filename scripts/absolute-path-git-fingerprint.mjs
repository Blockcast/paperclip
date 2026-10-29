#!/usr/bin/env node
// PEN-4989: fingerprint the surface that makes a PEN-4986-style absolute-path-`git`
// measurement STALE.
//
// §7.2 trigger 4 of `docs/security/PEN-3183-git-egress-enforcement-boundary-decision.md`
// has no detector and cannot have one (no exec telemetry is deployed, and obtaining it
// from inside an agent pod needs the hardening §8 forbids relaxing). What it has instead
// is a measurement -- `scripts/measure-absolute-path-git.mjs`, which lands in PR #3098 --
// whose own header says a result "is only ever a statement about the image and pod it ran
// in", and whose stated re-run trigger is "whenever the agent image or the PATH layout
// changes".
//
// WHY THAT TRIGGER NEEDS NARROWING, AND WHY THIS FILE EXISTS
// ----------------------------------------------------------
// Taken literally, "whenever the agent image changes" is not an operable trigger. Measured
// 2026-10-29 off `kube_pod_container_info` (see the PEN-4989 record):
//
//   - 106 distinct agent image DIGESTS ran in the 7 days to 2026-10-29;
//   - 17 distinct images in the last 24h alone -- roughly 15/day;
//   - for 38.2% of that week MORE THAN ONE image was live at the same instant.
//
// A hand-run measurement provably cannot keep pace with a ~15/day trigger, so a trigger
// phrased against the image tag reads as "always stale" and therefore gets ignored --
// which is the failure mode PEN-4988 exists to prevent (a condition recorded only in a
// document has no owner).
//
// Almost none of those rebuilds touch git egress. So the operable trigger is narrower and
// is what this file computes: the hash of the egress-relevant surface itself -- the
// wrapper, the runtime it execs, the real binary, and the PATH ordering that decides which
// of them a bare `git` reaches. Those are the only inputs that can change what a
// measurement would find. Record the fingerprint beside a measurement; a later run whose
// fingerprint MATCHES may cite that measurement, and one whose fingerprint DIFFERS must
// re-take it.
//
// This is NOT a detector for trigger 4 and must not be described as one. It cannot observe
// an absolute-path invocation; it only says whether a prior observation still applies. It
// is read-only: it hashes files and reads `process.env.PATH`, executes nothing, publishes
// nothing.
//
// Usage:
//   node scripts/absolute-path-git-fingerprint.mjs            # human-readable
//   node scripts/absolute-path-git-fingerprint.mjs --json     # machine-readable
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

export const REAL_GIT = "/usr/bin/git";
export const WRAPPER = "/usr/local/libexec/paperclip/bin/git";
export const EGRESS_RUNTIME =
  "/opt/paperclip-bundled-adapters/node_modules/@paperclipai/adapter-utils/dist/github-git-egress-runtime.js";
export const CREDENTIAL_HELPER =
  "/usr/local/libexec/paperclip/bin/github-token-credential-helper";

/** Files whose contents decide what a bare `git` actually runs. */
export const SURFACE_FILES = [WRAPPER, EGRESS_RUNTIME, CREDENTIAL_HELPER, REAL_GIT];

/**
 * Version of the fingerprint RULE, folded into the digest so that two digests produced
 * by different rules cannot compare equal.
 *
 * This matters because of how the digest is used: "a later run whose fingerprint equals
 * the one in §1 may cite that measurement". If the rule changes while the digest keeps
 * its old shape, that comparison silently answers the wrong question in BOTH directions
 * -- a changed rule reads as a changed surface (spurious re-measure), and worse, two
 * genuinely different surfaces could agree under one rule and not the other. Bumping
 * this makes a cross-rule comparison a visible mismatch instead of a silent one.
 *
 *   v1 (2026-10-29, superseded): hashed the contents of SURFACE_FILES only; the PATH
 *       layout contributed its PATHS but not its CONTENTS.
 *   v2 (2026-10-29): also hashes the contents of every `git` in the PATH layout, so a
 *       shim swapped in place at an unchanged path changes the digest.
 *
 * Bump this whenever `fingerprintFrom` or the inputs `collect` feeds it change.
 */
export const FINGERPRINT_VERSION = 2;

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * The ordered list of PATH entries that contain an executable `git`, which is what
 * decides whether a bare `git` reaches the wrapper or the real binary. Order is the
 * whole point: the guard works only while the wrapper sits ahead of /usr/bin.
 */
export function gitPathLayout(pathValue, exists) {
  const out = [];
  for (const dir of String(pathValue ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "git");
    if (exists(candidate)) out.push(candidate);
  }
  return out;
}

/**
 * Resolve a path through symlinks, falling back to the path itself when it cannot be
 * resolved. The fallback is what makes the caller below fail CLOSED: an unresolvable
 * path compares equal only to itself, so a resolution failure can never manufacture a
 * wrapper match.
 */
const defaultRealpath = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * True when a bare `git` resolves to the wrapper rather than to a real git binary. A
 * fingerprint whose layout fails this is not merely "changed" -- the guard is off the
 * PATH entirely, which is §7.2 trigger-adjacent and should be reported, not diffed.
 *
 * TESTED POSITIVELY AGAINST THE WRAPPER, AND DELIBERATELY SO. This asked `first !==
 * REAL_GIT` until 2026-10-29, which fails OPEN -- it answered "yes" for anything that was
 * not the literal string `/usr/bin/git`, including:
 *
 *   - `/bin/git`, which IS the real binary on a merged-usr image (`/bin -> usr/bin`);
 *   - any `/usr/local/bin/git` shim placed ahead of the wrapper;
 *   - `/usr/lib/git-core/git`, the SECOND real inode holding a byte-identical copy of
 *     the real binary (PEN-4998), which is the one case already known to be real.
 *
 * §4 of the PEN-4989 record makes `wrapperAhead: false` the escalation signal, so a
 * false "yes" suppressed exactly the escalation this value exists to raise.
 *
 * Symlinks are resolved on both sides, so a path that merely points AT the wrapper still
 * counts. This checks WHICH FILE a bare `git` reaches, not whether that file is still a
 * guard: a wrapper replaced in place by a copy of real git would pass here. That case is
 * covered by the content hash of `WRAPPER` in the fingerprint, not by this flag -- the
 * two are meant to be read together.
 */
export function wrapperIsAhead(layout, realpath = defaultRealpath) {
  const first = layout[0];
  if (first === undefined) return false;
  if (first === WRAPPER) return true;
  return realpath(first) === realpath(WRAPPER);
}

/**
 * Pure: fold the collected parts into one stable hex digest. Kept pure so the rule a
 * future re-run depends on is testable without a pod, for the same reason
 * `classifyGitInvocation` is.
 */
export function fingerprintFrom({
  files = {},
  layout = [],
  version = FINGERPRINT_VERSION,
}) {
  const canonical = JSON.stringify({
    version,
    files: Object.keys(files).sort().map((p) => [p, files[p]]),
    layout,
  });
  return sha256(canonical);
}

export function collect(env = process.env) {
  const exists = (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const layout = gitPathLayout(env.PATH, exists);
  // SURFACE_FILES is the FIXED egress surface; `layout` adds whatever else a bare `git`
  // can actually reach on this PATH. Both are hashed by CONTENT. Hashing the layout only
  // by path -- as this did until 2026-10-29 -- left a gap: a shim already in the layout
  // could be swapped for different code at the same path, and a path-only hash would
  // call that the same surface. The claim this file makes ("the only inputs that can
  // change what a measurement would find") only holds with the contents included.
  const files = {};
  for (const p of [...SURFACE_FILES, ...layout]) {
    if (p in files) continue; // layout normally re-names WRAPPER and REAL_GIT
    try {
      files[p] = sha256(readFileSync(p));
    } catch {
      files[p] = null; // absent is itself a meaningful change
    }
  }
  return {
    version: FINGERPRINT_VERSION,
    files,
    layout,
    wrapperAhead: wrapperIsAhead(layout),
    fingerprint: fingerprintFrom({ files, layout }),
  };
}

function main(argv = process.argv.slice(2)) {
  const r = collect();
  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify({ ...r, ts: new Date().toISOString() }) + "\n");
    return r;
  }
  process.stdout.write(
    `absolute-path-git surface fingerprint (rule v${r.version}): ${r.fingerprint}\n\n`,
  );
  for (const [p, h] of Object.entries(r.files)) {
    process.stdout.write(`  ${h ? h.slice(0, 16) : "ABSENT".padEnd(16)}  ${p}\n`);
  }
  process.stdout.write(`\n  PATH git resolution order (first wins):\n`);
  for (const [i, p] of r.layout.entries()) {
    process.stdout.write(`    ${i + 1}. ${p}\n`);
  }
  process.stdout.write(
    `\n  bare \`git\` reaches the wrapper: ${r.wrapperAhead ? "yes" : "NO -- guard is not ahead of /usr/bin"}\n`,
  );
  return r;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
