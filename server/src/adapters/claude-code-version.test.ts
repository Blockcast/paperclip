import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_EXACT_VERSION_RE,
  CLAUDE_CODE_RUNTIME_FROM_IMAGE,
  CLAUDE_CODE_VERSION_CONFIG_KEY,
  describeInadmissibleClaudeCodeVersion,
  findInadmissibleClaudeCodeVersion,
  isAdmissibleClaudeCodeVersion,
} from "./claude-code-version.js";
import { redactAgentConfigPayload, redactEventPayload } from "../redaction.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const RUNTIME_PIN_SOURCE = resolve(
  REPO_ROOT,
  "vendor/paperclip-adapter-claude-k8s/src/server/runtime-pin.ts",
);

/**
 * The corpus both grammars are compared over. Deliberately includes the shapes
 * that are legal npm and illegal here (range, dist-tag, `v` prefix), the shell
 * metacharacters the exactness exists to exclude, and the prerelease forms that
 * straddle `JWT_VALUE_RE`'s four-segment ceiling.
 */
const CORPUS = [
  "2.1.292", "2.1.322", "0.0.0", "10.20.30", "2026.1.1",
  "1.0.0-beta", "1.0.0-rc1", "1.0.0-beta.1", "1.0.0-beta.1.2", "1.0.0-alpha-3",
  "image", "", "   ",
  "latest", "next", "v2.1.292", "^2.1.0", "~2.1.0", ">=2.1.0", "2.x", "2.1",
  "2.1.292.1", "2.1.292 ", " 2.1.292", "2.1.292; rm -rf /", "2.1.292 && id",
  "2.1.292`id`", "2.1.292$(id)", "2.1.292|cat", "2.1.292\nid", "a.b.c", "-1.2.3",
  "1.0.0-", "1.0.0-beta_1", "01.02.03",
];

describe("the grammar mirrors the vendored adapter", () => {
  /**
   * `claude_k8s` is an external adapter — loaded from the bundled-adapters
   * directory at runtime, not a workspace dependency of `server/` — so this
   * package cannot import `resolveClaudeCodeVersion` and restates its grammar
   * instead. A restatement is a second copy, and a second copy is exactly as
   * complete as the less recently edited one. Deriving the adapter's side from
   * its SOURCE rather than retyping it is what stops this test going vacuous,
   * the same technique `model-validation.test.ts` uses for its model ids.
   */
  function parseVendoredExactVersionRe(): RegExp {
    const source = readFileSync(RUNTIME_PIN_SOURCE, "utf8");
    const match = /^const EXACT_VERSION_RE = \/(.+)\/;$/m.exec(source);
    // Pin the parse itself: a regex that silently matched nothing would make
    // every assertion below compare the server grammar against `undefined`.
    if (!match) throw new Error(`EXACT_VERSION_RE not found in ${RUNTIME_PIN_SOURCE}`);
    return new RegExp(match[1]);
  }

  function parseVendoredImageSentinel(): string {
    const source = readFileSync(RUNTIME_PIN_SOURCE, "utf8");
    const match = /^export const CLAUDE_CODE_RUNTIME_FROM_IMAGE = "([^"]+)";$/m.exec(source);
    if (!match) throw new Error(`CLAUDE_CODE_RUNTIME_FROM_IMAGE not found in ${RUNTIME_PIN_SOURCE}`);
    return match[1];
  }

  it("agrees with the adapter's EXACT_VERSION_RE on every corpus value", () => {
    const vendored = parseVendoredExactVersionRe();
    // Behavioural agreement, not literal equality: a reformatted but equivalent
    // regex upstream should not red this, and a narrowed or widened one must.
    const disagreements = CORPUS.filter(
      (value) => vendored.test(value) !== CLAUDE_CODE_EXACT_VERSION_RE.test(value),
    );
    expect(disagreements).toEqual([]);
    // The corpus has to exercise both verdicts, or agreement is trivial.
    expect(CORPUS.some((v) => vendored.test(v))).toBe(true);
    expect(CORPUS.some((v) => !vendored.test(v))).toBe(true);
  });

  it("agrees with the adapter's image sentinel", () => {
    expect(CLAUDE_CODE_RUNTIME_FROM_IMAGE).toBe(parseVendoredImageSentinel());
  });
});

describe("isAdmissibleClaudeCodeVersion", () => {
  it("admits the three shapes resolveClaudeCodeVersion accepts", () => {
    for (const value of ["2.1.322", "0.0.0", "1.0.0-beta.1", "image", "", "   "]) {
      expect(isAdmissibleClaudeCodeVersion(value), value).toBe(true);
    }
  });

  it("refuses every shape that would throw while building the Job manifest", () => {
    for (const value of ["latest", "v2.1.292", "^2.1.0", "2.1", "2.1.292; rm -rf /", "a.b.c"]) {
      expect(isAdmissibleClaudeCodeVersion(value), value).toBe(false);
    }
  });

  it("admits a non-string, because clearing the field stores null", () => {
    // The adapter coerces with `typeof raw === "string" ? raw.trim() : ""`, so
    // null/undefined take the default rather than throwing. Refusing them on
    // write would make the field impossible to clear.
    for (const value of [null, undefined, 42, {}]) {
      expect(isAdmissibleClaudeCodeVersion(value)).toBe(true);
    }
  });
});

