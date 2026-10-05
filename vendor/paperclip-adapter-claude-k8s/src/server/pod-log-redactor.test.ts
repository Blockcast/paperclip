// BLO-29553 AC1(b). Two jobs:
//
//   1. Keep the pod-side copy of the redaction rules in parity with the real
//      ones in `@paperclipai/adapter-utils/command-redaction`. Structurally (a
//      NEW rule cannot be forgotten) AND behaviourally (a REORDER is caught) —
//      because this ticket's whole history is rule ORDER, not rule presence.
//   2. Pin the fix itself: a composite `ghs_x.y.z` in claude's stream must not
//      reach the pod log, and the filter must actually be in the pipeline,
//      upstream of `tee`.
//
// Every token here is synthetic. The ticket's original verifying signal was
// withdrawn precisely because it required emitting a live credential into the
// store whose safety was in question.

import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { redactCommandText } from "@paperclipai/adapter-utils/command-redaction";

import {
  POD_LOG_REDACTOR_SCRIPT,
  POD_LOG_REDACTOR_FILENAME,
  POD_LOG_FILTER_VAR,
  buildPodLogRedactorSetupShell,
} from "./pod-log-redactor.js";

const COMMAND_REDACTION_SOURCE_PATH = fileURLToPath(
  new URL("../../../../packages/adapter-utils/src/command-redaction.ts", import.meta.url),
);

/** The embedded script is carried in a `String.raw` template, so it cannot hold
 *  a literal backtick; it writes them as `\x60`. Normalise before comparing. */
function normaliseBacktick(source: string): string {
  return source.replaceAll("`", String.raw`\x60`);
}

type PodRedactor = {
  redactText(text: string): string;
  redactLine(line: string): string;
};

let pod: PodRedactor;

beforeAll(async () => {
  // Load the EXACT bytes that get base64'd into the pod, not a re-implementation.
  const dir = mkdtempSync(path.join(tmpdir(), "blo29553-"));
  const file = path.join(dir, POD_LOG_REDACTOR_FILENAME);
  writeFileSync(file, POD_LOG_REDACTOR_SCRIPT, "utf8");
  pod = (await import(/* @vite-ignore */ `file://${file}`)) as PodRedactor;
});

// Vendor-prefixed fixtures are ASSEMBLED rather than written as literals.
// Every value here is synthetic, but GitHub push protection matches on SHAPE,
// not on provenance — `xoxb-<digits>-<digits>-<alnum>` was rejected as a "Slack
// API Token" and blocked the push. Splitting the prefix off keeps the literal
// un-matchable by a scanner while the assembled string still exercises the rule,
// which is the only thing the test needs.
const vendor = (prefix: string, body: string) => prefix + body;

// A synthetic composite in the shape `gh auth status` emits: a `ghs_` head with
// a dotted base64url payload and signature.
const HEAD = vendor("ghs", "_AAAABBBBCCCCDDDDEEEEFFFFGGGG1111");
const SEG = (n: number) => `c3ludGhldGljLXNlZ21lbnQtJHtufQ${n}`;
const SHORT_SEG = "ab3d";

function composite(segments: number, shortMiddle = false): string {
  const tail: string[] = [];
  for (let i = 1; i < segments; i++) {
    tail.push(shortMiddle && i === 1 ? SHORT_SEG : SEG(i));
  }
  return [HEAD, ...tail].join(".");
}

/** Every dotted run that is part of the token, so "no segment survived" is
 *  checkable rather than just "the head is gone". */
function tokenSegments(token: string): string[] {
  return token.split(".");
}

