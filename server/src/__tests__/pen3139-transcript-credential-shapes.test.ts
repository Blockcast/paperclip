import { CREDENTIAL_VALUE_RES } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { sanitizeRunLogChunkForStorage } from "../services/heartbeat.js";

/**
 * PEN-3139 — run-log transcripts retained vendor credential shapes that the
 * free-text scrub missed.
 *
 * Every fixture below is INVENTED. None is a real credential, and none was
 * copied out of a transcript, a log, or a cluster.
 *
 * Why the existing `heartbeat-run-log.test.ts` fixtures did not catch this:
 * each of them pairs its secret with a secret-*named* carrier
 * (`PAPERCLIP_API_KEY=`, `"refresh_token":`, `--paperclip-api-key=`,
 * `Authorization: Bearer`). The scrub is overwhelmingly name-anchored, so those
 * fixtures exercise the name patterns and assert the pass-through as correct —
 * the same near-miss the PEN-2747 note in `redaction.ts` describes. The carrier
 * that actually leaks is a bare value in prose, which is what an adapter
 * tool-result summary looks like.
 */

const REDACTED = "***REDACTED***";

/** Redaction of the current OS user is a separate control; disable it so these assertions isolate the credential scrub. */
const NO_CURRENT_USER_REDACTION = { enabled: false } as const;

type Shape = {
  readonly label: string;
  /** Invented value carrying the vendor's shape. */
  readonly value: string;
  /**
   * The substring that must not survive. Defaults to `value`. The PEM fixture
   * overrides it: carriers that JSON-escape the value rewrite its newlines, so
   * asserting on the raw multi-line string would pass vacuously while the key
   * body sat in the output untouched.
   */
  readonly probe?: string;
};

const PEM_BODY = "MIIEEXAMPLEfakebody0000000000000000";

const VENDOR_SHAPES: readonly Shape[] = [
  { label: "AWS access key id (AKIA)", value: "AKIAZZZZ0000EXAMPLE9" },
  { label: "AWS STS session key id (ASIA)", value: "ASIAZZZZ0000EXAMPLE9" },
  { label: "Google API key (AIza)", value: "AIzaSyEXAMPLE0000000000000000000000000" },
  {
    label: "Slack bot token (xoxb)",
    // Deliberately NOT Slack's canonical `xoxb-<digits>-<digits>-<alnum>`
    // layout: GitHub push protection matches that structure and rejected the
    // push outright (Slack API Token, this file). Requesting an unblock would
    // file a bypass for a fixture, so the fixture changed instead.
    //
    // This costs the test nothing. `COMMAND_SLACK_TOKEN_RE` keys on the
    // `xox[baprs]-` prefix plus length, not on the digit grouping, so this
    // value exercises exactly the same branch. It is a weaker *visual* likeness
    // of a real Slack token and an identical *discriminator* for the rule under
    // test — and it still contains none of the hint words, so it also keeps
    // proving the prefilter admits on the `xox` hint alone.
    value: "xoxb-EXAMPLE-NOT-REAL-FIXTURE-0000",
  },
  {
    label: "GitHub fine-grained PAT (github_pat_)",
    value: "github_pat_00EXAMPLE0000000000_0000000000000000000000000000EXAMPLE",
  },
  { label: "OpenAI key (sk-)", value: "sk-EXAMPLE0000000000000000000000" },
  { label: "GitHub classic token (ghp_)", value: "ghp_EXAMPLE00000000000000000000000000" },
  {
    label: "JWT",
    value: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJFWEFNUExFIn0.EXAMPLEEXAMPLEsignature",
  },
  {
    label: "PEM private key block",
    value: `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----`,
    probe: PEM_BODY,
  },
];

const probeOf = (shape: Shape) => shape.probe ?? shape.value;

/**
 * Carriers are the shapes a run-log chunk actually takes. None of them puts a
 * secret-shaped *name* next to the value — that is the whole point.
 */
const CARRIERS: ReadonlyArray<{ label: string; build: (value: string) => string }> = [
  {
    // The periodless case. `redactSensitiveText` and `redactCommandText` both
    // short-circuit on a hint gate whose broadest term is `includes(".")`, so a
    // line with no period reaches the matchers only if a hint names the shape.
    // This carrier is what proves BOTH gates admit, not just the pattern list.
    label: "bare in prose, no period",
    build: (value) => `tool result: the configured value is ${value} and that is all`,
  },
  {
    label: "bare in prose, with a period",
    build: (value) => `tool result: the cluster is reachable. the value is ${value} here`,
  },
  {
    // Shape of what the acpx engine forwards: `"<title> (<status>): <summary>"`.
    label: "acpx tool-call summary envelope",
    build: (value) => `Read (completed): file contents were ${value} truncated`,
  },
  {
    // A non-secret-shaped JSON key. The JSON patterns key off the *field name*,
    // so an innocuous name passes the value straight through.
    label: "JSON under a non-secret key",
    build: (value) => `{"detail":"${value.replaceAll("\n", "\\n")}"}`,
  },
];

