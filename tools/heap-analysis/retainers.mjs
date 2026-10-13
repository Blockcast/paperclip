// Retainer-path attribution for a .heapsnapshot (PEN-3631 / PEN-3314).
//
// summarize.mjs + report.mjs answer "WHAT grew" by (node type, constructor).
// They discard the `edges` section, so they can never answer "what RETAINS it",
// which is the question PEN-3314 actually asks. This tool answers that: it
// builds the reverse (retainer) edge index and walks sampled nodes of a chosen
// class up to a GC root, aggregating identical paths.
//
// usage:
//   node --max-old-space-size=6144 retainers.mjs <file.heapsnapshot> \
//        --select "<type>|<name>" [--samples 300] [--depth 12] [--top 15]
//   node ... retainers.mjs <file> --list            # classes by self size
//
//   <name> may be a literal constructor name ("Map"), or for string-ish nodes
//   the #hash8 printed by report.mjs ("#f4cd7070").
//
// SECURITY (same contract as report.mjs, see heap-tools/README.md): in this
// format a string node's "name" IS its contents and the file holds the worker's
// secrets in plaintext. Every string-ish payload is emitted as
// <type, Nch, #sha256-8> and never verbatim. Edge names and constructor names
// are program identifiers, not payloads, and are what make a path legible, so
// those are kept — but any name over STRING_KEEP_MAX chars is redacted too,
// because an over-long "identifier" is the shape a payload would arrive in.
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const file = args[0];
if (!file || file.startsWith("--")) {
  console.error("usage: retainers.mjs <file.heapsnapshot> [--list | --select \"type|name\"] [--samples N] [--depth D] [--top T]");
  process.exit(1);
}
const flag = (n, d) => { const i = args.indexOf("--" + n); return i < 0 ? d : args[i + 1]; };
const LIST = args.includes("--list");
const SELECT = flag("select", null);
const SAMPLES = Number(flag("samples", 300));
const MAX_DEPTH = Number(flag("depth", 12));
const TOP = Number(flag("top", 15));
const STRING_KEEP_MAX = 256;

const h8 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 8);
const mb = (b) => (b / 1048576).toFixed(1);

// ---------- byte reader ----------
const fh = await open(file, "r");
const CHUNK = 1 << 22;
const buf = Buffer.alloc(CHUNK);
let pos = 0, len = 0, eof = false, filePos = 0;
async function fill() {
  if (eof) return false;
  const { bytesRead } = await fh.read(buf, 0, CHUNK, filePos);
  filePos += bytesRead; len = bytesRead; pos = 0;
  if (bytesRead === 0) { eof = true; return false; }
  return true;
}
async function nextByte() { if (pos >= len) { if (!(await fill())) return -1; } return buf[pos++]; }
async function seek(needle) {
  const n = Buffer.from(needle, "latin1");
  let m = 0;
  for (;;) {
    const b = await nextByte();
    if (b < 0) return false;
    if (b === n[m]) { if (++m === n.length) return true; } else m = b === n[0] ? 1 : 0;
  }
}

// ---------- meta ----------
if (!(await seek('"snapshot":'))) throw new Error("no snapshot section");
let depth = 0, metaStr = "", started = false;
for (;;) {
  const b = await nextByte();
  if (b < 0) throw new Error("eof in meta");
  const ch = String.fromCharCode(b);
  if (ch === "{") { depth++; started = true; }
  if (started) metaStr += ch;
  if (ch === "}") { depth--; if (depth === 0) break; }
}
const meta = JSON.parse(metaStr);
const NF = meta.meta.node_fields, EF = meta.meta.edge_fields;
const NODE_TYPES = meta.meta.node_types[0], EDGE_TYPES = meta.meta.edge_types[0];
const iNType = NF.indexOf("type"), iNName = NF.indexOf("name"),
      iNSelf = NF.indexOf("self_size"), iNEdges = NF.indexOf("edge_count");
const iEType = EF.indexOf("type"), iEName = EF.indexOf("name_or_index"), iETo = EF.indexOf("to_node");
const NFIELDS = NF.length, EFIELDS = EF.length;
const N = meta.node_count, E = meta.edge_count;
// Edge types whose name_or_index is a STRING index; the rest are numeric.
const STR_EDGE = new Set(["context", "property", "internal", "shortcut", "weak"]
  .map((t) => EDGE_TYPES.indexOf(t)).filter((i) => i >= 0));

const nType = new Uint8Array(N), nName = new Uint32Array(N),
      nSelf = new Uint32Array(N), nEdges = new Uint32Array(N);
const eType = new Uint8Array(E), eName = new Uint32Array(E), eTo = new Uint32Array(E);

