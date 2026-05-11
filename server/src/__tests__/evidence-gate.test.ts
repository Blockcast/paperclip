import { describe, expect, it } from "vitest";
import {
  evaluateEvidence,
  resolveRequiredShapes,
  type EvidenceCommentLite,
  type EvidenceWorkProductLite,
} from "../services/evidence-gate.js";
import { DEFAULT_EVIDENCE_REGISTRY } from "../services/evidence-shapes.js";

function agentComment(body: string, createdAt = "2026-05-11T20:00:00.000Z"): EvidenceCommentLite {
  return { body, authorAgentId: "a1", authorUserId: null, createdAt };
}

function operatorComment(body: string, createdAt = "2026-05-11T20:00:00.000Z"): EvidenceCommentLite {
  return { body, authorAgentId: null, authorUserId: "u1", createdAt };
}

const FRONTEND_DONE_WHEN = `## Goal\nShip the blog.\n\n## Done when\n- entry page renders\n- listing page renders\n- footer at bottom\n`;

describe("resolveRequiredShapes", () => {
  it("unions required shapes across multiple matching labels", () => {
    const { required, unlabeledFallback } = resolveRequiredShapes(
      { labels: [{ name: "frontend" }, { name: "pr" }] },
      DEFAULT_EVIDENCE_REGISTRY,
    );
    expect(unlabeledFallback).toBe(false);
    expect(required).toEqual(
      expect.arrayContaining([
        "screenshot:1440x900",
        "screenshot:390x844",
        "checklist:done-when",
        "pr-link",
      ]),
    );
  });

  it("is case-insensitive on label names", () => {
    const { required, unlabeledFallback } = resolveRequiredShapes(
      { labels: [{ name: "FrontEnd" }] },
      DEFAULT_EVIDENCE_REGISTRY,
    );
    expect(unlabeledFallback).toBe(false);
    expect(required).toContain("screenshot:1440x900");
  });

  it("falls back to weak default when no labels match", () => {
    const { required, unlabeledFallback } = resolveRequiredShapes(
      { labels: [{ name: "random-tag" }] },
      DEFAULT_EVIDENCE_REGISTRY,
    );
    expect(unlabeledFallback).toBe(true);
    expect(required).toEqual(["checklist:done-when"]);
  });

  it("falls back to weak default when no labels at all", () => {
    const { required, unlabeledFallback } = resolveRequiredShapes(
      { labels: [] },
      DEFAULT_EVIDENCE_REGISTRY,
    );
    expect(unlabeledFallback).toBe(true);
    expect(required).toEqual(["checklist:done-when"]);
  });
});

