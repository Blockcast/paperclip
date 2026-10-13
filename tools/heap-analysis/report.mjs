// Baseline view of one summarised snapshot, or a diff of two.
import { readFileSync } from "node:fs";
import { h8, STRINGY, isRedacted } from "./redact.mjs";
const mb = (b) => (b / 1048576).toFixed(1);
const load = (p) => JSON.parse(readFileSync(p, "utf8"));
// SECURITY: in a .heapsnapshot a string node's "name" IS its contents, and the
// file holds the worker's secrets in plaintext. Never emit string payloads.
// Summaries written by summarize.mjs are already redacted on disk; this keeps
// working on a pre-PEN-3631 raw summary, and emits the same bytes for both.
const safeName = (r) => {
  if (isRedacted(r.name)) return r.name;
  const n = r.name || "(anon)";
  if (STRINGY.has(r.type)) return `<${r.type}, ${n.length}ch, #${h8(n)}>`;
  return n.length > 70 ? n.slice(0, 70) + "\u2026" : n;
};
const key = (r) => r.type + " | " + safeName(r);

const a = load(process.argv[2]);
const b = process.argv[3] ? load(process.argv[3]) : null;

if (!b) {
  console.log(`# snapshot ${a.file.split("/").pop()}`);
  console.log(`nodes=${a.nodeCount}  totalSelf=${mb(a.totalSelf)}MB  distinct=${a.rows.length}\n`);
  const byType = new Map();
  for (const r of a.rows) {
    const e = byType.get(r.type) || { count: 0, self: 0 };
    e.count += r.count; e.self += r.self; byType.set(r.type, e);
  }
  console.log("## by node type");
  for (const [t, e] of [...byType].sort((x, y) => y[1].self - x[1].self))
    console.log(`${mb(e.self).padStart(9)}MB  ${String(e.count).padStart(9)}  ${t}`);
  console.log("\n## top 25 by self size");
  for (const r of [...a.rows].sort((x, y) => y.self - x.self).slice(0, 25))
    console.log(`${mb(r.self).padStart(9)}MB  ${String(r.count).padStart(9)}  ${key(r)}`);
} else {
  const ma = new Map(), mbb = new Map();
  for (const r of a.rows) { const k = key(r); const e = ma.get(k) || { count: 0, self: 0 }; e.count += r.count; e.self += r.self; ma.set(k, e); }
  for (const r of b.rows) { const k = key(r); const e = mbb.get(k) || { count: 0, self: 0 }; e.count += r.count; e.self += r.self; mbb.set(k, e); }
  const keys = new Set([...ma.keys(), ...mbb.keys()]);
  const rows = [];
  for (const k of keys) {
    const x = ma.get(k) || { count: 0, self: 0 }, y = mbb.get(k) || { count: 0, self: 0 };
    rows.push({ k, dCount: y.count - x.count, dSelf: y.self - x.self, aC: x.count, bC: y.count, aS: x.self, bS: y.self });
  }
  const dTotal = b.totalSelf - a.totalSelf;
  console.log(`# DIFF  A=${a.file.split("/").pop()}  ->  B=${b.file.split("/").pop()}`);
  console.log(`totalSelf ${mb(a.totalSelf)}MB -> ${mb(b.totalSelf)}MB   delta ${dTotal >= 0 ? "+" : ""}${mb(dTotal)}MB`);
  console.log(`nodes ${a.nodeCount} -> ${b.nodeCount}  delta ${b.nodeCount - a.nodeCount}\n`);
  console.log("## top 30 GROWERS by self-size delta");
  console.log("    dSelf        dCount     countA ->   countB   type | name");
  for (const r of rows.sort((p, q) => q.dSelf - p.dSelf).slice(0, 30))
    console.log(`${(r.dSelf >= 0 ? "+" : "") + mb(r.dSelf)}MB`.padStart(11) + `  ${(r.dCount >= 0 ? "+" : "") + r.dCount}`.padStart(12) + `  ${String(r.aC).padStart(9)} -> ${String(r.bC).padStart(9)}   ${r.k}`);
  console.log("\n## top 12 SHRINKERS");
  for (const r of rows.sort((p, q) => p.dSelf - q.dSelf).slice(0, 12))
    console.log(`${mb(r.dSelf)}MB`.padStart(11) + `  ${r.dCount}`.padStart(12) + `  ${String(r.aC).padStart(9)} -> ${String(r.bC).padStart(9)}   ${r.k}`);
  const growers = rows.filter((r) => r.dSelf > 0).sort((p, q) => q.dSelf - p.dSelf);
  const top10 = growers.slice(0, 10).reduce((s, r) => s + r.dSelf, 0);
  console.log(`\n## concentration: top-10 growers = ${mb(top10)}MB of ${mb(dTotal)}MB net growth (${dTotal > 0 ? ((top10 / dTotal) * 100).toFixed(0) : "n/a"}% )`);
}