// ---------- flat int array reader ----------
async function readInts(section, fields, total, onRow) {
  if (!(await seek(section))) throw new Error("no " + section);
  const row = new Array(fields).fill(0);
  let f = 0, cur = 0, has = false, count = 0;
  const end = () => {
    row[f] = cur; f++; cur = 0; has = false;
    if (f === fields) { onRow(count, row); count++; f = 0; }
  };
  outer: for (;;) {
    if (pos >= len) { if (!(await fill())) break; }
    while (pos < len) {
      const b = buf[pos++];
      if (b >= 48 && b <= 57) { cur = cur * 10 + (b - 48); has = true; }
      else if (b === 44) end();
      else if (b === 93) { if (has) end(); break outer; }
    }
  }
  if (count !== total) console.error(`warn: ${section} parsed ${count}, meta said ${total}`);
  return count;
}

await readInts('"nodes":[', NFIELDS, N, (i, r) => {
  if (i >= N) return;
  nType[i] = r[iNType]; nName[i] = r[iNName]; nSelf[i] = r[iNSelf]; nEdges[i] = r[iNEdges];
});
await readInts('"edges":[', EFIELDS, E, (i, r) => {
  if (i >= E) return;
  eType[i] = r[iEType]; eName[i] = r[iEName]; eTo[i] = (r[iETo] / NFIELDS) | 0;
});

// ---------- strings (single pass; long payloads hashed, never retained) ----------
const names = new Map();      // idx -> string (short) or {len,hash} (long)
if (!(await seek('"strings":['))) throw new Error("no strings");
{
  let sIdx = 0, inStr = false, esc = false, acc = null;
  const flush = () => {
    let s;
    const raw = Buffer.from(acc).toString("utf8");
    try { s = JSON.parse('"' + raw + '"'); } catch { s = raw; }
    if (s.length > STRING_KEEP_MAX) names.set(sIdx, { len: s.length, hash: h8(s) });
    else names.set(sIdx, s);
  };
  outer2: for (;;) {
    if (pos >= len) { if (!(await fill())) break; }
    while (pos < len) {
      const b = buf[pos++];
      if (inStr) {
        if (esc) { acc.push(b); esc = false; continue; }
        if (b === 92) { acc.push(b); esc = true; continue; }
        if (b === 34) { flush(); inStr = false; acc = null; sIdx++; continue; }
        acc.push(b);
      } else if (b === 34) { inStr = true; acc = []; }
      else if (b === 93) break outer2;
    }
  }
}
await fh.close();

const STRINGY = new Set(["string", "concatenated string", "sliced string"]);
function rawName(i) { const v = names.get(i); return typeof v === "string" ? v : null; }
function safeNodeName(i, typeIdx) {
  const t = NODE_TYPES[typeIdx] ?? ("type" + typeIdx);
  const v = names.get(i);
  if (v === undefined) return "(anon)";
  if (typeof v !== "string") return `<${t}, ${v.len}ch, #${v.hash}>`;
  if (STRINGY.has(t)) return `<${t}, ${v.length}ch, #${h8(v)}>`;
  if (v.length > STRING_KEEP_MAX) return `<redacted, ${v.length}ch, #${h8(v)}>`;
  return v || "(anon)";
}
function edgeLabel(ei) {
  const t = eType[ei], tn = EDGE_TYPES[t] ?? ("etype" + t);
  if (!STR_EDGE.has(t)) return `[${eName[ei]}]`;         // element/hidden: numeric index
  const v = names.get(eName[ei]);
  if (typeof v !== "string") return v ? `<redacted #${v.hash}>` : "?";
  return (tn === "property" || tn === "context") ? v : `${v}(${tn})`;
}

// ---------- CSR: forward offsets, then reverse index ----------
const firstEdge = new Uint32Array(N + 1);
for (let i = 0, acc = 0; i < N; i++) { firstEdge[i] = acc; acc += nEdges[i]; firstEdge[i + 1] = acc; }
const retCount = new Uint32Array(N + 1);
for (let e = 0; e < E; e++) retCount[eTo[e]]++;
const retFirst = new Uint32Array(N + 1);
for (let i = 0, acc = 0; i < N; i++) { retFirst[i] = acc; acc += retCount[i]; retFirst[i + 1] = acc; }
const retEdge = new Uint32Array(E);
{
  const cursor = retFirst.slice(0, N);
  // owner of edge e = the node whose forward range contains e
  let owner = 0;
  for (let e = 0; e < E; e++) {
    while (owner < N - 1 && e >= firstEdge[owner + 1]) owner++;
    retEdge[cursor[eTo[e]]++] = e;
  }
}
// edge -> owner node, recomputed on demand via binary search over firstEdge
function edgeOwner(e) {
  let lo = 0, hi = N - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (firstEdge[mid] <= e) lo = mid; else hi = mid - 1; }
  return lo;
}