describe("pod-log-redactor: parity with command-redaction", () => {
  const source = readFileSync(COMMAND_REDACTION_SOURCE_PATH, "utf8");

  it("carries every regex literal declared in command-redaction.ts", () => {
    // Structural half. Matches `const NAME_RE = /.../flags;` and the
    // `new RegExp(` bodies are covered by the behavioural half below.
    const literals = [...source.matchAll(/^const (COMMAND_\w+_RE) =\s*\n?\s*(\/[\s\S]*?\/[gimsuy]*);$/gm)];
    // A control: if the extraction stops matching (the file is reformatted),
    // this is zero and every assertion below passes vacuously.
    expect(literals.length).toBeGreaterThanOrEqual(8);

    const script = POD_LOG_REDACTOR_SCRIPT;
    const missing = literals
      .filter(([, , literal]) => !script.includes(normaliseBacktick(literal)))
      .map(([, name]) => name);
    expect(missing).toEqual([]);
  });

  it("declares no rule the server does not have", () => {
    const podNames = [...POD_LOG_REDACTOR_SCRIPT.matchAll(/^const (COMMAND_\w+_RE)\b/gm)].map((m) => m[1]);
    const serverNames = [...source.matchAll(/^const (COMMAND_\w+_RE)\b/gm)].map((m) => m[1]);
    expect(podNames.length).toBeGreaterThan(0);
    expect([...podNames].sort()).toEqual([...serverNames].sort());
  });

  it("carries the secret-name pattern and every hint verbatim", () => {
    const namePattern = source.match(/const SECRET_NAME_PATTERN =\s*\n\s*String\.raw`([^`]*)`/);
    expect(namePattern).not.toBeNull();
    expect(POD_LOG_REDACTOR_SCRIPT).toContain(namePattern![1]);

    const hints = [...source.matchAll(/^\s{2}"([a-z_-]+)",$/gm)].map((m) => m[1]);
    expect(hints.length).toBeGreaterThanOrEqual(20);
    for (const hint of hints) expect(POD_LOG_REDACTOR_SCRIPT).toContain(`"${hint}"`);
  });
});

describe("pod-log-redactor: behavioural parity on raw text", () => {
  // Shared corpus, run through BOTH implementations. This is what catches a
  // reorder — the regexes can all be present and still leak if the two GitHub
  // rules fall behind JWT, or if the OpenAI rule rises above it.
  const corpus: string[] = [
    ...[2, 3, 4, 5, 6].map((n) => composite(n)),
    ...[3, 4, 5].map((n) => composite(n, true)),
    ...[2, 3, 5].flatMap((n) => [
      `ctx.one ${composite(n)}`,
      `${composite(n)} trailing.ctx`,
      `a.b ${composite(n)} c.d`,
    ]),
    `${vendor("github", "_pat_AAAABBBBCCCCDDDDEEEEFFFF1111")}.${SEG(1)}.${SEG(2)}`,
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
    `--api-key ${vendor("sk", "-AAAABBBBCCCCDDDDEEEE1111")}`,
    `GITHUB_TOKEN=${HEAD}`,
    vendor("AKIA", "IOSFODNN7EXAMPLE"),
    vendor("xox", "b-1111111111-2222222222-abcdefghijklmnop"),
    vendor("AIza", "SyAAAABBBBCCCCDDDDEEEEFFFFGGGG1111"),
    // Benign controls that must survive byte-identical. These are dotted, so
    // they reach the value-shape rules rather than short-circuiting the hint
    // prefilter — which is the gap the AC called out in the AC1(a) suite.
    "service.platform.retries.maxAttempts",
    "example.com/path/to/thing",
    "#!/usr/bin/env bash",
    "src/server/pod-log-redactor.test.ts",
    "node_modules/.vite/deps/chunk-ABCDEFGH.js",
  ];

  it.each(corpus)("matches redactCommandText byte-for-byte: %s", (input) => {
    expect(pod.redactText(input)).toBe(redactCommandText(input));
  });
});

describe("pod-log-redactor: no composite token segment reaches the pod log", () => {
  const shapes: [string, string][] = [
    ...[2, 3, 4, 5, 6].map((n) => [`${n} segments`, composite(n)] as [string, string]),
    ...[3, 4, 5].map((n) => [`${n} segments, short middle`, composite(n, true)] as [string, string]),
  ];

  it.each(shapes)("raw line — %s", (_label, token) => {
    const out = pod.redactLine(`tool output: ${token} end`);
    for (const seg of tokenSegments(token)) expect(out).not.toContain(seg);
  });

  it.each(shapes)("stream-json line — %s", (_label, token) => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: `token ${token} here` }] },
    });
    const out = pod.redactLine(line);
    for (const seg of tokenSegments(token)) expect(out).not.toContain(seg);
    // The server PARSES this stream. A redaction that breaks the line would
    // turn this fix into a run-failure bug.
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it.each(shapes)("stream-json line with 0-2 context segments either side — %s", (_label, token) => {
    const line = JSON.stringify({ type: "user", text: `a.b ${token} c.d` });
    const out = pod.redactLine(line);
    for (const seg of tokenSegments(token)) expect(out).not.toContain(seg);
    expect(JSON.parse(out).text).toContain("a.b");
  });

  it("leaves a non-secret stream-json line byte-identical", () => {
    const line = JSON.stringify({ type: "result", subtype: "success", is_error: false });
    expect(pod.redactLine(line)).toBe(line);
  });

  // Pins the one ordering constraint the gh-composite fixtures above CANNOT
  // catch: COMMAND_OPENAI_KEY_RE is prefix-anchored and not self-sufficient, so
  // ahead of JWT it replaces only `sk-<body>` and strands the dotted tail —
  // the original 2-of-3-segments leak, in the other vendor's shape. Verified by
  // mutation: swapping those two lines leaves
  // `***REDACTED***.c3ludGhldGljLXBheWxvYWQ.c3ludGhldGljLXNpZ25hdHVyZQ`.
  it("redacts a dotted sk- composite whole (OpenAI rule must FOLLOW JWT)", () => {
    const token = `${vendor("sk", "-AAAABBBBCCCCDDDD")}.${SEG(1)}.${SEG(2)}`;
    const out = pod.redactLine(`key ${token} end`);
    for (const seg of tokenSegments(token)) expect(out).not.toContain(seg);
  });

  // Pins the JSON branch. Raw-text redaction on this line is still VALID JSON,
  // so a validity assertion cannot catch it — `COMMAND_PEM_PRIVATE_KEY_RE`'s
  // lazy `[\s\S]*?` spans the `","b":"` structure and the whole `b` field
  // disappears. The server parses this stream for `is_error`/`session_id`/
  // `result`, so silently dropping a sibling field is a run-outcome bug.
  it("does not drop a sibling field when a match would span JSON structure", () => {
    const line =
      '{"a":"-----BEGIN PRIVATE KEY-----","b":"MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ -----END PRIVATE KEY-----"}';
    const parsed = JSON.parse(pod.redactLine(line));
    expect(Object.keys(parsed)).toEqual(["a", "b"]);
    expect(parsed.a).toBe("***REDACTED***");
    // Honest limit, asserted so it is a known shape rather than a surprise:
    // per-value redaction cannot see material split ACROSS two string values,
    // so `b`'s orphaned footer survives. A PEM in a real stream-json event sits
    // in one value; the alternative (raw redaction) loses the field entirely.
    expect(parsed.b).toContain("-----END PRIVATE KEY-----");
  });

  it("does not disturb the terminal rate-limit event the awk filter keys on", () => {
    // failFastFilter greps the raw line for these two strings. If redaction
    // rewrote them the pod would hang on a terminal quota event again.
    const line = JSON.stringify({
      type: "rate_limit_event",
      overageStatus: "rejected",
      overageDisabledReason: "out_of_credits",
    });
    const out = pod.redactLine(line);
    expect(out).toContain('"overageStatus":"rejected"');
    expect(out).toContain('"overageDisabledReason":"out_of_credits"');
  });
});

describe("pod-log-redactor: shell wiring", () => {
  it("installs write-once and never truncates the shared inode", () => {
    const shell = buildPodLogRedactorSetupShell();
    // `[ -f ] ||` + tmp + `mv -f`: the CephFS truncate-wedge invariant.
    expect(shell).toContain(`[ -f "$GUARD_DIR/${POD_LOG_REDACTOR_FILENAME}" ] ||`);
    expect(shell).toContain("mv -f");
    expect(shell).not.toMatch(/>\s*"\$GUARD_DIR\/paperclip-pod-log-redactor\.[0-9a-f]+\.mjs"/);
  });

  it("falls open to cat when the script is not on disk", () => {
    const shell = buildPodLogRedactorSetupShell();
    expect(shell).toContain(`${POD_LOG_FILTER_VAR}=cat`);
    const guarded = shell.indexOf(`[ -f "$GUARD_DIR/${POD_LOG_REDACTOR_FILENAME}" ] && ${POD_LOG_FILTER_VAR}=`);
    expect(guarded).toBeGreaterThan(shell.indexOf(`${POD_LOG_FILTER_VAR}=cat`));
  });

  it("content-addresses the filename so a rule change lands as a new file", () => {
    expect(POD_LOG_REDACTOR_FILENAME).toMatch(/^paperclip-pod-log-redactor\.[0-9a-f]{12}\.mjs$/);
  });
});
