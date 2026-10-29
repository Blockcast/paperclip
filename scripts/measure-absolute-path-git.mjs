#!/usr/bin/env node
// PEN-4986: count `git` invocations that reach the REAL binary (/usr/bin/git)
// WITHOUT transiting the paperclip egress wrapper.
//
// This is the measurement §8 of
// `docs/security/PEN-3183-git-egress-enforcement-boundary-decision.md` names as
// its highest-value item, and the one §7.1's residual acceptance is conditional
// on. A non-zero count is §7.2 trigger 4 and ends that acceptance early,
// regardless of the calendar date. Re-take it whenever the agent image or the
// PATH layout changes; the result of a run is only ever a statement about the
// image and pod it ran in.
//
// Usage (inside an agent pod, as the agent's own uid):
//   node scripts/measure-absolute-path-git.mjs <out.ndjson> [intervalMs] [calibExe]
//   # ... let it run across representative work, then:
//   kill -TERM <pid>            # emits the {"kind":"stop"} summary record
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
//   3. an ancestor process is the wrapper or the egress runtime
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
//     /usr/bin/git itself so that calibrating cannot contaminate the count.
//   - It says nothing about what is INSTALLED, only about what RAN. Pair it
//     with a source/image census for the other half.
//
// Only `/usr/bin/git` is counted, which is the measurement as §8 words it.
// Git's own helpers under /usr/lib/git-core are a different exe path and are
// deliberately not counted as separate invocations; they are descendants and
// carry their parent's classification.
import { readdirSync, readlinkSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const REAL_GIT = "/usr/bin/git";
export const WRAPPER = "/usr/local/libexec/paperclip/bin/git";
export const PAPERCLIP_HELPER =
  "/usr/local/libexec/paperclip/bin/github-token-credential-helper";
export const RUNTIME_JS = "github-git-egress-runtime.js";

/**
 * Decide whether one observed /usr/bin/git process transited the wrapper.
 * Pure, so the rule a future re-run depends on is testable without a pod.
 */
export function classifyGitInvocation({ argv = [], gitConfigParameters = null, ancestry = [] }) {
  const viaArgv = argv.join(" ").includes(PAPERCLIP_HELPER);
  const viaEnv = typeof gitConfigParameters === "string" && gitConfigParameters.includes(PAPERCLIP_HELPER);
  const viaAncestor = ancestry.some((a) => (a.argv ?? "").includes(RUNTIME_JS) || a.exe === WRAPPER);
  return { wrapped: viaArgv || viaEnv || viaAncestor, evidence: { viaArgv, viaEnv, viaAncestor } };
}

const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const argvOf = (pid) => (read(`/proc/${pid}/cmdline`) ?? "").split("\0").filter(Boolean);
const exeOf = (pid) => { try { return readlinkSync(`/proc/${pid}/exe`); } catch { return null; } };

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
  const seen = new Set(); // `${pid}:${starttime}` — stable across pid reuse
  let sweeps = 0;
  let lastProgress = 0;
  const emit = (o) => appendFileSync(out, JSON.stringify(o) + "\n");

  emit({ kind: "start", ts: new Date().toISOString(), intervalMs, target: REAL_GIT, calibExe, pid: process.pid });

  const sweep = () => {
    sweeps++;
    let entries;
    try { entries = readdirSync("/proc"); } catch { return; }
    for (const e of entries) {
      const c = e.charCodeAt(0);
      if (c < 48 || c > 57) continue; // numeric entries are the pids
      const exe = exeOf(e);
      if (exe === null) continue;
      const isTarget = exe === REAL_GIT;
      const isCalib = calibExe !== null && exe === calibExe;
      if (!isTarget && !isCalib) continue;
      const st = statOf(e);
      if (!st) continue;
      const key = `${e}:${st.starttime}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const argv = argvOf(e);
      const gcp = gitConfigParametersOf(e);
      const ancestry = ancestryOf(st.ppid);
      const cls = isTarget
        ? classifyGitInvocation({ argv, gitConfigParameters: gcp.value, ancestry })
        : { wrapped: null, evidence: null };
      emit({
        kind: isCalib ? "calib" : "observation",
        ts: new Date().toISOString(),
        pid: e, starttime: st.starttime, exe,
        argv: argv.join(" ").slice(0, 600),
        wrapped: cls.wrapped,
        evidence: cls.evidence ? { ...cls.evidence, environReadable: gcp.readable } : null,
        gitConfigParameters: gcp.value ? gcp.value.slice(0, 400) : null,
        cwd: (() => { try { return readlinkSync(`/proc/${e}/cwd`); } catch { return null; } })(),
        ancestry: ancestry.map((a) => ({ pid: a.pid, comm: a.comm, exe: a.exe, argv: a.argv.slice(0, 200) })),
        sweepIndex: sweeps,
      });
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
      emit({ kind: "stop", ts: new Date().toISOString(), sweeps, distinctProcesses: seen.size, signal: sig });
      process.exit(0);
    });
  }
  return timer;
}

// Run only when executed directly, not when imported by the test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
