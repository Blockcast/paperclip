// PEN-3631. The defect this pins was NOT in the redaction helper — that helper
// was correct from the first commit. It was that summarize.mjs never called it:
// redaction ran at display time, so every string payload went to disk verbatim
// and outlived the snapshot it came from. A unit test of redactName() passes
// happily against that defect.
//
// So the load-bearing test here is `summarize.mjs does not write a string
// payload to its output`, which drives the real binary over a real (tiny)
// snapshot and greps the bytes it produced. The helper tests below it are
// supporting detail.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { redactName, isRedacted, STRING_KEEP_MAX } from "./redact.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// Assembled, never a literal: a pasteable credential-shaped constant would trip
// the repo's own secret scan on this file. The marker only has to be unique and
// absent from the rest of the output — redaction of a string node does not
// depend on the payload looking like a secret.
const PLANTED = `planted-payload-${"z".repeat(48)}-${"4".repeat(12)}`;

// Minimal but format-real .heapsnapshot: two nodes, one `string` carrying the
// planted payload as its name (which is what a string node's name IS), one
// `object` whose name is an ordinary program identifier that must survive.
function writeFixture(dir) {
  const nodeTypes = [
    "hidden", "array", "string", "object", "code", "closure", "regexp",
    "number", "native", "synthetic", "concatenated string", "sliced string",
    "symbol", "bigint", "object shape",
  ];
  const snapshot = {
    snapshot: {
      meta: {
        node_fields: ["type", "name", "id", "self_size", "edge_count", "trace_node_id", "detachedness"],
        node_types: [nodeTypes, "string", "number", "number", "number", "number", "number"],
        edge_fields: ["type", "name_or_index", "to_node"],
        edge_types: [["context", "element", "property", "internal", "hidden", "shortcut", "weak"], "string_or_number", "node"],
      },
      node_count: 2,
      edge_count: 0,
      trace_function_count: 0,
    },
    // string node -> strings[1] (the payload); object node -> strings[2]
    nodes: [2, 1, 1, 100, 0, 0, 0, 3, 2, 2, 50, 0, 0, 0],
    edges: [],
    strings: ["", PLANTED, "MyClass"],
  };
  const file = join(dir, "fixture.heapsnapshot");
  writeFileSync(file, JSON.stringify(snapshot));
  return file;
}

test("summarize.mjs does not write a string payload to its output", () => {
  const dir = mkdtempSync(join(tmpdir(), "heap-redact-"));
  try {
    const fixture = writeFixture(dir);
    const out = execFileSync(process.execPath, [join(here, "summarize.mjs"), fixture], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });

    // The whole point. Grep the bytes, not the parsed object: a payload that
    // leaks through an unexpected field would still be on disk.
    assert.ok(
      !out.includes(PLANTED),
      "summarize.mjs wrote a string node's payload verbatim — redaction is not being applied at the write",
    );

    const parsed = JSON.parse(out);
    assert.equal(parsed.parsedNodes, 2, "fixture should parse as 2 nodes");
    assert.equal(parsed.nodeCount, 2);
    assert.equal(parsed.totalSelf, 150);

    const str = parsed.rows.find((r) => r.type === "string");
    assert.ok(str, "expected a string row");
    assert.ok(isRedacted(str.name), `string row name not redacted: ${str.name}`);
    assert.match(str.name, new RegExp(`^<string, ${PLANTED.length}ch, #[0-9a-f]{8}>$`));

    // A constructor name is a program identifier and must survive, or every
    // report becomes unreadable and the tooling is worthless.
    const obj = parsed.rows.find((r) => r.type === "object");
    assert.equal(obj.name, "MyClass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report.mjs prints the same bytes for a redacted summary and a raw one", () => {
  // Idempotence is what makes that true, and it is what lets report.mjs keep
  // working on summaries written before this fix without double-wrapping them.
  const raw = { file: "x", fileSize: 1, nodeCount: 1, parsedNodes: 1, totalSelf: 100,
    rows: [{ type: "string", name: PLANTED, count: 1, self: 100 }] };
  const red = { ...raw, rows: [{ ...raw.rows[0], name: redactName("string", PLANTED) }] };

  const dir = mkdtempSync(join(tmpdir(), "heap-report-"));
  try {
    const a = join(dir, "raw.json"), b = join(dir, "red.json");
    writeFileSync(a, JSON.stringify(raw));
    writeFileSync(b, JSON.stringify(red));
    const run = (p) => execFileSync(process.execPath, [join(here, "report.mjs"), p], { encoding: "utf8" });
    const outA = run(a), outB = run(b);
    assert.equal(outA, outB, "report output diverges between a raw and a redacted summary");
    assert.ok(!outA.includes(PLANTED), "report.mjs printed a payload");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("redactName is idempotent and keeps program identifiers", () => {
  const once = redactName("string", PLANTED);
  assert.equal(redactName("string", once), once, "applying it twice must not re-wrap");
  assert.ok(isRedacted(once));

  assert.equal(redactName("object", "MyClass"), "MyClass");
  assert.equal(redactName("closure", "native_bind"), "native_bind");

  for (const t of ["string", "concatenated string", "sliced string"]) {
    assert.ok(isRedacted(redactName(t, "short")), `${t} must always be redacted, even when short`);
  }

  // An over-long "identifier" is the shape a payload arrives in.
  const longIdent = "n".repeat(STRING_KEEP_MAX + 1);
  assert.ok(isRedacted(redactName("object", longIdent)));
  assert.equal(redactName("object", "n".repeat(STRING_KEEP_MAX)), "n".repeat(STRING_KEEP_MAX));

  assert.equal(redactName("object", null), "");
  assert.ok(isRedacted(redactName("string", "")));
});
