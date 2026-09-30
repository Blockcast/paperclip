import { describe, expect, it, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readOrphanedRunTerminalResult } from "../services/orphaned-run-terminal-result.js";

/**
 * PEN-2421. These pin the fail-closed contract of the artifact
 * reader: only an explicit successful terminal event may rescue a vanished-Job
 * run, and nothing here may throw, because the caller is the orphaned-run
 * reconciler's finalization path.
 */
describe("orphaned run terminal result recovery", () => {
  const previousBasePath = process.env.RUN_LOG_BASE_PATH;

  afterEach(() => {
    if (previousBasePath === undefined) delete process.env.RUN_LOG_BASE_PATH;
    else process.env.RUN_LOG_BASE_PATH = previousBasePath;
  });

  async function seedArtifact(contents: string | null, options?: { isolationKey?: string }) {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-orphan-result-"));
    process.env.RUN_LOG_BASE_PATH = base;
    const input = { companyId: randomUUID(), agentId: randomUUID(), runId: randomUUID() };
    if (contents !== null) {
      const dir = options?.isolationKey
        ? path.join(base, input.companyId, input.agentId, "isolated", options.isolationKey)
        : path.join(base, input.companyId, input.agentId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${input.runId}.pod.ndjson`), contents, "utf-8");
    }
    return input;
  }

  it("reports a successful terminal result", async () => {
    const input = await seedArtifact(
      [
        JSON.stringify({ type: "system", subtype: "init" }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false }),
      ].join("\n"),
    );
    expect(await readOrphanedRunTerminalResult(input)).toMatchObject({
      outcome: "found",
      succeeded: true,
      subtype: "success",
    });
  });

  it("finds the artifact under the isolated-run layout", async () => {
    const input = await seedArtifact(
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
      { isolationKey: "issue-4242" },
    );
    expect(await readOrphanedRunTerminalResult(input)).toMatchObject({
      outcome: "found",
      succeeded: true,
    });
  });

  it("does not report success when the agent flagged an error", async () => {
    const input = await seedArtifact(
      JSON.stringify({ type: "result", subtype: "success", is_error: true }),
    );
    expect(await readOrphanedRunTerminalResult(input)).toMatchObject({
      outcome: "found",
      succeeded: false,
    });
  });

  it("does not report success for a non-success subtype", async () => {
    const input = await seedArtifact(
      JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }),
    );
    expect(await readOrphanedRunTerminalResult(input)).toMatchObject({
      outcome: "found",
      succeeded: false,
      subtype: "error_during_execution",
    });
  });

  it("treats a missing subtype as unsuccessful even without an error flag", async () => {
    // An `is_error`-only judgement would read this as a success; both halves of
    // the structured verdict are required.
    const input = await seedArtifact(JSON.stringify({ type: "result" }));
    expect(await readOrphanedRunTerminalResult(input)).toMatchObject({
      outcome: "found",
      succeeded: false,
    });
  });

  it("returns the last result event when the stream carries more than one", async () => {
    const input = await seedArtifact(
      [
        JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false }),
      ].join("\n"),
    );
    expect(await readOrphanedRunTerminalResult(input)).toMatchObject({
      outcome: "found",
      succeeded: true,
      subtype: "success",
    });
  });

  it("reports no_artifact when nothing was written", async () => {
    const input = await seedArtifact(null);
    expect(await readOrphanedRunTerminalResult(input)).toMatchObject({
      outcome: "absent",
      reason: "no_artifact",
    });
  });

  it("reports empty_artifact for a zero-byte file", async () => {
    const input = await seedArtifact("");
    expect(await readOrphanedRunTerminalResult(input)).toMatchObject({
      outcome: "absent",
      reason: "empty_artifact",
    });
  });

  it("reports no_result_event for a run killed before its terminal event", async () => {
    const input = await seedArtifact(
      [
        JSON.stringify({ type: "system", subtype: "init" }),
        JSON.stringify({ type: "assistant", message: { content: "killed mid-run" } }),
      ].join("\n"),
    );
    expect(await readOrphanedRunTerminalResult(input)).toMatchObject({
      outcome: "absent",
      reason: "no_result_event",
    });
  });

  it("tolerates trailing newlines and interleaved malformed lines", async () => {
    const input = await seedArtifact(
      [
        "not json at all",
        "{ truncated",
        JSON.stringify({ type: "result", subtype: "success", is_error: false }),
        "",
        "",
      ].join("\n"),
    );
    expect(await readOrphanedRunTerminalResult(input)).toMatchObject({
      outcome: "found",
      succeeded: true,
    });
  });

  it("still finds the terminal event when the transcript exceeds the tail window", async () => {
    // The reader caps its read, so a large transcript must not push the terminal
    // event out of reach -- and the sliced first line must not break parsing.
    const filler = Array.from({ length: 4000 }, (_, index) =>
      JSON.stringify({ type: "assistant", message: { content: `chunk ${index} ${"x".repeat(200)}` } }),
    );
    const input = await seedArtifact(
      [...filler, JSON.stringify({ type: "result", subtype: "success", is_error: false })].join("\n"),
    );
    expect(await readOrphanedRunTerminalResult(input)).toMatchObject({
      outcome: "found",
      succeeded: true,
    });
  });

  it("does not throw when the artifact path is a directory", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-orphan-result-"));
    process.env.RUN_LOG_BASE_PATH = base;
    const input = { companyId: randomUUID(), agentId: randomUUID(), runId: randomUUID() };
    await fs.mkdir(path.join(base, input.companyId, input.agentId, `${input.runId}.pod.ndjson`), {
      recursive: true,
    });
    expect(await readOrphanedRunTerminalResult(input)).toMatchObject({ outcome: "absent" });
  });
});
