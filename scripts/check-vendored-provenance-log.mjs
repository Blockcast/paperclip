#!/usr/bin/env node
// BLO-35109. Replaces the stored 64-hex integrity manifest that used to live in
// vendor/paperclip-adapter-claude-k8s/PROVENANCE.md.
//
// That hash was single-valued by construction, so two concurrent PRs that each
// touched the vendored tree always produced two different values on one line and
// always conflicted -- and `merge=union` (BLO-34872) structurally cannot reach a
// single-valued field: a union would keep both hashes and CI's
// `grep -oE '^[0-9a-f]{64}$' | head -1` would then resolve the provenance verdict
// by sort order rather than by the tree.
//
// The hash never attested upstream-ness -- it was recomputed from our own tree,
// which has diverged. Its only real job was to force a PROVENANCE edit whenever
// vendored source changed. This checks that directly instead: a state invariant
// (a stored constant, which every PR must rewrite) becomes a transition
// invariant (a diff, which nothing stores and nothing can conflict on).
//
// It is also strictly less false-positive than the hash was. Two PRs editing
// different lines of the same vendored file merge correctly, and the combined
// tree's hash matched neither recorded value -- so the hash failed every
// combination, correct or not. It could not tell a bad merge from two good ones.
//
// Usage: node scripts/check-vendored-provenance-log.mjs --base <sha> [--head <sha>]
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VENDOR_DIR = "vendor/paperclip-adapter-claude-k8s";
export const LOG = `${VENDOR_DIR}/PROVENANCE-CHANGES.md`;

// Blockcast additions, not vendored source. Changing one of these alone is not a
// vendored change and needs no log row.
//
// The log file is deliberately NOT listed, and that is not an oversight: a
// change touching only the log is already satisfied by the row it appends, so
// an entry for it has no failing mutation -- i.e. it would be a comment wearing
// a guard's clothes. Measured: removing it leaves the suite green.
export const NOT_SOURCE = [`${VENDOR_DIR}/LICENSE`, `${VENDOR_DIR}/PROVENANCE.md`];

/**
 * @returns {{ok: true} | {ok: false, reason: string, detail: string[]}}
 */
export function checkVendoredProvenanceLog({ base, head = "HEAD", cwd }) {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", cwd });
  // Three-dot: diff against the merge base, so base-branch commits landed since
  // the branch point do not masquerade as changes made by this PR.
  const range = `${base}...${head}`;

  const numstat = git("diff", "--numstat", range, "--", LOG).trim();
  const [added, deleted] = numstat
    ? numstat.split("\t").slice(0, 2).map(Number)
    : [0, 0];

  // `git diff --numstat` emits `-\t-` for a blob it treats as binary, so both
  // counts parse to NaN and every comparison below is false: the guard would
  // pass on exactly the input it exists to reject -- including a destructively
  // rewritten log, which is the case the append-only rule is here for. Reject
  // non-finite rather than comparing against it.
  if (!Number.isFinite(added) || !Number.isFinite(deleted)) {
    return {
      ok: false,
      reason: `${LOG} is not a text file; provenance cannot be verified.`,
      detail: [
        "git reports it as binary, so added/removed rows cannot be counted and",
        "the append-only rule cannot be enforced. Check for a stray NUL byte or",
        "a non-UTF-8 encoding, and restore the file as UTF-8 text.",
      ],
    };
  }

  // Unconditional, because append-only is what makes `merge=union` on this file
  // safe at all: a union resolves by keeping both sides' added lines and cannot
  // reconcile an edit, so a rewritten row would be silently duplicated on the
  // next concurrent append. In a diff, an edit or a reorder is a deletion.
  if (deleted > 0) {
    return {
      ok: false,
      reason: `${LOG} is append-only, but this change removes ${deleted} line(s) from it.`,
      detail: [
        "Append new rows at the end; never edit or reorder existing ones.",
        "To correct an earlier row, append a row that supersedes it.",
      ],
    };
  }

  const changed = git("diff", "--name-only", range, "--", VENDOR_DIR)
    .split("\n")
    .filter(Boolean)
    .filter((p) => !NOT_SOURCE.includes(p));

  if (changed.length === 0) return { ok: true };

  // Count added *rows*, not added lines: a bare `added > 0` is satisfied by a
  // blank line, so the cheapest way to silence the guard would be to add
  // nothing. Row quality is still left to human review -- this only rules out
  // the whitespace-only satisfier. The `+++ b/path` diff header cannot match,
  // since the character after its leading `+` is neither space nor `|`.
  const addedRows = git("diff", "--unified=0", range, "--", LOG)
    .split("\n")
    .filter((line) => /^\+\s*\|/.test(line));

  if (addedRows.length < 1) {
    return {
      ok: false,
      reason: `Vendored source changed but ${LOG} gained no row.`,
      detail: [
        "Append one row describing the change, so the recorded provenance does",
        "not silently drift from what is actually in the tree. Changed files:",
        ...changed.map((p) => `  ${p}`),
      ],
    };
  }

  return { ok: true };
}

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};

export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  return Boolean(argvPath) && resolve(argvPath) === fileURLToPath(moduleUrl);
}

if (isMainModule()) {
  const base = arg("--base");
  if (!base) {
    console.error("usage: --base <sha> [--head <sha>]");
    process.exit(2);
  }
  const result = checkVendoredProvenanceLog({ base, head: arg("--head") ?? "HEAD" });
  if (!result.ok) {
    console.error(`::error::${result.reason}`);
    for (const line of result.detail) console.error(line);
    process.exit(1);
  }
  console.log(`${LOG}: ok`);
}
