// Single redaction contract for the heap tooling.
//
// In a .heapsnapshot a string node's "name" IS its contents, so the file holds
// the worker's secrets in plaintext. Every tool here must pass a node name
// through redactName() before it reaches a terminal, a log, or — the hole this
// module exists to close — a DERIVED FILE ON DISK.
//
// PEN-3631: the original summarize.mjs applied the contract at report time
// only, so its summary.json held every string payload verbatim. Those summaries
// live outside ../heap/ and so are not covered by the worker's retention sweep:
// they outlived the snapshots they came from. Measured on one 30MB summary:
// 45 ES256/HS256 JWTs and 3 postgres DSNs carrying userinfo. Redaction belongs
// at the WRITE, not at the read.
import { createHash } from "node:crypto";

export const STRING_KEEP_MAX = 256;
export const h8 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 8);
export const STRINGY = new Set(["string", "concatenated string", "sliced string"]);

// Shape emitted below. Matching it makes redactName idempotent, which is what
// lets report.mjs read a raw summary and a redacted one and print the same
// bytes — the positive control that the redaction changed nothing but exposure.
const REDACTED =
  /^<(?:string|concatenated string|sliced string|redacted), \d+ch, #[0-9a-f]{8}>$/;

export const isRedacted = (n) => typeof n === "string" && REDACTED.test(n);

export function redactName(type, name) {
  const n = name ?? "";
  if (isRedacted(n)) return n;
  if (STRINGY.has(type)) return `<${type}, ${n.length}ch, #${h8(n)}>`;
  // A constructor/edge name is a program identifier and is kept: it is what
  // makes a path legible. An over-long one is the shape a payload arrives in.
  if (n.length > STRING_KEEP_MAX) return `<redacted, ${n.length}ch, #${h8(n)}>`;
  return n;
}

// An EDGE name is not reliably a program identifier, and that is the hole this
// closes. On a dictionary-mode object a `property` edge's name IS the key
// string, so a DSN or a token used as a plain-object key prints verbatim under
// redactName() — it is under STRING_KEEP_MAX and is not a `string` NODE, so
// neither arm fires. The measured postgres URIs were 19–58 chars; they would
// have fit. `context` edges (closure variable names) are the same shape and are
// treated the same way.
//
// The test is deliberately narrow: an optional `#` private-field marker and
// then a JS identifier. A rejected name may well be a legitimate string key
// ("content-type"), but nothing here can tell that from a credential, and the
// hash keeps distinct paths distinct either way — legibility is the thing being
// spent, not correctness.
//
// Apply it only to `property`/`context`. Every other edge type names a V8 slot
// ("internal source", "bindings"), which is program-independent, fails this
// test, and is what makes a retainer path readable.
const IDENTIFIER_SHAPE = /^#?[A-Za-z_$][A-Za-z0-9_$]*$/;

export function redactEdgeName(name) {
  const n = name ?? "";
  if (isRedacted(n)) return n;
  if (n.length <= STRING_KEEP_MAX && IDENTIFIER_SHAPE.test(n)) return n;
  return `<redacted, ${n.length}ch, #${h8(n)}>`;
}
