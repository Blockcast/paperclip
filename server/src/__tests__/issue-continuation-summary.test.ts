import { describe, expect, it } from "vitest";
import {
  ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS,
  buildContinuationSummaryMarkdown,
  continuationSummaryParksExecutor,
  extractContinuationSummaryNextAction,
} from "../services/issue-continuation-summary.js";

describe("issue continuation summaries", () => {
  it("builds bounded issue-local handoff context with required sections", () => {
    const body = buildContinuationSummaryMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-1579",
        title: "Add continuation summaries",
        description: [
          "## Objective",
          "",
          "Keep work resumable after adapter session reset.",
          "",
          "## Acceptance Criteria",
          "",
          "- Summary is issue-local",
          "- Wake context includes the summary",
        ].join("\n"),
        status: "in_progress",
        priority: "medium",
      },
      run: {
        id: "run-1",
        status: "succeeded",
        error: null,
        resultJson: {
          summary: "Updated server/src/services/heartbeat.ts and packages/adapter-utils/src/server-utils.ts.",
        },
        stdoutExcerpt: null,
        stderrExcerpt: null,
        finishedAt: new Date("2026-04-18T12:00:00.000Z"),
      },
      agent: {
        id: "agent-1",
        name: "CodexCoder",
        adapterType: "codex_local",
      },
    });

    expect(body).toContain("# Continuation Summary");
    expect(body).toContain("## Objective");
    expect(body).toContain("Keep work resumable after adapter session reset.");
    expect(body).toContain("## Acceptance Criteria");
    expect(body).toContain("- Summary is issue-local");
    expect(body).toContain("## Recent Concrete Actions");
    expect(body).toContain("Run `run-1` finished with status `succeeded`");
    expect(body).toContain("`server/src/services/heartbeat.ts`");
    expect(body).toContain("## Commands Run");
    expect(body).toContain("## Blockers / Decisions");
    expect(body).toContain("## Next Action");
    expect(body.length).toBeLessThanOrEqual(ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS);
  });

  it("uses failure state to point the next run at the error", () => {
    const body = buildContinuationSummaryMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-1579",
        title: "Add continuation summaries",
        description: null,
        status: "in_progress",
        priority: "medium",
      },
      run: {
        id: "run-2",
        status: "failed",
        error: "adapter failed",
        errorCode: "adapter_failed",
        resultJson: null,
      },
      agent: {
        id: "agent-1",
        name: "CodexCoder",
        adapterType: "codex_local",
      },
    });

    expect(body).toContain("Latest run error (adapter_failed): adapter failed");
    expect(body).toContain("Inspect the failed run, fix the cause");
  });

  it("keeps the causal tail of a long run error", () => {
    const cause = "error: could not lock config file /workspace/.git/config.lock: File exists";
    const body = buildContinuationSummaryMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-1579",
        title: "Add continuation summaries",
        description: null,
        status: "in_progress",
        priority: "medium",
      },
      run: {
        id: "run-3",
        status: "failed",
        error: `${"/very/long/workspace/path/".repeat(30)}${cause}`,
        errorCode: "workspace_git_submodule_unavailable",
        resultJson: null,
      },
      agent: { id: "agent-1", name: "CodexCoder", adapterType: "codex_local" },
    });

    expect(body).toContain("could not lock config file");
  });

  it("detects continuation summaries that explicitly park executor work for review", () => {
    const body = [
      "# Continuation Summary",
      "",
      "## Next Action",
      "",
      "- Wait for reviewer feedback or approval before continuing executor work.",
    ].join("\n");

    expect(extractContinuationSummaryNextAction(body)).toBe(
      "Wait for reviewer feedback or approval before continuing executor work.",
    );
    expect(continuationSummaryParksExecutor(body)).toBe(true);
  });

  it("does not park executor work when the next action is still runnable", () => {
    const body = [
      "# Continuation Summary",
      "",
      "## Next Action",
      "",
      "- Re-check run `25145432006`, then move the issue to `in_review` if the final step is green.",
    ].join("\n");

    expect(continuationSummaryParksExecutor(body)).toBe(false);
  });
  it("keeps an over-budget objective readable and marks what it dropped (PEN-4311)", () => {
    // Shaped on the real PEN-2551 description: the sentence that matters sits ~700 characters in,
    // which the old centre-elision deleted while leaving prose that read as continuous.
    const description = [
      "## Outcome",
      "",
      "Implement the real managed-subscription command consumer in `penstock-vault-node` for the accepted plan revision 38. A paired Vault must be able to execute one tenant-bound account request through signup, exact-recipient verification, sanctioned tenant-card checkout, relogin, provider-control readback, and signed callback emission. The implementation is offline/testable now and remains fail-closed until the independent card authority and prepaid admission gates are satisfied.",
      "",
      "> Plan anchor re-cut 2026-10-18 (DevOps): revision 35 to 38, the last accepted revision. Later revisions are editorial and carry no acceptance card - do not re-point to the storage tip.",
      "",
      "## Tests and evidence",
      "",
      `${"Attach exact branch, commit, and redaction-scan evidence. ".repeat(40)}Do not claim connected or production activation from mocks.`,
    ].join("\n");

    const body = buildContinuationSummaryMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PEN-2551",
        title: "Implement the managed-subscription command consumer in Vault node",
        description,
        status: "todo",
        priority: "critical",
      },
      run: {
        id: "run-4",
        status: "succeeded",
        error: null,
        resultJson: null,
        finishedAt: new Date("2026-10-18T19:50:15.858Z"),
      },
      agent: { id: "agent-1", name: "Ceo", adapterType: "claude_k8s" },
    });

    const objective = body.slice(
      body.indexOf("## Objective") + "## Objective\n\n".length,
      body.indexOf("\n\n## Acceptance Criteria"),
    );

    // The guidance the elision used to delete.
    expect(objective).toContain("do not re-point to the storage tip");
    // What is kept is an unbroken prefix of the source: nothing from later in the description is
    // welded onto the end of it.
    const kept = objective.slice(0, objective.indexOf("\n\n[..."));
    expect(description.trim().startsWith(kept)).toBe(true);
    expect(objective).toContain("characters elided; read the issue description for the full text");
    expect(objective).not.toContain("production activation from mocks");
  });

  it("does not carry a failure instruction forward onto a succeeded run (PEN-4311)", () => {
    const previousSummaryBody = [
      "# Continuation Summary",
      "",
      "## Next Action",
      "",
      "- Inspect the failed run, fix the cause, and resume from the most recent concrete action above.",
    ].join("\n");

    const body = buildContinuationSummaryMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PEN-2551",
        title: "Implement the managed-subscription command consumer in Vault node",
        description: null,
        status: "todo",
        priority: "critical",
      },
      run: {
        id: "59816fe5-c1d5-42a2-b531-9c54a47cd254",
        status: "succeeded",
        error: null,
        resultJson: null,
        finishedAt: new Date("2026-10-18T19:50:15.858Z"),
      },
      agent: { id: "agent-1", name: "Ceo", adapterType: "claude_k8s" },
      previousSummaryBody,
    });

    expect(body).toContain("finished with status `succeeded`");
    expect(body).not.toContain("Inspect the failed run");
    expect(extractContinuationSummaryNextAction(body)).toBe(
      "Resume implementation from the acceptance criteria, latest comments, and this summary.",
    );
  });

  it("stops re-minting the review park once the issue has left in_review (PEN-4311)", () => {
    const previousSummaryBody = [
      "# Continuation Summary",
      "",
      "## Next Action",
      "",
      "- Wait for reviewer feedback or approval before continuing executor work.",
    ].join("\n");

    const body = buildContinuationSummaryMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-1579",
        title: "Add continuation summaries",
        description: null,
        status: "in_progress",
        priority: "medium",
      },
      run: { id: "run-5", status: "succeeded", error: null, resultJson: null },
      agent: { id: "agent-1", name: "CodexCoder", adapterType: "codex_local" },
      previousSummaryBody,
    });

    expect(continuationSummaryParksExecutor(body)).toBe(false);
  });

  it("still carries forward a next action this generator did not write", () => {
    const previousSummaryBody = [
      "# Continuation Summary",
      "",
      "## Next Action",
      "",
      "- Re-check run `25145432006`, then move the issue to `in_review` if the final step is green.",
    ].join("\n");

    const body = buildContinuationSummaryMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-1579",
        title: "Add continuation summaries",
        description: null,
        status: "in_progress",
        priority: "medium",
      },
      run: { id: "run-6", status: "succeeded", error: null, resultJson: null },
      agent: { id: "agent-1", name: "CodexCoder", adapterType: "codex_local" },
      previousSummaryBody,
    });

    expect(extractContinuationSummaryNextAction(body)).toBe(
      "Re-check run `25145432006`, then move the issue to `in_review` if the final step is green.",
    );
  });
});