describe("evaluateEvidence — frontend label", () => {
  it("blocks when a frontend issue has no screenshots and no checklist", () => {
    const result = evaluateEvidence({
      issue: {
        description: FRONTEND_DONE_WHEN,
        labels: [{ name: "frontend" }],
      },
      comments: [agentComment("Just claiming this is done, trust me.")],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("block");
    expect(result.missing).toEqual(
      expect.arrayContaining([
        "screenshot:1440x900",
        "screenshot:390x844",
        "checklist:done-when",
      ]),
    );
    expect(result.unlabeledFallback).toBe(false);
  });

  it("passes when both viewports + checklist are attached inline", () => {
    const body = [
      "## Three-evidence types",
      "",
      "![blog entry desktop 1440x900](./blog_entry_desktop_1440.png)",
      "![blog entry mobile 390x844](./blog_entry_mobile_390.png)",
      "",
      "| Criterion | Status | Evidence |",
      "|---|---|---|",
      "| entry page renders | ✅ | screenshot above |",
      "| listing page renders | ✅ | screenshot above |",
      "| footer at bottom | ✅ | curl grep |",
    ].join("\n");
    const result = evaluateEvidence({
      issue: {
        description: FRONTEND_DONE_WHEN,
        labels: [{ name: "frontend" }],
      },
      comments: [agentComment(body)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("pass");
    expect(result.missing).toEqual([]);
    expect(result.evidenceFound).toEqual(
      expect.arrayContaining([
        "screenshot:1440x900",
        "screenshot:390x844",
        "checklist:done-when",
      ]),
    );
  });

  it("detects screenshots via work_product metadata even when comment text lacks them", () => {
    const result = evaluateEvidence({
      issue: {
        description: FRONTEND_DONE_WHEN,
        labels: [{ name: "frontend" }],
      },
      comments: [
        agentComment(
          [
            "Shipped. Per-bug:",
            "| # | Status |",
            "|---|---|",
            "| entry | ✅ |",
            "| listing | ✅ |",
            "| footer | ✅ |",
          ].join("\n"),
        ),
      ],
      workProducts: [
        { kind: "screenshot", metadata: { viewport: "1440x900" } },
        { kind: "screenshot", metadata: { viewport: "390x844" } },
      ] as EvidenceWorkProductLite[],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("pass");
  });

  it("blocks when only one viewport is present", () => {
    const body = `![desktop](./shot_1440x900.png)\n| Item | Status |\n|---|---|\n| entry | ✅ |\n| listing | ✅ |\n| footer | ✅ |`;
    const result = evaluateEvidence({
      issue: {
        description: FRONTEND_DONE_WHEN,
        labels: [{ name: "frontend" }],
      },
      comments: [agentComment(body)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("block");
    expect(result.missing).toEqual(["screenshot:390x844"]);
  });

  it("ignores operator-side comments when looking for evidence", () => {
    // Operator pasting evidence shouldn't satisfy the gate; the AGENT
    // must produce the receipt.
    const body = [
      "![](./blog_entry_desktop_1440.png)",
      "![](./blog_entry_mobile_390x844.png)",
      "| # | Status |",
      "|---|---|",
      "| entry | ✅ |",
      "| listing | ✅ |",
      "| footer | ✅ |",
    ].join("\n");
    const result = evaluateEvidence({
      issue: {
        description: FRONTEND_DONE_WHEN,
        labels: [{ name: "frontend" }],
      },
      comments: [operatorComment(body)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("block");
  });
});

describe("evaluateEvidence — backend label", () => {
  it("passes when a vitest banner + checklist is attached", () => {
    const body = [
      "Tests:",
      "```",
      " Test Files  1 passed (1)",
      "      Tests  35 passed (35)",
      "```",
      "",
      "- [x] adds USABLE_TIERS entry",
      "- [x] adds asymmetric test for claude",
      "- [x] typecheck clean",
    ].join("\n");
    const result = evaluateEvidence({
      issue: {
        description: "## Done when\n- adds USABLE_TIERS entry\n- adds asymmetric test for claude\n- typecheck clean",
        labels: [{ name: "backend" }],
      },
      comments: [agentComment(body)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("pass");
  });

  it("blocks when claim is bare 'tests pass' without a banner", () => {
    const body = "all tests pass, trust me";
    const result = evaluateEvidence({
      issue: {
        description: "## Done when\n- a thing",
        labels: [{ name: "backend" }],
      },
      comments: [agentComment(body)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("block");
    expect(result.missing).toEqual(
      expect.arrayContaining(["test-output", "checklist:done-when"]),
    );
  });
});

describe("evaluateEvidence — unlabeled issue", () => {
  it("warns (not blocks) when unlabeled issue is missing the weak checklist", () => {
    const result = evaluateEvidence({
      issue: {
        description: "## Done when\n- some criterion\n- another criterion",
        labels: [],
      },
      comments: [agentComment("done")],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("warn");
    expect(result.unlabeledFallback).toBe(true);
    expect(result.missing).toEqual(["checklist:done-when"]);
  });

  it("passes when unlabeled issue has no Done-when section (vacuous)", () => {
    const result = evaluateEvidence({
      issue: { description: "## Goal\njust do it", labels: [] },
      comments: [agentComment("done")],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("pass");
  });
});

describe("evaluateEvidence — infra label", () => {
  it("passes with kubectl pod listing + curl probe", () => {
    const body = [
      "Deployed:",
      "```",
      "NAME                       READY   STATUS    RESTARTS   AGE",
      "paperclip-0                1/1     Running   0          5m",
      "```",
      "",
      "Probe:",
      "```",
      "$ curl http://paperclip.paperclip.svc:3100/api/ccrotate/status",
      `HTTP/1.1 200 OK`,
      `{"status":"ok"}`,
      "```",
    ].join("\n");
    const result = evaluateEvidence({
      issue: {
        description: "## Done when\n- pod is running\n- healthz returns 200",
        labels: [{ name: "infra" }],
      },
      comments: [agentComment(body)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("pass");
  });

  it("blocks infra with rollout-status text alone (no probe)", () => {
    const body = [
      'deployment "paperclip" successfully rolled out',
    ].join("\n");
    const result = evaluateEvidence({
      issue: {
        description: "## Done when\n- pod is running\n- healthz returns 200",
        labels: [{ name: "infra" }],
      },
      comments: [agentComment(body)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("block");
    expect(result.missing).toEqual(["probe-output"]);
  });
});

describe("evaluateEvidence — PR + e2e", () => {
  it("passes the pr shape when a github PR URL is in the comment", () => {
    const result = evaluateEvidence({
      issue: {
        description: "## Done when\n- PR opened",
        labels: [{ name: "pr" }],
      },
      comments: [
        agentComment("Opened https://github.com/Blockcast/paperclip/pull/132 — see diff."),
      ],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("pass");
  });

  it("detects e2e-script work_product as evidence (for issues that need it)", () => {
    const customRegistry = {
      ...DEFAULT_EVIDENCE_REGISTRY,
      e2e: { required: ["e2e-script" as const, "e2e-run" as const] },
    };
    const result = evaluateEvidence({
      issue: {
        description: "## Done when\n- e2e covers blog navigation",
        labels: [{ name: "e2e" }],
      },
      comments: [agentComment("Wrote and ran the script.")],
      workProducts: [
        { kind: "e2e-script", metadata: null },
        { kind: "e2e-run", result: "pass", metadata: null },
      ] as EvidenceWorkProductLite[],
      registry: customRegistry,
    });
    expect(result.verdict).toBe("pass");
  });
});

describe("evaluateEvidence — comment recency window", () => {
  it("only scans the recentCommentLimit most-recent agent comments", () => {
    // Older comment has the screenshots; newer comments are noise.
    // With limit=1 we should miss the old screenshots and block.
    const old = agentComment(
      [
        "![](./shot_1440x900.png)",
        "![](./shot_390x844.png)",
        "| C | S | E |",
        "|---|---|---|",
        "| entry | ✅ | x |",
        "| listing | ✅ | x |",
        "| footer | ✅ | x |",
      ].join("\n"),
      "2026-05-11T10:00:00Z",
    );
    const noise = agentComment("just checking in", "2026-05-11T20:00:00Z");
    const result = evaluateEvidence({
      issue: {
        description: FRONTEND_DONE_WHEN,
        labels: [{ name: "frontend" }],
      },
      comments: [old, noise],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
      recentCommentLimit: 1,
    });
    expect(result.verdict).toBe("block");
  });

  it("finds evidence in the most-recent agent comment when recentCommentLimit=1", () => {
    const recent = agentComment(
      [
        "![desktop](./shot_1440x900.png)",
        "![mobile](./shot_390x844.png)",
        "| C | S | E |",
        "|---|---|---|",
        "| entry | ✅ | x |",
        "| listing | ✅ | x |",
        "| footer | ✅ | x |",
      ].join("\n"),
      "2026-05-11T20:00:00Z",
    );
    const old = agentComment("nothing here", "2026-05-11T10:00:00Z");
    const result = evaluateEvidence({
      issue: {
        description: FRONTEND_DONE_WHEN,
        labels: [{ name: "frontend" }],
      },
      comments: [old, recent],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
      recentCommentLimit: 1,
    });
    expect(result.verdict).toBe("pass");
  });
});

describe("evaluateEvidence — shapeDetections shape", () => {
  it("returns booleans for every known shape", () => {
    const result = evaluateEvidence({
      issue: { description: null, labels: [] },
      comments: [agentComment("done")],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(Object.keys(result.shapeDetections).sort()).toEqual(
      [
        "checklist:done-when",
        "ci-green",
        "e2e-run",
        "e2e-script",
        "kubectl-state",
        "pr-link",
        "probe-output",
        "screenshot:1440x900",
        "screenshot:390x844",
        "test-output",
        "url-probe",
      ].sort(),
    );
    for (const v of Object.values(result.shapeDetections)) {
      expect(typeof v).toBe("boolean");
    }
  });
});