describe("PEN-3139: run-log storage sanitizer masks vendor credential shapes with no secret-shaped name", () => {
  for (const shape of VENDOR_SHAPES) {
    for (const carrier of CARRIERS) {
      it(`masks ${shape.label} — ${carrier.label}`, () => {
        const chunk = carrier.build(shape.value);
        const probe = probeOf(shape);
        // Guard against a vacuous assertion: the carrier must actually still
        // contain the probe before sanitizing, or `not.toContain` proves nothing.
        expect(chunk).toContain(probe);

        const sanitized = sanitizeRunLogChunkForStorage(chunk, NO_CURRENT_USER_REDACTION);

        expect(sanitized).not.toContain(probe);
        expect(sanitized).toContain(REDACTED);
      });
    }
  }

  it("masks the PEM body when the chunk is truncated before the -----END----- footer", () => {
    // `compactRunLogChunk` truncates, so a key body genuinely can be split
    // mid-block. A footer-requiring pattern would pass this leading half through.
    const body = "MIIEEXAMPLEfakebody0000000000000000";
    const chunk = `-----BEGIN RSA PRIVATE KEY-----\n${body}`;

    const sanitized = sanitizeRunLogChunkForStorage(chunk, NO_CURRENT_USER_REDACTION);

    expect(sanitized).not.toContain(body);
  });
});

describe("PEN-3139: free-text scrub stays in step with the shared whole-value shape list", () => {
  /**
   * The repo owns three credential-shape lists. `CREDENTIAL_VALUE_RES` is the
   * longest; the free-text list in `command-redaction.ts` was the shortest, and
   * that gap is this finding. Nothing structural keeps them together, so this
   * test does: every shape the shared list recognizes must have a fixture here,
   * and that fixture must be masked on the run-log path.
   *
   * Adding a regex to `CREDENTIAL_VALUE_RES` with no matching fixture fails
   * with the index of the uncovered pattern.
   */
  it("has a fixture for every shape in CREDENTIAL_VALUE_RES, and masks each one", () => {
    const uncovered: string[] = [];

    for (const [index, re] of CREDENTIAL_VALUE_RES.entries()) {
      const matching = VENDOR_SHAPES.filter((shape) => re.test(shape.value.trim()));
      if (matching.length === 0) {
        uncovered.push(`#${index} ${re.source}`);
        continue;
      }
      for (const shape of matching) {
        const chunk = `tool result: the configured value is ${shape.value} and that is all`;
        expect(
          sanitizeRunLogChunkForStorage(chunk, NO_CURRENT_USER_REDACTION),
          `${shape.label} matches CREDENTIAL_VALUE_RES #${index} but survives the run-log scrub`,
        ).not.toContain(probeOf(shape));
      }
    }

    expect(
      uncovered,
      "CREDENTIAL_VALUE_RES gained a shape with no fixture here. Add the fixture AND an unanchored "
        + "counterpart to command-redaction.ts — a shape in the shared list but not the free-text list "
        + "is exactly the PEN-3139 defect.",
    ).toEqual([]);
  });
});

describe("PEN-3139: widening the free-text scrub does not blank benign identifiers", () => {
  // The #943 review removed length-only redaction from `redaction.ts` because
  // it blanked evidence identifiers. Named shapes must not reintroduce that.
  const BENIGN: ReadonlyArray<[string, string]> = [
    ["a 40-char commit SHA", "9f2b1c4d5e6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c"],
    ["a canonical UUID", "3f8a1e2b-4c5d-6e7f-8a9b-0c1d2e3f4a5b"],
    ["a status slug", "pending_human_merge_review"],
    ["an ordinary sentence", "the pod is Running and the probe returned 200"],
  ];

  for (const [label, value] of BENIGN) {
    it(`leaves ${label} intact`, () => {
      const chunk = `tool result: the cluster is reachable. the value is ${value} here`;

      const sanitized = sanitizeRunLogChunkForStorage(chunk, NO_CURRENT_USER_REDACTION);

      expect(sanitized).toContain(value);
    });
  }
});
