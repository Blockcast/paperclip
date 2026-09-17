import { describe, expect, it, vi } from "vitest";
import {
  runEvidenceGate,
  type EvidenceFetchResult,
} from "../services/evidence-gate-wiring.js";
import type { TruthProbe } from "../services/evidence-truth.js";

/**
 * A GitHub truth probe that found both shapes (BLO-32239). Cases below are
 * about the text-detected shapes, so they supply it to keep their assertions
 * about their own subject rather than about the probe.
 */
const cleanProbe: TruthProbe = async () => ({
  detections: { "review:ally-clean": true, "deploy:landed": true },
  diagnostics: [],
  probeFailed: false,
  noLinkedPullRequest: false,
});

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
    const result = await runEvidenceGate(fetch, "issue-1", fixedNow, cleanProbe);
    expect(fetch).toHaveBeenCalledWith("issue-1", fixedNow);
    expect(result.verdict).toBe("pass");
    expect(result.missing).toEqual([]);
    expect(result.unlabeledFallback).toBe(false);
    expect(result.evaluatedAt).toBe("2026-05-11T22:00:00.000Z");
    expect(result.commitEvidence).toEqual([]);
  });

  it("extracts only agent-authored GitHub commit URLs for remote verification", async () => {
    const fetch = vi.fn<(id: string) => Promise<EvidenceFetchResult>>(async () => ({
      description: "## Done when\n- ship it",
      labels: [],
      comments: [
        {
          body: "commit https://github.com/Blockcast/paperclip/commit/ABCDEF1234567",
          authorAgentId: "a1",
          authorUserId: null,
          createdAt: "2026-05-11T20:00:00.000Z",
        },
        {
          body: "operator copied https://github.com/Blockcast/paperclip/commit/1111111",
          authorAgentId: null,
          authorUserId: "u1",
          createdAt: "2026-05-11T20:01:00.000Z",
        },
      ],
      workProducts: [],
    }));
    const result = await runEvidenceGate(fetch, "issue-commit");
    expect(result.commitEvidence).toEqual([
      { repoFullName: "Blockcast/paperclip", sha: "abcdef1234567" },
    ]);
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
          { type: "screenshot", metadata: { viewport: "1440x900" }, status: "ok", sourceTrust: null },
          { type: "screenshot", metadata: { viewport: "390x844" }, status: "ok", sourceTrust: null },
        ],
      }),
    );
    const result = await runEvidenceGate(fetch, "issue-3", new Date(), cleanProbe);
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
    const result = await runEvidenceGate(fetch, "issue-4", new Date(), cleanProbe);
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

// --- BLO-32239 Track B: the truth probe ------------------------------------

