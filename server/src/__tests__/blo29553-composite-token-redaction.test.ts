/**
 * BLO-29553: `gh auth status` printed a GitHub App installation token into a
 * persisted run transcript even though value-shaped matchers for both `ghs_`
 * and JWT had existed since 2026-04-30 and the transcript write path already
 * runs every chunk through them.
 *
 * The matchers were not absent -- they were mutually destructive. The token
 * `gh` emits is a COMPOSITE, `ghs_<seg>.<b64url>.<b64url>`. Applying the
 * prefix rule first replaced only the `ghs_` head with `***REDACTED***`, and
 * because `*` is outside `[A-Za-z0-9_-]` that replacement destroyed the
 * three-segment structure the JWT rule matches on. The payload and signature
 * were then persisted verbatim: 2 of 3 segments surviving.
 *
 * These cases pin the ordering invariant (widest value shape first) and the
 * `github_pat_` gap found alongside it. A rule that redacts a PREFIX of
 * another rule's match must never run before it.
 *
 * Every credential-shaped value in this file is synthetic and has never been
 * live. Do not paste real values into fixtures.
 */
import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../redaction.js";
import { compactRunLogChunk } from "../services/heartbeat.js";

const HEAD = "ghs_NOTAREALTOKEN0123456789abcdef";
const PAYLOAD = "eyJOT1RBUkVBTFBBWUxPQUQiOjF9";
const SIGNATURE = "NOTAREALSIGNATURE0123456789abcdefXYZ";
/** The real emitted shape: a `ghs_` head with JWT-like dotted segments. */
const COMPOSITE = `${HEAD}.${PAYLOAD}.${SIGNATURE}`;
const PLAIN_GHS = "ghs_NOTAREALPLAINTOKEN0123456789abcd";
const FINE_GRAINED_PAT =
  "github_pat_11NOTAREAL0abcdefghijklmn_NOTAREALSECRETPART0123456789abcdefghij";

/** `gh auth status` output, as the harness actually renders it. */
const GH_AUTH_STATUS = [
  "github.com",
  "  ✓ Logged in to github.com account allyblockcast[bot] (GH_TOKEN)",
  "  - Active account: true",
  "  - Git operations protocol: https",
  `  - Token: ${COMPOSITE}`,
  "  - Token scopes: 'repo', 'workflow'",
].join("\n");

describe("BLO-29553: composite token redaction", () => {
  it("leaves no segment of a composite gh token in redacted text", () => {
    const out = redactSensitiveText(`  - Token: ${COMPOSITE}`);
    // The pre-fix behaviour redacted the head and kept these two.
    for (const [label, segment] of [
      ["head", HEAD],
      ["payload", PAYLOAD],
      ["signature", SIGNATURE],
    ] as const) {
      expect(out, `${label} segment must not survive redaction`).not.toContain(segment);
    }
    expect(out).not.toContain(COMPOSITE);
  });

  it("redacts the composite token in full gh auth status output", () => {
    const out = redactSensitiveText(GH_AUTH_STATUS);
    expect(out).not.toContain(PAYLOAD);
    expect(out).not.toContain(SIGNATURE);
    // Surrounding diagnostic structure is preserved -- this is a value-shaped
    // rule, not a line-blanking one.
    expect(out).toContain("Logged in to github.com account");
    expect(out).toContain("Token scopes");
  });

  it("redacts the composite token on the persisted transcript write path", () => {
    // compactRunLogChunk is the function every stdout/stderr chunk passes
    // through before runLogStore.append(), so this is the end-to-end guarantee
    // rather than a unit assertion about a regex.
    const out = compactRunLogChunk(GH_AUTH_STATUS);
    expect(out).not.toContain(PAYLOAD);
    expect(out).not.toContain(SIGNATURE);
    expect(out).not.toContain(HEAD);
  });

  it("still redacts a plain non-composite gh token (no reorder regression)", () => {
    const out = redactSensitiveText(`  - Token: ${PLAIN_GHS}`);
    expect(out).not.toContain(PLAIN_GHS);
    expect(out).toContain("***REDACTED***");
  });

  it("redacts a bare fine-grained PAT with no hint word and no dot", () => {
    // The prefilter short-circuits on text carrying no hint, no `://` and no
    // `.`, so this case needs both the hint entry and the rule.
    const out = redactSensitiveText(FINE_GRAINED_PAT);
    expect(out).not.toContain(FINE_GRAINED_PAT);
  });

  it("does not redact benign text that merely resembles a secret", () => {
    for (const benign of [
      "#!/usr/bin/env bash\necho hi",
      "see https://example.com:8080/path for detail",
      "git rev-parse HEAD^{tree}",
    ]) {
      expect(redactSensitiveText(benign), `must not alter: ${benign}`).toBe(benign);
    }
  });
});
