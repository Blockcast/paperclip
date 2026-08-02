import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "graceful-shutdown-exit-fixture.ts");
const tsx = path.resolve(here, "..", "..", "node_modules", ".bin", "tsx");

describe("graceful shutdown — real process exit", () => {
  it("flushes the final breadcrumb through pressured piped stderr before exit", async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(tsx, [fixture], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

    expect(result.stdout).toContain("BACKPRESSURE");
    expect(result.code).toBe(0);
    expect(result.stderr.length).toBeGreaterThan(200_000);
    expect(result.stderr).toContain("[shutdown] handler complete; exiting (signal=SIGTERM)\n");
  });
});
