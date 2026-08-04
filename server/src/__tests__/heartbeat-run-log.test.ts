import { describe, expect, it } from "vitest";
import { compactRunLogChunk, isSyntheticNonProgressRunLogChunk, sanitizeRunLogChunkForStorage } from "../services/heartbeat.js";

describe("compactRunLogChunk", () => {
  it("redacts inline base64 image data from structured log chunks", () => {
    const base64 = "A".repeat(4096);
    const chunk = `{"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","data":"${base64}"}}]}}\n`;

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).not.toContain(base64);
    expect(compacted).toContain("[omitted base64 image data: 4096 chars]");
  });

  it("truncates oversized chunks after sanitizing them", () => {
    const chunk = `${"x".repeat(90_000)}tail`;

    const compacted = compactRunLogChunk(chunk, 16_384);

    expect(compacted.length).toBeLessThan(chunk.length);
    expect(compacted).toContain("[paperclip truncated run log chunk:");
    expect(compacted.endsWith("tail")).toBe(true);
  });

  it("redacts Paperclip credential shapes before persisting run-log chunks", () => {
    const chunk = [
      "Authorization: Bearer live-bearer-token-value",
      `export PAPERCLIP_API_KEY='paperclip-shell-secret'`,
      `auth {"refresh_token":"refresh-token-fixture-secret"}`,
      `payload {"PAPERCLIP_API_KEY":"paperclip-json-secret"}`,
      "--paperclip-api-key=paperclip-flag-secret",
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toContain("***REDACTED***");
    expect(compacted).not.toContain("live-bearer-token-value");
    expect(compacted).not.toContain("paperclip-shell-secret");
    expect(compacted).not.toContain("refresh-token-fixture-secret");
    expect(compacted).not.toContain("paperclip-json-secret");
    expect(compacted).not.toContain("paperclip-flag-secret");
  });

  it("redacts synthetic secret-prefixed environment values from dump-like chunks", () => {
    const fakeSecret = "fake-pen1305-secret-value";
    const chunk = [
      "PATH=/usr/local/bin:/usr/bin",
      `PAPERCLIP_TEST_SECRET=${fakeSecret}`,
      "SAFE_ENV_NAME=visible",
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toContain("PAPERCLIP_TEST_SECRET=***REDACTED***");
    expect(compacted).not.toContain(fakeSecret);
    expect(compacted).toContain("SAFE_ENV_NAME=visible");
  });

  it("redacts declare/export and nul-delimited env dumps before persisting run-log chunks", () => {
    const declareSecret = "fake-pen1305-declare-secret";
    const exportSecret = "fake-pen1305-export-secret";
    const procSecret = "fake-pen1305-proc-secret";
    const chunk = [
      `declare -x PAPERCLIP_API_KEY="${declareSecret}"`,
      `export PAPERCLIP_ACCESS_TOKEN='${exportSecret}'`,
      `PATH=/usr/bin\0PAPERCLIP_PRIVATE_KEY=${procSecret}\0SAFE_ENV_NAME=visible`,
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toContain('declare -x PAPERCLIP_API_KEY="***REDACTED***"');
    expect(compacted).toContain("export PAPERCLIP_ACCESS_TOKEN='***REDACTED***'");
    expect(compacted).toContain("PAPERCLIP_PRIVATE_KEY=***REDACTED***");
    expect(compacted).not.toContain(declareSecret);
    expect(compacted).not.toContain(exportSecret);
    expect(compacted).not.toContain(procSecret);
    expect(compacted).toContain("SAFE_ENV_NAME=visible");
  });

  it("sanitizes secret-prefixed environment values before the run-log store append path", () => {
    const fakeSecret = "fake-pen1305-store-secret";
    const sanitized = sanitizeRunLogChunkForStorage(
      `PAPERCLIP_SYNTHETIC_TOKEN=${fakeSecret}\nSAFE_ENV_NAME=visible\n`,
      { enabled: false },
    );

    expect(sanitized).toContain("PAPERCLIP_SYNTHETIC_TOKEN=***REDACTED***");
    expect(sanitized).not.toContain(fakeSecret);
    expect(sanitized).toContain("SAFE_ENV_NAME=visible");
  });
});

describe("isSyntheticNonProgressRunLogChunk", () => {
  it("recognizes Paperclip k8s keepalive chunks", () => {
    expect(
      isSyntheticNonProgressRunLogChunk(
        "[paperclip] keepalive — job ac-agent-123 running (713s since last output)\n",
      ),
    ).toBe(true);
  });

  it.each([
    "[paperclip] Reattaching to orphaned Job agent-opencode-123\n",
    "[paperclip] Reattached to existing run run-123.\n",
  ])("recognizes external-runtime reattach output as synthetic", (chunk) => {
    expect(isSyntheticNonProgressRunLogChunk(chunk)).toBe(true);
  });

  it("does not classify real output as synthetic keepalive", () => {
    expect(isSyntheticNonProgressRunLogChunk("[paperclip] Starting workspace restore\n")).toBe(false);
    expect(
      isSyntheticNonProgressRunLogChunk(
        "[paperclip] keepalive — job ac-agent-123 running (713s since last output)\nreal output\n",
      ),
    ).toBe(false);
  });
});
