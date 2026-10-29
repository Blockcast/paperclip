#!/usr/bin/env node
// PEN-4986: count `git` invocations that reach a REAL git binary WITHOUT
// transiting the paperclip egress wrapper.
//
// This is the measurement §8 of
// `docs/security/PEN-3183-git-egress-enforcement-boundary-decision.md` names as
// its highest-value item, and the one §7.1's residual acceptance is conditional
// on. A non-zero count is §7.2 trigger 4 and ends that acceptance early,
// regardless of the calendar date. Re-take it when the egress-relevant surface
// changes (§5 of the PEN-4986 doc); the result of a run is only ever a
// statement about the image and pod it ran in.
//
// Usage (inside an agent pod, as the agent's own uid):
//   node scripts/measure-absolute-path-git.mjs <out.ndjson> [intervalMs] [calibExe]
//   # ... let it run across representative work, then:
//   kill -TERM <pid>            # emits the {"kind":"stop"} summary record
//
// WHICH BINARIES COUNT  (⚠ this is not one path — PEN-4986 review finding)
// -----------------------------------------------------------------------
// The first version of this script watched the single path `/usr/bin/git`, on
// the assumption that it is the only way to reach the real binary. It is not.
// Measured in an agent pod on image sha-ed39009: `/usr/lib/git-core/git` is a
// SEPARATE regular file (inode 2374935 vs 2374866), byte-identical to
// `/usr/bin/git` (sha256 356db14e…), and NOT a symlink to it. `readlink
// /proc/<pid>/exe` reports whichever path was exec'd, so an accidental
// `/usr/lib/git-core/git push` skips the wrapper, is still authenticated by
// `/etc/gitconfig`'s system helper (§4.0), and was invisible to the old
// instrument. An unobserved exe path produces exactly the false zero this
// measurement must not produce.
//
// So the target set is DISCOVERED, by identity rather than by path, and the
// run records what it watched:
//
//   class A ("real-git")   every regular file under the candidate directories
//                          that is byte-identical to /usr/bin/git, keyed by
//                          (dev, inode). This is §8's count: the git dispatcher,
//                          by whatever path it is reached. Symlinks and
//                          hardlinks collapse onto the inode automatically.
//   class B ("git-core")   every other executable program in the git exec
//                          directory. These are distinct binaries, not copies of
//                          git — but git-remote-http, git-http-fetch,
//                          git-http-push and scalar read /etc/gitconfig and
//                          invoke credential helpers themselves, so a direct
//                          invocation of one is the same §4.0 bypass. They are
//                          counted and reported SEPARATELY from the headline,
//                          because in normal use they are descendants of a git
//                          process rather than independent invocations.
//
// WHY /proc POLLING AND NOT SOMETHING BETTER
// ------------------------------------------
// The honest answer is that nothing better is reachable. An exec-level trace
// (eBPF, audit, Tetragon/Falco) is the right instrument and NONE is deployed in
// this cluster, so there is no fleet-wide source to query. Nor can one be
// obtained from inside the pod: the agent container runs `runAsNonRoot` with
// `allowPrivilegeEscalation: false` and `capabilities: { drop: [ALL] }` (§3 of
// the decision doc), which is exactly the hardening that forbids attaching a
// tracer — and relaxing it is on §8's "not permitted" list. Polling `/proc` is
// what is left to an unprivileged observer, and it is read-only: this script
// executes nothing and publishes nothing.
//
// WHAT "DID NOT TRANSIT THE WRAPPER" MEANS HERE
// ---------------------------------------------
// The wrapper (/usr/local/libexec/paperclip/bin/git) execs the real binary with
// the paperclip credential helper injected as `-c` flags. So a wrapped
// invocation is identifiable three independent ways, and this script accepts
// ANY of them — deliberately biasing toward classifying an invocation as
// WRAPPED, so that the headline "unwrapped" count errs low rather than crying
// wolf:
//
//   1. argv carries the paperclip helper `-c` flag  (the direct exec)
//   2. GIT_CONFIG_PARAMETERS carries it             (git's own way of handing
//      `-c` down to child processes, so DESCENDANT gits inherit the evidence —
//      without this, every sub-git a wrapped git spawns would be miscounted)
//   3. an ANCESTOR's argv names the egress runtime, the wrapper, or the
//      paperclip helper (so a class-B helper exec'd by a wrapped git, which
//      carries neither signature of its own, is not miscounted as a finding)
//
// ⛔ WHAT A ZERO FROM THIS SCRIPT DOES NOT MEAN
// ---------------------------------------------
//   - It is NOT fleet-wide. One run observes ONE pod. The population of a
//     measurement is the set of pods it was actually run in; write that down
//     beside the number rather than generalising from it.
//   - It is NOT lossless. A process is only seen if a sweep lands inside its
//     lifetime, so short-lived invocations can be missed. Pass `calibExe` — a
//     COPY of the git binary at a DIFFERENT path, e.g.
//     `cp /usr/bin/git /tmp/git-calib` — and invoke it N times during the run;
//     `{"kind":"calib"}` records divided by N is the measured catch rate for
//     the shortest-lived invocation class. A copy is used rather than
//     /usr/bin/git itself so that calibrating cannot contaminate the count; the
//     copy's inode is excluded from the target set explicitly.
//   - It says nothing about what is INSTALLED, only about what RAN. Pair it
//     with a source/image census for the other half.
//   - It cannot see a binary that is not in the discovered sets — a git built
//     or unpacked somewhere outside the candidate directories, for instance.
//     The `start` record names every directory searched so that gap is
//     auditable rather than implicit.
import { readdirSync, readlinkSync, readFileSync, statSync, appendFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const REFERENCE_GIT = "/usr/bin/git";
export const GIT_CORE_DIR = "/usr/lib/git-core";
// Flat, non-recursive: every directory a git binary is plausibly reachable from
// in this image. A recursive walk of /usr or /opt would be unbounded for no
// gain, and the gap it leaves is stated in the header and in the start record.
export const CANDIDATE_DIRS = [
  "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  "/usr/local/bin", "/usr/local/sbin", "/usr/local/libexec/paperclip/bin",
  GIT_CORE_DIR, "/usr/libexec/git-core", "/usr/local/libexec/git-core",
];
export const WRAPPER = "/usr/local/libexec/paperclip/bin/git";
export const PAPERCLIP_HELPER =
  "/usr/local/libexec/paperclip/bin/github-token-credential-helper";
export const RUNTIME_JS = "github-git-egress-runtime.js";

/**
 * Decide whether one observed git invocation transited the wrapper.
 * Pure, so the rule a future re-run depends on is testable without a pod.
 *
 * Note what the ancestor arm matches and why. An earlier version tested
 * `a.exe === WRAPPER`, which can never fire: the wrapper is a `#!/bin/sh`
 * script, so `/proc/<pid>/exe` reports `/bin/sh`, and it `exec`s away into the
 * token shim and then node, so it is never a live ancestor either. Matching the
 * wrapper's PATH IN AN ANCESTOR'S ARGV is what actually works.
 */
export function classifyGitInvocation({ argv = [], gitConfigParameters = null, ancestry = [] }) {
  const viaArgv = argv.join(" ").includes(PAPERCLIP_HELPER);
  const viaEnv = typeof gitConfigParameters === "string" && gitConfigParameters.includes(PAPERCLIP_HELPER);
  const viaAncestor = ancestry.some((a) => {
    const text = a.argv ?? "";
    return text.includes(RUNTIME_JS) || text.includes(WRAPPER) || text.includes(PAPERCLIP_HELPER);
  });
  return { wrapped: viaArgv || viaEnv || viaAncestor, evidence: { viaArgv, viaEnv, viaAncestor } };
}

const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const argvOf = (pid) => (read(`/proc/${pid}/cmdline`) ?? "").split("\0").filter(Boolean);
const exeOf = (pid) => { try { return readlinkSync(`/proc/${pid}/exe`); } catch { return null; } };
const idOf = (p) => { try { const s = statSync(p); return `${s.dev}:${s.ino}`; } catch { return null; } };
const sha256 = (p) => { try { return createHash("sha256").update(readFileSync(p)).digest("hex"); } catch { return null; } };

/**
 * Build the two watched sets by IDENTITY, not by path, so that every alias of a
 * binary — symlink, hardlink, second copy at another path — collapses onto one
 * entry and none of them is invisible.
 *
 * @returns {{ realGit: Map<string,string[]>, gitCore: Map<string,string[]>, dirs: string[], reference: {path:string,size:number,sha256:string|null} }}
 */
export function discoverGitBinaries({
  reference = REFERENCE_GIT,
  dirs = CANDIDATE_DIRS,
  gitCoreDir = GIT_CORE_DIR,
  excludeIds = [],
} = {}) {
  const refStat = (() => { try { return statSync(reference); } catch { return null; } })();
  const refHash = refStat ? sha256(reference) : null;
  const realGit = new Map();  // `${dev}:${ino}` -> paths that reach it
  const gitCore = new Map();
  const excluded = new Set(excludeIds);

  const note = (map, id, path) => {
    if (id === null || excluded.has(id)) return;
    const paths = map.get(id) ?? [];
    if (!paths.includes(path)) paths.push(path);
    map.set(id, paths);
  };

  for (const dir of dirs) {
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const path = `${dir}/${name}`;
      let st;
      try { st = statSync(path); } catch { continue; }   // follows symlinks on purpose
      if (!st.isFile()) continue;
      const id = `${st.dev}:${st.ino}`;
      // Class A: byte-identical to the reference git binary. Size first so the
      // hash is paid only for real candidates.
      if (refStat && st.size === refStat.size && refHash !== null && sha256(path) === refHash) {
        note(realGit, id, path);
        continue;
      }
      // Class B: any other executable program in git's exec directory.
      // git-remote-http, git-http-fetch, git-http-push and scalar reach the
      // network and call credential helpers on their own account.
      if (dir === gitCoreDir && (st.mode & 0o111) !== 0) note(gitCore, id, path);
    }
  }
  for (const id of realGit.keys()) gitCore.delete(id);
  return {
    realGit, gitCore, dirs: [...dirs],
    reference: { path: reference, size: refStat?.size ?? null, sha256: refHash },
  };
}

