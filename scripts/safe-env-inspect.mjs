#!/usr/bin/env node
/**
 * safe-env-inspect.mjs
 *
 * BLO-20989: the PEN-1305 env-guard (server/src/agent-shell-guard.ts) blocks
 * shell-native environment dumps (`env`, `printenv`, `set`, ...) and points
 * an agent that needs to inspect its environment at this script instead. The
 * guard's error message has named this path since 2026-07-14, but the file
 * never existed — so an agent that hit the guard and needed an answer had no
 * real alternative and improvised with `node -e` over `process.env`, which
 * is how a Postgres password ended up in a run transcript.
 *
 * Names-only by construction, not by a masking heuristic: this script never
 * reads a variable's value, so there is no regex to get wrong. If you need a
 * specific value, read that one variable by name (e.g. `printenv FOO` or
 * `process.env.FOO`), which the guard already permits as a scoped read.
 */

const names = Object.keys(process.env).sort();

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(names, null, 2));
} else {
  for (const name of names) console.log(name);
}