describe("runEvidenceGate — truth probe", () => {
  const checklistIssue = (): EvidenceFetchResult => ({
    description: "Do it.\n## Done when\n- a\n",
    labels: [],
    workProducts: [],
    comments: [
      {
        body: "| Criterion | Status | Evidence |\n|---|---|---|\n| a | ✅ | x |",
        authorAgentId: "agent-1",
        authorUserId: null,
        createdAt: "2026-09-06T00:00:00.000Z",
      },
    ],
  });
  const NOW = new Date("2026-09-06T00:01:00.000Z");

  it("merges the probe's detections and diagnostics", async () => {
    const truth: TruthProbe = async () => ({
      detections: { "review:ally-clean": true, "deploy:landed": true },
      diagnostics: ["probe-ran"],
      probeFailed: false,
      noLinkedPullRequest: false,
    });
    const rec = await runEvidenceGate(async () => checklistIssue(), "i1", NOW, truth);
    expect(rec.verdict).toBe("pass");
    expect(rec.diagnostics).toContain("probe-ran");
  });

  it("flag on + probe failed → warn with the suppression diagnostic, never block", async () => {
    const truth: TruthProbe = async () => ({
      detections: {},
      diagnostics: ["github-truth-probe-failed:head_sha:Blockcast/paperclip#1"],
      probeFailed: true,
      noLinkedPullRequest: false,
    });
    const rec = await runEvidenceGate(async () => checklistIssue(), "i1", NOW, truth, {
      unlabeledTruthBlock: true,
    });
    expect(rec.verdict).toBe("warn");
    expect(rec.diagnostics).toContain("unlabeled-truth-block-suppressed:probe-failed");
    expect(rec.diagnostics).toContain("github-truth-probe-failed:head_sha:Blockcast/paperclip#1");
  });

  it("flag on + a linked PR whose truth is clean but nothing found → block", async () => {
    const truth: TruthProbe = async () => ({
      detections: {},
      diagnostics: [],
      probeFailed: false,
      noLinkedPullRequest: false,
    });
    const rec = await runEvidenceGate(async () => checklistIssue(), "i1", NOW, truth, {
      unlabeledTruthBlock: true,
    });
    expect(rec.verdict).toBe("block");
    expect(rec.diagnostics).toContain("unlabeled-truth-block");
  });

  // The sibling of the case above, and the whole point of carrying a third
  // state: its input was BYTE-IDENTICAL to a no-PR probe result before
  // `noLinkedPullRequest` existed, so the assertion above used to pin the
  // opposite of the CTO's 2026-09-16 ruling. `review:ally-clean` needs a head
  // to review; with no linked PR the assignee can never satisfy it, at any
  // flag value.
  it("flag on + NO linked PR → warn, suppressed for its own distinct reason", async () => {
    const truth: TruthProbe = async () => ({
      detections: {},
      diagnostics: ["no-linked-pull-request"],
      probeFailed: false,
      noLinkedPullRequest: true,
    });
    const rec = await runEvidenceGate(async () => checklistIssue(), "i1", NOW, truth, {
      unlabeledTruthBlock: true,
    });
    expect(rec.verdict).toBe("warn");
    expect(rec.diagnostics).toContain("unlabeled-truth-block-suppressed:no-linked-pull-request");
    // Not folded into probe-failed: the runbook reads these apart.
    expect(rec.diagnostics).not.toContain("unlabeled-truth-block-suppressed:probe-failed");
    expect(rec.diagnostics).not.toContain("unlabeled-truth-block");
  });

  it("no probe supplied → truth shapes are simply missing, and it warns", async () => {
    const rec = await runEvidenceGate(async () => checklistIssue(), "i1", NOW);
    expect(rec.verdict).toBe("warn");
    expect(rec.missing).toEqual(expect.arrayContaining(["review:ally-clean"]));
  });

  it("hands the probe each work product's provenance, not just its metadata", async () => {
    const seen: unknown[] = [];
    const truth: TruthProbe = async ({ workProducts }) => {
      seen.push(...workProducts);
      return { detections: {}, diagnostics: [], probeFailed: false, noLinkedPullRequest: false };
    };
    await runEvidenceGate(
      async () => ({
        ...checklistIssue(),
        workProducts: [
          {
            type: "pull_request",
            metadata: { repoFullName: "Blockcast/paperclip", prNumber: 1, merged: true },
            status: null,
            sourceTrust: { promotedByActorId: "github_pull_request_webhook" },
          },
        ],
      }),
      "i1",
      NOW,
      truth,
    );
    expect(seen).toEqual([
      {
        type: "pull_request",
        metadata: { repoFullName: "Blockcast/paperclip", prNumber: 1, merged: true },
        sourceTrust: { promotedByActorId: "github_pull_request_webhook" },
      },
    ]);
  });

  it("an operator override short-circuits before the probe spends a GitHub call", async () => {
    let calls = 0;
    const truth: TruthProbe = async () => {
      calls += 1;
      return { detections: {}, diagnostics: [], probeFailed: false, noLinkedPullRequest: false };
    };
    const rec = await runEvidenceGate(
      async () => ({
        ...checklistIssue(),
        comments: [
          {
            body: "evidence-gate: override shipping this by hand",
            authorAgentId: null,
            authorUserId: "u1",
            createdAt: "2026-09-06T00:00:30.000Z",
          },
        ],
      }),
      "i1",
      NOW,
      truth,
      { unlabeledTruthBlock: true },
    );
    expect(rec.verdict).toBe("pass");
    expect(rec.overridden).toBe(true);
    expect(calls).toBe(0);
  });
});
