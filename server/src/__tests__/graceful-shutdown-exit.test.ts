import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "graceful-shutdown-exit-fixture.ts");
const tsx = path.resolve(here, "..", "..", "node_modules", ".bin", "tsx");
const serverRoot = path.resolve(here, "..", "..");

describe("graceful shutdown — real process exit", () => {
  it("flushes the final breadcrumb through pressured piped stderr before exit", async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(tsx, [fixture], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const watchdog = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("graceful shutdown fixture timed out"));
      }, 5_000);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(watchdog);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(watchdog);
        resolve({ code, stdout, stderr });
      });
    });

    expect(result.stdout).toContain("BACKPRESSURE");
    expect(result.code).toBe(0);
    expect(result.stderr.length).toBeGreaterThan(200_000);
    expect(result.stderr).toContain("[shutdown] handler complete; exiting (signal=SIGTERM)\n");
  });

  it("flushes a fatal record when the crash starts after the final shutdown breadcrumb", async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", fixture, "crash-during-shutdown"], {
        cwd: serverRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let signalSent = false;
      const watchdog = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("shutdown/crash race fixture timed out"));
      }, 5_000);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (!signalSent && stdout.includes("READY")) {
          signalSent = true;
          child.kill("SIGTERM");
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(watchdog);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(watchdog);
        resolve({ code, stdout, stderr });
      });
    });

    expect(result.stdout).toContain("BACKPRESSURE");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("[shutdown] uncaughtException: Error: SHUTDOWN_CRASH_SENTINEL");
    expect(result.stderr).toContain("[shutdown] handler complete; exiting (signal=SIGTERM)\n");
    expect(result.stderr).toContain("[shutdown] exiting 1 after uncaughtException");
  });
});
