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
