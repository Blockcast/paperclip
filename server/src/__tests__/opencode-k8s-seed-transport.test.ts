import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const statefulSet = readFileSync(
  path.join(repoRoot, "deploy/helm/paperclip/templates/statefulset.yaml"),
  "utf8",
);

describe("opencode_k8s shared MCP seed", () => {
  it("uses Streamable HTTP for the stateless readonly Kubernetes server", () => {
    expect(statefulSet).toMatch(
      /"k8s-ro": \{\n\s+"type": "http",\n\s+"url": "http:\/\/kubernetes-mcp-server-readonly\.paperclip\.svc\.cluster\.local:8080\/mcp"/,
    );
    expect(statefulSet).not.toMatch(
      /kubernetes-mcp-server-readonly\.paperclip\.svc\.cluster\.local:8080\/sse/,
    );
  });
});