// ---------- class index ----------
const classKey = (i) => NODE_TYPES[nType[i]] + " | " + safeNodeName(nName[i], nType[i]);
if (LIST) {
  const agg = new Map();
  for (let i = 0; i < N; i++) {
    const k = classKey(i);
    const e = agg.get(k) || { c: 0, s: 0 }; e.c++; e.s += nSelf[i]; agg.set(k, e);
  }
  console.log(`# ${file.split("/").pop()}  nodes=${N} edges=${E}`);
  for (const [k, v] of [...agg].sort((a, b) => b[1].s - a[1].s).slice(0, 40))
    console.log(`${mb(v.s).padStart(9)}MB  ${String(v.c).padStart(9)}  ${k}`);
  process.exit(0);
}
if (!SELECT) { console.error("need --select \"type|name\" or --list"); process.exit(1); }
const [selType, selNameRaw] = SELECT.split("|").map((s) => s.trim());
const selHash = selNameRaw.startsWith("#") ? selNameRaw.slice(1) : null;
const targets = [];
for (let i = 0; i < N; i++) {
  if ((NODE_TYPES[nType[i]] ?? "") !== selType) continue;
  if (selHash) {
    const v = names.get(nName[i]);
    const hv = typeof v === "string" ? h8(v) : v?.hash;
    if (hv !== selHash) continue;
  } else {
    const v = rawName(nName[i]);
    if ((v ?? "") !== selNameRaw) continue;
  }
  targets.push(i);
}
if (targets.length === 0) { console.error(`no nodes match ${SELECT}`); process.exit(2); }

// ---------- greedy upward walk, per sampled target ----------
//
// NOT a BFS to a GC root. Measured on this snapshot: the `code` node for one
// loaded module carries 25,207 retainers, so a breadth-first walk to a root
// explodes into the shared script/context graph and returns nothing useful
// (every sampled node came back unresolved). Leak attribution does not need the
// root anyway — it needs the OWNING CONTAINER, which is within a few strong
// edges of the object. So: walk up preferring named, strong edges, and stop as
// soon as the path reaches something shared enough that it no longer attributes.
const EDGE_RANK = { property: 0, context: 1, element: 2, internal: 3, hidden: 4, shortcut: 5 };
const FANOUT_STOP = Number(flag("fanout", 2000));

function walkUp(start) {
  const segs = [];
  let cur = start;
  const visited = new Set([start]);
  for (let d = 0; d < MAX_DEPTH; d++) {
    const lo = retFirst[cur], hi = retFirst[cur + 1];
    if (lo === hi) { segs.push("(no retainer — GC root or detached)"); break; }
    if (hi - lo > FANOUT_STOP) { segs.push(`(shared: ${hi - lo} retainers)`); break; }
    let best = -1, bestRank = 99;
    for (let r = lo; r < hi; r++) {
      const e = retEdge[r];
      const tn = EDGE_TYPES[eType[e]] ?? "";
      if (tn === "weak") continue;
      const rank = EDGE_RANK[tn] ?? 9;
      if (rank < bestRank) {
        const own = edgeOwner(e);
        if (visited.has(own)) continue;
        bestRank = rank; best = r;
      }
    }
    if (best < 0) { segs.push("(only weak/cyclic retainers)"); break; }
    const e = retEdge[best], own = edgeOwner(e);
    visited.add(own);
    segs.push(`${NODE_TYPES[nType[own]]}:${safeNodeName(nName[own], nType[own])}.${edgeLabel(e)}`);
    cur = own;
  }
  return segs.join("  <-  ");
}
const signature = walkUp;

const step = Math.max(1, Math.floor(targets.length / SAMPLES));
const agg = new Map();
let sampled = 0, unresolved = 0, selfSum = 0;
for (let i = 0; i < targets.length && sampled < SAMPLES; i += step) {
  const t = targets[i]; sampled++; selfSum += nSelf[t];
  const sig = signature(t);
  if (!sig) { unresolved++; continue; }
  const e = agg.get(sig) || { c: 0, s: 0 };
  e.c++; e.s += nSelf[t]; agg.set(sig, e);
}
const totalSelf = targets.reduce((s, i) => s + nSelf[i], 0);
console.log(`# retainers for  ${SELECT}`);
console.log(`matched ${targets.length} nodes, ${mb(totalSelf)}MB self; sampled ${sampled} (every ${step}), unresolved ${unresolved}\n`);
for (const [sig, v] of [...agg].sort((a, b) => b[1].c - a[1].c).slice(0, TOP)) {
  console.log(`${String(v.c).padStart(5)} / ${sampled}  (${((v.c / sampled) * 100).toFixed(0)}% of sample, ${mb(v.s)}MB sampled self)`);
  for (const seg of sig.split("  <-  ")) console.log(`        <- ${seg}`);
  console.log("");
}
