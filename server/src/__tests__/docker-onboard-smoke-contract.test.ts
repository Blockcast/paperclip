import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const smokeScript = readFileSync(path.join(repoRoot, "scripts/docker-onboard-smoke.sh"), "utf8");
const smokeWorkflow = readFileSync(
  path.join(repoRoot, ".github/workflows/release-smoke.yml"),
  "utf8",
);

describe("Docker onboard release smoke contract", () => {
  it("gives cold published-package installs a bounded readiness window", () => {
    expect(smokeScript).toContain(
      'SMOKE_READY_TIMEOUT_SECONDS="${SMOKE_READY_TIMEOUT_SECONDS:-300}"',
    );
    expect(smokeScript).toContain('--connect-timeout "$SMOKE_HTTP_TIMEOUT_SECONDS"');
    expect(smokeScript).toContain('--max-time "$SMOKE_HTTP_TIMEOUT_SECONDS"');
    expect(smokeScript).toContain(
      'wait_for_http "$PAPERCLIP_PUBLIC_URL/api/health" "$SMOKE_READY_TIMEOUT_SECONDS" 1',
    );
    expect(smokeScript).not.toContain(
      'wait_for_http "$PAPERCLIP_PUBLIC_URL/api/health" 90 1',
    );
  });

  it("preserves detached startup failures for workflow diagnostics and cleanup", () => {
    const containerRun = smokeScript.indexOf("docker run -d --rm");
    const metadataWrite = smokeScript.indexOf("\nwrite_metadata_file\n", containerRun);
    const preserveContainer = smokeScript.indexOf(
      'PRESERVE_CONTAINER_ON_EXIT="true"',
      metadataWrite,
    );
    const readinessProbe = smokeScript.indexOf(
      'wait_for_http "$PAPERCLIP_PUBLIC_URL/api/health" "$SMOKE_READY_TIMEOUT_SECONDS" 1',
    );

    expect(metadataWrite).toBeGreaterThan(containerRun);
    expect(preserveContainer).toBeGreaterThan(metadataWrite);
    expect(readinessProbe).toBeGreaterThan(preserveContainer);
    expect(smokeWorkflow).toContain('echo "SMOKE_METADATA_FILE=$metadata_file" >> "$GITHUB_ENV"');
    expect(smokeWorkflow.match(/source "\$SMOKE_METADATA_FILE"/g)).toHaveLength(2);
    expect(smokeWorkflow).toContain("--- npm debug log tail ---");
  });
});