// /proc/<pid>/stat: `comm` may contain spaces and parentheses, so the fields
// after it are found from the LAST ')' rather than by splitting the whole line.
function statOf(pid) {
  const raw = read(`/proc/${pid}/stat`);
  if (!raw) return null;
  const i = raw.lastIndexOf(")");
  if (i < 0) return null;
  const f = raw.slice(i + 2).split(" ");
  return { comm: raw.slice(raw.indexOf("(") + 1, i), ppid: f[1], starttime: f[19] };
}

function gitConfigParametersOf(pid) {
  const raw = read(`/proc/${pid}/environ`);
  if (raw === null) return { readable: false, value: null };
  for (const kv of raw.split("\0")) {
    if (kv.startsWith("GIT_CONFIG_PARAMETERS=")) {
      return { readable: true, value: kv.slice("GIT_CONFIG_PARAMETERS=".length) };
    }
  }
  return { readable: true, value: null };
}

function ancestryOf(pid, depth = 8) {
  const chain = [];
  let cur = pid;
  for (let i = 0; i < depth; i++) {
    const st = statOf(cur);
    if (!st || cur === "1" || cur === "0") break;
    chain.push({ pid: cur, comm: st.comm, exe: exeOf(cur), argv: argvOf(cur).join(" ").slice(0, 400) });
    cur = st.ppid;
    if (!cur || cur === "0") break;
  }
  return chain;
}