describe("findInadmissibleClaudeCodeVersion", () => {
  const key = CLAUDE_CODE_VERSION_CONFIG_KEY;

  it("passes a config that does not carry the key", () => {
    expect(findInadmissibleClaudeCodeVersion({ model: "claude-opus-5" })).toBeNull();
  });

  it("refuses a malformed value this write introduces", () => {
    const finding = findInadmissibleClaudeCodeVersion({ [key]: "latest" });
    expect(finding).toEqual({ value: "latest" });
    expect(describeInadmissibleClaudeCodeVersion(finding!)).toContain("latest");
  });

  it("refuses a malformed value on a create, which passes no previous", () => {
    expect(findInadmissibleClaudeCodeVersion({ [key]: "^2.1.0" }, null)).toEqual({ value: "^2.1.0" });
  });

  it("tolerates an already-stored malformed value so the agent stays repairable", () => {
    // The PATCH path validates the EFFECTIVE config (stored shallow-merged with
    // the request), so without this the first bad value would refuse every
    // later adapterConfig write — including the one that repairs it.
    expect(
      findInadmissibleClaudeCodeVersion(
        { [key]: "latest", model: "claude-opus-5" },
        { adapterConfig: { [key]: "latest" } },
      ),
    ).toBeNull();
  });

  it("refuses a change from one malformed value to another", () => {
    expect(
      findInadmissibleClaudeCodeVersion({ [key]: "next" }, { adapterConfig: { [key]: "latest" } }),
    ).toEqual({ value: "next" });
  });

  it("admits a repair from a malformed stored value to an exact version", () => {
    expect(
      findInadmissibleClaudeCodeVersion({ [key]: "2.1.322" }, { adapterConfig: { [key]: "latest" } }),
    ).toBeNull();
  });
});

describe("read-back: an agent can verify the version it stored (PEN-6586)", () => {
  const key = CLAUDE_CODE_VERSION_CONFIG_KEY;
  const read = (config: Record<string, unknown>) =>
    (redactAgentConfigPayload(config) ?? {}) as Record<string, unknown>;

  it("reads back every exact version, which JWT_VALUE_RE used to mask", () => {
    for (const value of ["2.1.292", "2.1.322", "1.0.0-beta.1", "1.0.0-rc1", "0.0.0"]) {
      expect(read({ [key]: value })[key], value).toBe(value);
    }
  });

  it("reads back the image sentinel and a cleared field", () => {
    expect(read({ [key]: "image" })[key]).toBe("image");
    expect(read({ [key]: null })[key]).toBeNull();
  });

  it("still masks a JWT stored under the same key", () => {
    // The exemption is gated on the VALUE matching the admissible grammar, so
    // it cannot widen to anything secret-shaped. A JWT's first segment is
    // base64url of a JSON header and always begins `ey`; the grammar admits
    // only digits before the first dot.
    // Derived, never a literal: an embedded JWT is credential-shaped material
    // and the repo's egress scanner refuses the push rather than the value.
    // Deriving it also makes the POINT of the fixture explicit — the `ey`
    // prefix is base64url of `{"`, which is what the grammar cannot produce.
    const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const jwt = [b64u({ alg: "HS256" }), b64u({ sub: "1" }), "s".repeat(43)].join(".");
    expect(jwt.startsWith("ey")).toBe(true);
    expect(read({ [key]: jwt })[key]).toBe("***REDACTED***");
  });

  it("does not exempt the key outside an agent-config read", () => {
    // A generic event payload carrying the same key keeps the mask: the
    // capability this exemption buys is scoped to the agent-config surface.
    expect((redactEventPayload({ [key]: "2.1.292" }) ?? {})[key]).toBe("***REDACTED***");
  });

  it("leaves neighbouring keys exactly as they were", () => {
    const out = read({
      [key]: "2.1.322",
      model: "claude-opus-5",
      image: "harbor.example.net/agent:sha-abc123",
      apiKey: "value-shape-is-irrelevant-here",
      graceSec: 15,
    });
    expect(out.model).toBe("claude-opus-5");
    expect(out.image).toBe("harbor.example.net/agent:sha-abc123");
    expect(out.graceSec).toBe(15);
    // The control that keeps the three assertions above from being vacuous.
    expect(out.apiKey).toBe("***REDACTED***");
  });
});
