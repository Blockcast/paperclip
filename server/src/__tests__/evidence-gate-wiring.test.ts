import { describe, expect, it, vi } from "vitest";
import {
  runEvidenceGate,
  type EvidenceFetchResult,
} from "../services/evidence-gate-wiring.js";

const FRONTEND_DONE_WHEN = `## Done when\n- a\n- b\n- c\n`;
const LANDING_ARTIFACT = "https://github.com/Blockcast/paperclip/pull/775";

function frontendBody(): string {
  return [
    "![desktop](./shot_1440x900.png)",
    "![mobile](./shot_390x844.png)",
    "| Criterion | Status |",
    "|---|---|",
    "| a | ✅ |",
    "| b | ✅ |",
    "| c | ✅ |",
    LANDING_ARTIFACT,
  ].join("\n");
}

describe("runEvidenceGate", () => {
  it("returns a pass record for a fully-evidenced frontend issue", async () => {
    const fetch = vi.fn<(id: string) => Promise<EvidenceFetchResult>>(
      async () => ({
        description: FRONTEND_DONE_WHEN,
        labels: [{ name: "frontend" }],
        comments: [
          {
            body: frontendBody(),
            authorAgentId: "a1",
            authorUserId: null,
            createdAt: "2026-05-11T20:00:00.000Z",
          },
        ],
        workProducts: [],
      }),
    );
    const fixedNow = new Date("2026-05-11T22:00:00.000Z");
    const result = await runEvidenceGate(fetch, "issue-1", fixedNow);
    expect(fetch).toHaveBeenCalledWith("issue-1", fixedNow);
    expect(result.verdict).toBe("pass");
    expect(result.missing).toEqual([]);
    expect(result.unlabeledFallback).toBe(false);
    expect(result.evaluatedAt).toBe("2026-05-11T22:00:00.000Z");
  });

  it("returns a block record when frontend evidence is missing", async () => {
    const fetch = vi.fn<(id: string) => Promise<EvidenceFetchResult>>(
      async () => ({
        description: FRONTEND_DONE_WHEN,
        labels: [{ name: "frontend" }],
        comments: [
          {
            body: "claiming done",
            authorAgentId: "a1",
            authorUserId: null,
            createdAt: "2026-05-11T20:00:00.000Z",
          },
        ],
        workProducts: [],
      }),
    );
    const result = await runEvidenceGate(fetch, "issue-2");
    expect(result.verdict).toBe("block");
    expect(result.missing).toEqual(
      expect.arrayContaining([
        "screenshot:1440x900",
        "screenshot:390x844",
        "checklist:done-when",
      ]),
    );
  });

  it("passes with the newest recent user-authored operator override", async () => {
    const fetch = vi.fn<(id: string) => Promise<EvidenceFetchResult>>(async () => ({
      description: FRONTEND_DONE_WHEN,
      labels: [{ name: "frontend" }],
      comments: [
        {
          body: "evidence-gate: override incident response requires landing now",
          authorAgentId: null,
          authorUserId: "operator-1",
          createdAt: "2026-05-11T21:30:00.000Z",
        },
      ],
      workProducts: [],
    }));

    const result = await runEvidenceGate(fetch, "issue-override", new Date("2026-05-11T22:00:00.000Z"));

    expect(result).toMatchObject({
      verdict: "pass",
      overridden: true,
      overrideReason: "incident response requires landing now",
      missing: [],
    });
  });

  it("finds an operator override outside the evaluator comment window", async () => {
    const override = {
      body: "evidence-gate: override incident response requires landing now",
      authorAgentId: null,
      authorUserId: "operator-1",
      createdAt: "2026-05-11T21:30:00.000Z",
    };
    const fetch = vi.fn<(id: string) => Promise<EvidenceFetchResult>>(async () => ({
      description: FRONTEND_DONE_WHEN,
      labels: [{ name: "frontend" }],
      comments: Array.from({ length: 10 }, (_, index) => ({
        body: `later agent comment ${index}`,
        authorAgentId: "agent-1",
        authorUserId: null,
        createdAt: `2026-05-11T21:4${index}:00.000Z`,
      })),
      operatorOverrideComments: [override],
      workProducts: [],
    }));

    const result = await runEvidenceGate(fetch, "issue-displaced-override", new Date("2026-05-11T22:00:00.000Z"));

    expect(result).toMatchObject({
      verdict: "pass",
      overridden: true,
      overrideReason: "incident response requires landing now",
    });
  });

  it.each([
    ["agent-authored", "agent-1", null, "2026-05-11T21:30:00.000Z"],
    ["expired", null, "operator-1", "2026-05-11T20:59:59.999Z"],
    ["future", null, "operator-1", "2026-05-11T22:00:00.001Z"],
    ["malformed", null, "operator-1", "2026-05-11T21:30:00.000Z"],
    ["blank", null, "operator-1", "2026-05-11T21:30:00.000Z"],
  ])("ignores %s override comments", async (kind, authorAgentId, authorUserId, createdAt) => {
    const body = kind === "malformed"
      ? "evidence-gate: override"
      : kind === "blank"
        ? "evidence-gate: override   "
        : "evidence-gate: override reason";
    const fetch = vi.fn<(id: string) => Promise<EvidenceFetchResult>>(async () => ({
      description: FRONTEND_DONE_WHEN,
      labels: [{ name: "frontend" }],
      comments: [{ body, authorAgentId, authorUserId, createdAt }],
      workProducts: [],
    }));

    const result = await runEvidenceGate(fetch, `issue-${kind}`, new Date("2026-05-11T22:00:00.000Z"));

    expect(result.verdict).toBe("block");
    expect(result.overridden).toBeUndefined();
  });

  it("maps work-product `type` to evaluator `kind` (screenshot pickup)", async () => {
    const fetch = vi.fn<(id: string) => Promise<EvidenceFetchResult>>(
      async () => ({
        description: FRONTEND_DONE_WHEN,
        labels: [{ name: "frontend" }],
        comments: [
          {
            body: `| a | ✅ |\n|---|---|\n| b | ✅ |\n| c | ✅ |\n| d | ✅ |\n${LANDING_ARTIFACT}`,
            authorAgentId: "a1",
            authorUserId: null,
            createdAt: "2026-05-11T20:00:00.000Z",
          },
        ],
        workProducts: [
          { type: "screenshot", metadata: { viewport: "1440x900" }, status: "ok" },
          { type: "screenshot", metadata: { viewport: "390x844" }, status: "ok" },
        ],
      }),
    );
    const result = await runEvidenceGate(fetch, "issue-3");
    expect(result.verdict).toBe("pass");
    expect(result.evidenceFound).toEqual(
      expect.arrayContaining(["screenshot:1440x900", "screenshot:390x844"]),
    );
  });

  it("flags unlabeledFallback when the issue has no matching label", async () => {
    const fetch = vi.fn<(id: string) => Promise<EvidenceFetchResult>>(
      async () => ({
        description: "## Done when\n- something",
        labels: [{ name: "random" }],
        comments: [
          {
            body: "done",
            authorAgentId: "a1",
            authorUserId: null,
            createdAt: "2026-05-11T20:00:00.000Z",
          },
        ],
        workProducts: [],
      }),
    );
    const result = await runEvidenceGate(fetch, "issue-4");
    expect(result.verdict).toBe("warn");
    expect(result.unlabeledFallback).toBe(true);
    expect(result.missing).toEqual(["checklist:done-when"]);
  });

  it("e2e-run with status='pass' satisfies the e2e-run shape (via status → result mapping)", async () => {
    // The wiring maps work_product.status → evaluator.result. A workproduct
    // with status: "pass" should satisfy `e2e-run` for a registry that
    // requires it. This is a sanity check that the mapping doesn't drop the
    // value or use the wrong field.
    const fetch = vi.fn<(id: string) => Promise<EvidenceFetchResult>>(
      async () => ({
        description: "## Done when\n- e2e covers flow",
        labels: [{ name: "e2e-strict" }],
        comments: [
          {
            body: "ran the script",
            authorAgentId: "a1",
            authorUserId: null,
            createdAt: "2026-05-11T20:00:00.000Z",
          },
        ],
        workProducts: [
          { type: "e2e-run", metadata: null, status: "pass" },
        ],
      }),
    );
    // The default registry doesn't have an e2e-strict label; this test
    // therefore exercises the unlabeled-fallback path. e2e-run isn't a
    // required shape there, so result is `warn` (missing checklist) — what
    // we want to assert here is that the evidenceFound list DOES include
    // e2e-run, proving the wiring's status→result mapping worked.
    const result = await runEvidenceGate(fetch, "issue-5");
    expect(result.allDetected).toContain("e2e-run");
  });

  it("accepts cross-repository PR links when wiring has no allowlist", async () => {
    const fetch = vi.fn<(id: string) => Promise<EvidenceFetchResult>>(
      async () => ({
        description: "## Done when\n- QA evidence exists",
        labels: [],
        comments: [
          {
            body: [
              "## QA recovery evidence",
              "- Implementation PR: https://github.com/Blockcast/Network-Operator-Portal/pull/319",
              "- Test output: Test Files  1 passed (1)",
              "| Criterion | Status | Evidence |",
              "|---|---|---|",
              "| QA evidence exists | [x] | qa-report |",
            ].join("\n"),
            authorAgentId: "qa-agent",
            authorUserId: null,
            createdAt: "2026-06-12T00:00:00.000Z",
          },
        ],
        workProducts: [],
      }),
    );
    const result = await runEvidenceGate(fetch, "issue-qa-only");
    expect(result.allDetected).toEqual(
      expect.arrayContaining(["test-output", "checklist:done-when", "pr-link"]),
    );
  });

  it("blocks with a dedicated diagnostic when history shows Done-when bullets were removed", async () => {
    const fetch = vi.fn<(id: string) => Promise<EvidenceFetchResult>>(
      async () => ({
        description: "No acceptance checklist remains.",
        doneWhenBulletsRemoved: true,
        labels: [],
        comments: [],
        workProducts: [],
      }),
    );

    const result = await runEvidenceGate(fetch, "issue-history-removal");

    expect(result.verdict).toBe("block");
    expect(result.diagnostics).toContain("done-when-bullets-removed");
  });

  it("does not report removal when an issue never had Done-when bullets", async () => {
    const fetch = vi.fn<(id: string) => Promise<EvidenceFetchResult>>(
      async () => ({
        description: "No acceptance checklist was defined.",
        doneWhenBulletsRemoved: false,
        labels: [],
        comments: [],
        workProducts: [],
      }),
    );

    const result = await runEvidenceGate(fetch, "issue-without-history");

    expect(result.diagnostics).not.toContain("done-when-bullets-removed");
  });

  it("ignores removed Done-when bullets when the issue type does not require them", async () => {
    const fetch = vi.fn<(id: string) => Promise<EvidenceFetchResult>>(
      async () => ({
        description: "No acceptance checklist remains.",
        doneWhenBulletsRemoved: true,
        labels: [{ name: "pr" }],
        comments: [
          {
            body: "Opened https://github.com/Blockcast/paperclip/pull/649",
            authorAgentId: "a1",
            authorUserId: null,
            createdAt: "2026-07-12T14:00:00.000Z",
          },
        ],
        workProducts: [],
      }),
    );

    const result = await runEvidenceGate(fetch, "pr-with-irrelevant-history");

    expect(result.verdict).toBe("pass");
    expect(result.diagnostics).not.toContain("done-when-bullets-removed");
  });

  it("propagates fetch failures back to the caller (no swallowing)", async () => {
    const fetch = vi.fn<(id: string) => Promise<EvidenceFetchResult>>(
      async () => {
        throw new Error("DB explosion");
      },
    );
    await expect(runEvidenceGate(fetch, "issue-6")).rejects.toThrow(
      /DB explosion/,
    );
  });
});