export function main(argvIn = process.argv.slice(2)) {
  const out = argvIn[0] ?? "./absolute-path-git-observations.ndjson";
  const intervalMs = Number(argvIn[1] ?? 2);
  const calibExe = argvIn[2] ?? null;
  const calibId = calibExe === null ? null : idOf(calibExe);
  const targets = discoverGitBinaries({ excludeIds: calibId === null ? [] : [calibId] });
  const seen = new Set(); // `${pid}:${starttime}` — stable across pid reuse
  const tally = { observation: 0, "git-core": 0, calib: 0, indeterminate: 0, wrapped: 0, unwrapped: 0 };
  let sweeps = 0;
  let lastProgress = 0;
  const emit = (o) => appendFileSync(out, JSON.stringify(o) + "\n");

  // One inode is reachable by many names (git-core alone symlinks ~140 names
  // onto the git dispatcher), so the start record names the inode, how many
  // paths reach it, and a sample — not all of them.
  const describe = (m) =>
    [...m.entries()].map(([id, paths]) => ({ id, pathCount: paths.length, paths: paths.slice(0, 6) }));
  emit({
    kind: "start", ts: new Date().toISOString(), intervalMs, pid: process.pid,
    reference: targets.reference,
    searchedDirs: targets.dirs,
    realGit: describe(targets.realGit),
    gitCore: describe(targets.gitCore),
    calibExe, calibId,
  });

  const sweep = () => {
    sweeps++;
    let entries;
    try { entries = readdirSync("/proc"); } catch { return; }
    for (const e of entries) {
      const c = e.charCodeAt(0);
      if (c < 48 || c > 57) continue; // numeric entries are the pids
      const exe = exeOf(e);
      if (exe === null) continue;
      // Identity first: catches every alias of a watched binary. Fall back to
      // the path only when the inode is unreadable (e.g. a deleted exe).
      const id = idOf(`/proc/${e}/exe`);
      const isCalib = calibId !== null && (id === calibId || exe === calibExe);
      let klass = null;
      if (isCalib) klass = "calib";
      else if (id !== null && targets.realGit.has(id)) klass = "observation";
      else if (id !== null && targets.gitCore.has(id)) klass = "git-core";
      else if (id === null && exe === REFERENCE_GIT) klass = "observation";
      if (klass === null) continue;
      const st = statOf(e);
      if (!st) continue;
      const key = `${e}:${st.starttime}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // A process caught inside execve reads back with an EMPTY /proc/<pid>/cmdline:
      // the kernel has swapped the mm but not yet written the new argv. Such a
      // sample carries no evidence either way, and scoring it `unwrapped` --
      // which the first version did -- manufactures findings out of ordinary
      // traffic. Since a non-zero count is §7.2 trigger 4, an instrument that
      // cries wolf is as useless as one that is blind. One immediate re-read
      // clears most of the race; what survives is reported as INDETERMINATE,
      // never as wrapped and never as a finding.
      let argv = argvOf(e);
      if (argv.length === 0) argv = argvOf(e);
      const gcp = gitConfigParametersOf(e);
      const ancestry = ancestryOf(st.ppid);
      const indeterminate = argv.length === 0;
      if (indeterminate) klass = klass === "calib" ? "calib" : "indeterminate";
      const cls = (klass === "calib" || indeterminate)
        ? { wrapped: null, evidence: null }
        : classifyGitInvocation({ argv, gitConfigParameters: gcp.value, ancestry });
      emit({
        kind: klass,
        ...(indeterminate ? { reason: "argv-unreadable: process caught inside execve" } : {}),
        ts: new Date().toISOString(),
        pid: e, starttime: st.starttime, exe, exeId: id,
        argv: argv.join(" ").slice(0, 600),
        wrapped: cls.wrapped,
        evidence: cls.evidence ? { ...cls.evidence, environReadable: gcp.readable } : null,
        gitConfigParameters: gcp.value ? gcp.value.slice(0, 400) : null,
        cwd: (() => { try { return readlinkSync(`/proc/${e}/cwd`); } catch { return null; } })(),
        ancestry: ancestry.map((a) => ({ pid: a.pid, comm: a.comm, exe: a.exe, argv: a.argv.slice(0, 200) })),
        sweepIndex: sweeps,
      });
      tally[klass] = (tally[klass] ?? 0) + 1;
      if (cls.wrapped === true) tally.wrapped++;
      else if (cls.wrapped === false) tally.unwrapped++;
    }
    const now = Date.now();
    if (now - lastProgress > 60_000) {
      lastProgress = now;
      writeFileSync(out.replace(/\.ndjson$/, "") + ".progress.json",
        JSON.stringify({ ts: new Date().toISOString(), sweeps, distinctProcesses: seen.size }) + "\n");
    }
  };

  const timer = setInterval(sweep, intervalMs);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      clearInterval(timer);
      emit({ kind: "stop", ts: new Date().toISOString(), sweeps, distinctProcesses: seen.size, tally, signal: sig });
      process.exit(0);
    });
  }
  return timer;
}

// Run only when executed directly, not when imported by the test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
