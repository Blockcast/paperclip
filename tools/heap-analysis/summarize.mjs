// Streaming .heapsnapshot summariser.
// Output is REDACTED at the write (redact.mjs): a string node's name is its
// contents, and this file's output outlives the snapshot it came from.
// Aggregates count + self_size per (node type, constructor name) without
// JSON.parse-ing the whole file (these are hundreds of MB).
// Single sequential pass: snapshot meta -> nodes -> strings.
import { open } from "node:fs/promises";
import { redactName } from "./redact.mjs";

const file = process.argv[2];
if (!file) { console.error("usage: summarize.mjs <file.heapsnapshot>"); process.exit(1); }

const fh = await open(file, "r");
const size = (await fh.stat()).size;

const CHUNK = 1 << 22;
let buf = Buffer.alloc(CHUNK);
let pos = 0, len = 0, eof = false, filePos = 0;

async function fill() {
  if (eof) return false;
  const { bytesRead } = await fh.read(buf, 0, CHUNK, filePos);
  filePos += bytesRead; len = bytesRead; pos = 0;
  if (bytesRead === 0) { eof = true; return false; }
  return true;
}
async function nextByte() {
  if (pos >= len) { if (!(await fill())) return -1; }
  return buf[pos++];
}
// Scan forward until `needle` (ASCII) has been consumed.
async function seek(needle) {
  const n = Buffer.from(needle, "latin1");
  let m = 0;
  for (;;) {
    const b = await nextByte();
    if (b < 0) return false;
    if (b === n[m]) { if (++m === n.length) return true; }
    else m = b === n[0] ? 1 : 0;
  }
}

// --- 1. snapshot meta (small; capture balanced braces) ---
if (!(await seek('"snapshot":'))) throw new Error("no snapshot section");
let depth = 0, metaStr = "", started = false;
for (;;) {
  const b = await nextByte();
  if (b < 0) throw new Error("eof in snapshot meta");
  const ch = String.fromCharCode(b);
  if (ch === "{") { depth++; started = true; }
  if (started) metaStr += ch;
  if (ch === "}") { depth--; if (depth === 0) break; }
}
const snapshot = JSON.parse(metaStr);
const nf = snapshot.meta.node_fields;
const typeNames = snapshot.meta.node_types[0];
const iType = nf.indexOf("type"), iName = nf.indexOf("name"), iSelf = nf.indexOf("self_size");
const FIELDS = nf.length;
const nodeCount = snapshot.node_count;

// --- 2. nodes: flat int array ---
if (!(await seek('"nodes":['))) throw new Error("no nodes section");
const agg = new Map();           // key `${type}\u0000${nameIdx}` -> {count, self}
const neededNames = new Set();
let field = 0, cur = 0, has = false;
let nType = 0, nName = 0, nSelf = 0, nodes = 0;

function endNumber() {
  if (field === iType) nType = cur;
  else if (field === iName) nName = cur;
  else if (field === iSelf) nSelf = cur;
  field++;
  if (field === FIELDS) {
    const key = nType + "\u0000" + nName;
    let e = agg.get(key);
    if (!e) { e = { count: 0, self: 0 }; agg.set(key, e); neededNames.add(nName); }
    e.count++; e.self += nSelf;
    field = 0; nodes++;
  }
  cur = 0; has = false;
}

outer: for (;;) {
  if (pos >= len) { if (!(await fill())) break; }
  while (pos < len) {
    const b = buf[pos++];
    if (b >= 48 && b <= 57) { cur = cur * 10 + (b - 48); has = true; }
    else if (b === 44) { endNumber(); }            // ,
    else if (b === 93) { if (has) endNumber(); break outer; }  // ]
  }
}

// --- 3. strings: keep only indices we need ---
if (!(await seek('"strings":['))) throw new Error("no strings section");
const names = new Map();
let sIdx = 0, inStr = false, esc = false, acc = null;
outer2: for (;;) {
  if (pos >= len) { if (!(await fill())) break; }
  while (pos < len) {
    const b = buf[pos++];
    if (inStr) {
      if (esc) { if (acc) acc.push(b); esc = false; continue; }
      if (b === 92) { if (acc) acc.push(b); esc = true; continue; }   // backslash
      if (b === 34) {                                                  // closing "
        if (acc) {
          try { names.set(sIdx, JSON.parse('"' + Buffer.from(acc).toString("utf8") + '"')); }
          catch { names.set(sIdx, Buffer.from(acc).toString("utf8")); }
        }
        inStr = false; acc = null; sIdx++; continue;
      }
      if (acc) acc.push(b);
    } else {
      if (b === 34) { inStr = true; acc = neededNames.has(sIdx) ? [] : null; }
      else if (b === 93) break outer2;
    }
  }
}
await fh.close();

const rows = [];
for (const [key, e] of agg) {
  const [t, n] = key.split("\u0000");
  const type = typeNames[+t] ?? ("type" + t);
  // SECURITY: redact BEFORE this row can be serialised. `|| "(anon)"` mirrors
  // report.mjs's own display default so a redacted summary and a raw one print
  // identically. See redact.mjs for why this must happen here and not there.
  rows.push({ type, name: redactName(type, names.get(+n) || "(anon)"), count: e.count, self: e.self });
}
console.log(JSON.stringify({
  file, fileSize: size, nodeCount, parsedNodes: nodes,
  totalSelf: rows.reduce((s, r) => s + r.self, 0),
  rows,
}));
