import { describe, expect, it } from "vitest";
import {
  countDoneWhenBullets,
  evaluateEvidence,
  hasDoneWhenHeading,
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
const LANDING_ARTIFACT = "https://github.com/Blockcast/paperclip/pull/775";

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
        "landing-artifact",
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

  it("normalizes whitespace and Unicode forms in label names", () => {
    const registry = { "fróntend": DEFAULT_EVIDENCE_REGISTRY.frontend };
    const { required, unlabeledFallback } = resolveRequiredShapes(
      { labels: [{ name: " Fro\u0301ntEnd " }] },
      registry,
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
      LANDING_ARTIFACT,
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
            LANDING_ARTIFACT,
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
    const body = `![desktop](./shot_1440x900.png)\n${LANDING_ARTIFACT}\n| Item | Status |\n|---|---|\n| entry | ✅ |\n| listing | ✅ |\n| footer | ✅ |`;
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
      LANDING_ARTIFACT,
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

  it("does not vacuously satisfy the fallback checklist without Done-when bullets", () => {
    // The narrated-in_review hole: with no Done-when section the checklist
    // shape used to pass vacuously, letting analysis-only agent runs reach
    // in_review with zero artifacts.
    const result = evaluateEvidence({
      issue: { description: "## Goal\njust do it", labels: [] },
      comments: [agentComment("done")],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("warn");
    expect(result.unlabeledFallback).toBe(true);
    expect(result.missing).toEqual(["checklist:done-when"]);
    expect(result.evidenceFound).not.toContain("checklist:done-when");
  });

  it("still requires the fallback checklist when an unlabeled issue has no Done-when section", () => {
    const result = evaluateEvidence({
      issue: { description: "## Goal\njust do it", labels: [] },
      comments: [agentComment("Shipped: https://github.com/Blockcast/paperclip/pull/123")],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("warn");
    expect(result.missing).toEqual(["checklist:done-when"]);
    expect(result.allDetected).toContain("pr-link");
  });

  it("requires checklist evidence when unlabeled issue has no description at all", () => {
    const result = evaluateEvidence({
      issue: { description: null, labels: [] },
      comments: [agentComment("done")],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("warn");
    expect(result.missing).toEqual(["checklist:done-when"]);
  });

  it("blocks labeled issues when required Done-when criteria are absent", () => {
    const result = evaluateEvidence({
      issue: { description: "## Goal\nfix the thing", labels: [{ name: "backend" }] },
      comments: [agentComment(`Test Files  3 passed (3)\n${LANDING_ARTIFACT}`)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("block");
    expect(result.missing).toEqual(["checklist:done-when"]);
    expect(result.diagnostics).toContain("missing-done-when-bullets");
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
    expect(result.missing).toEqual(expect.arrayContaining(["kubectl-state", "probe-output"]));
  });

  it("does not accept bare JSON health status as probe output", () => {
    const result = evaluateEvidence({
      issue: { description: "## Done when\n- probe healthy", labels: [{ name: "infra" }] },
      comments: [agentComment('{"status":"ok"}')],
      workProducts: [],
      registry: { infra: { required: ["probe-output"] } },
    });
    expect(result.verdict).toBe("block");
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

  it("accepts a well-formed PR URL from another repository by default", () => {
    const result = evaluateEvidence({
      issue: { description: "## Done when\n- PR opened", labels: [{ name: "pr" }] },
      comments: [agentComment("https://github.com/Blockcast/onprem-k8s/pull/1316")],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("pass");
  });

  it("blocks PR URLs outside an explicitly configured repository allowlist", () => {
    const result = evaluateEvidence({
      issue: { description: "## Done when\n- PR opened", labels: [{ name: "pr" }] },
      comments: [agentComment("https://github.com/acme/repo/pull/132")],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
      allowedPrRepos: ["Blockcast/paperclip", "kkroo/paperclip"],
    });
    expect(result.verdict).toBe("block");
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
        LANDING_ARTIFACT,
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

describe("evaluateEvidence — additional shape coverage (review-driven)", () => {
  it("cms-data-op label: passes when a curl + URL is in the comment", () => {
    const result = evaluateEvidence({
      issue: {
        description: "## Done when\n- field is set",
        labels: [{ name: "cms-data-op" }],
      },
      comments: [
        agentComment("Updated. Verified:\n```\ncurl https://www.blockcast.network/api/x\n```"),
      ],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("pass");
  });

  it("cms-data-op label: blocks when no curl is mentioned", () => {
    const result = evaluateEvidence({
      issue: {
        description: "## Done when\n- field is set",
        labels: [{ name: "cms-data-op" }],
      },
      comments: [agentComment("Updated the field — trust me.")],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("block");
    expect(result.missing).toEqual(["url-probe"]);
  });

  it("detects ci-green via 'All checks have passed' string", () => {
    const customRegistry = {
      ...DEFAULT_EVIDENCE_REGISTRY,
      "pr-with-ci": { required: ["pr-link" as const, "ci-green" as const] },
    };
    const result = evaluateEvidence({
      issue: {
        description: "## Done when\n- PR green",
        labels: [{ name: "pr-with-ci" }],
      },
      comments: [
        agentComment(
          "https://github.com/Blockcast/paperclip/pull/133\n\nCI: All checks have passed",
        ),
      ],
      workProducts: [],
      registry: customRegistry,
    });
    expect(result.verdict).toBe("pass");
  });

  it("detects e2e-script via inline Playwright code in a comment", () => {
    const customRegistry = {
      ...DEFAULT_EVIDENCE_REGISTRY,
      e2e: { required: ["e2e-script" as const] },
    };
    const body = [
      "Wrote a script:",
      "```js",
      "await page.goto('https://www.blockcast.network/blog');",
      "await page.click('.blog-card');",
      "```",
    ].join("\n");
    const result = evaluateEvidence({
      issue: { description: "## Done when\n- e2e", labels: [{ name: "e2e" }] },
      comments: [agentComment(body)],
      workProducts: [],
      registry: customRegistry,
    });
    expect(result.verdict).toBe("pass");
  });

  it("does NOT count e2e-run when result is 'fail'", () => {
    const customRegistry = {
      ...DEFAULT_EVIDENCE_REGISTRY,
      "e2e-strict": { required: ["e2e-run" as const] },
    };
    const result = evaluateEvidence({
      issue: { description: "## Done when\n- e2e", labels: [{ name: "e2e-strict" }] },
      comments: [agentComment("Ran the script.")],
      workProducts: [
        { kind: "e2e-run", result: "fail", metadata: null },
      ] as EvidenceWorkProductLite[],
      registry: customRegistry,
    });
    expect(result.verdict).toBe("block");
    expect(result.missing).toEqual(["e2e-run"]);
  });

  it("recentCommentLimit: 0 yields empty text and blocks on labeled issues", () => {
    const result = evaluateEvidence({
      issue: { description: FRONTEND_DONE_WHEN, labels: [{ name: "frontend" }] },
      comments: [agentComment("![](./shot_1440x900.png)\n![](./shot_390x844.png)")],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
      recentCommentLimit: 0,
    });
    expect(result.verdict).toBe("block");
  });

  it("empty comments array blocks on labeled frontend issue", () => {
    const result = evaluateEvidence({
      issue: { description: FRONTEND_DONE_WHEN, labels: [{ name: "frontend" }] },
      comments: [],
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
  });

  it("multi-label union: a frontend + backend + pr issue must satisfy ALL", () => {
    // Partial coverage: has screenshots + PR link, but missing test-output.
    const body = [
      "![desktop](./blog_entry_desktop_1440x900.png)",
      "![mobile](./blog_entry_mobile_390x844.png)",
      "PR: https://github.com/Blockcast/paperclip/pull/133",
      "",
      "| Item | Status |",
      "|---|---|",
      "| a | ✅ |",
      "| b | ✅ |",
      "| c | ✅ |",
    ].join("\n");
    const result = evaluateEvidence({
      issue: {
        description: "## Done when\n- ui works\n- tests pass\n- pr open",
        labels: [{ name: "frontend" }, { name: "backend" }, { name: "pr" }],
      },
      comments: [agentComment(body)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("block");
    expect(result.missing).toEqual(["test-output"]);
  });

  it("NaN createdAt sorts to bottom deterministically and does not reorder valid comments", () => {
    // Per silent-failure review: a single malformed timestamp must not silently
    // re-order the sort and push real evidence outside the recent-comment
    // window. With limit=2, the two valid recent comments should both survive,
    // and the malformed-timestamp comment is sorted to the bottom.
    const evidence = agentComment(
      [
        "![desktop](./shot_1440x900.png)",
        "![mobile](./shot_390x844.png)",
        LANDING_ARTIFACT,
        "| C | S |",
        "|---|---|",
        "| entry | ✅ |",
        "| listing | ✅ |",
        "| footer | ✅ |",
      ].join("\n"),
      "2026-05-11T20:00:00Z",
    );
    const bogus = agentComment("nothing", "not-a-date");
    const stale = agentComment("old", "2024-01-01T00:00:00Z");
    const result = evaluateEvidence({
      issue: { description: FRONTEND_DONE_WHEN, labels: [{ name: "frontend" }] },
      comments: [bogus, evidence, stale],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
      recentCommentLimit: 2,
    });
    // The two most-recent valid comments survive: `evidence` (2026) and
    // `stale` (2024). `bogus` (NaN) sorts to the bottom and is sliced out.
    expect(result.verdict).toBe("pass");
  });

  it("blocks prose-only viewport claims without an image filename", () => {
    // Documents intentional Phase-1 leniency: a comment mentioning
    // "screenshot 1440x900" without an actual image satisfies the inline
    // detector. The gate is shape-only in Phase 1; QA Engineer (BLO-4827)
    // re-runs the artifact in their own context to catch fakery. When
    // BLO-4828 ships Phase-2 enforcement, this test should be FLIPPED to
    // `expect("block")` after tightening detectScreenshotViewport's
    // looseFilename branch (per code-reviewer M1 + test-analyzer #7).
    const body = "I'll add a screenshot at 1440x900 and 390x844 later.\n" +
      "| C | S |\n|---|---|\n| a | ✅ |\n| b | ✅ |\n| c | ✅ |";
    const result = evaluateEvidence({
      issue: { description: FRONTEND_DONE_WHEN, labels: [{ name: "frontend" }] },
      comments: [agentComment(body)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("block");
  });

  it("blocks CI-green prose without an allowlisted PR link", () => {
    // Documents intentional Phase-1 leniency: "TODO: make sure CI green" or
    // similar prose satisfies the detector. Phase-2 (BLO-4828) tightens this
    // to require co-occurrence with a PR link or a status URL. Flip this
    // expectation when that lands.
    const customRegistry = {
      ...DEFAULT_EVIDENCE_REGISTRY,
      "ci-only": { required: ["ci-green" as const] },
    };
    const result = evaluateEvidence({
      issue: { description: "## Done when\n- ci green", labels: [{ name: "ci-only" }] },
      comments: [agentComment("Working on the fix — need to verify CI green before merge.")],
      workProducts: [],
      registry: customRegistry,
    });
    expect(result.verdict).toBe("block");
  });

  it("does not count incomplete checkboxes or bare pass/fail words", () => {
    const result = evaluateEvidence({
      issue: { description: "## Done when\n- one\n- two", labels: [{ name: "checklist" }] },
      comments: [agentComment("- [ ] one\n- [ ] two\n\n| one | pass |\n| two | fail |")],
      workProducts: [],
      registry: { checklist: { required: ["checklist:done-when"] } },
    });
    expect(result.verdict).toBe("block");
  });

  it("reports required and all detected shapes separately", () => {
    const result = evaluateEvidence({
      issue: { description: "## Done when\n- PR opened", labels: [{ name: "pr" }] },
      comments: [agentComment("https://github.com/Blockcast/paperclip/pull/132\nTest Files 1 passed")],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.requiredFound).toEqual(["pr-link"]);
    expect(result.evidenceFound).toEqual(result.requiredFound);
    expect(result.allDetected).toEqual(expect.arrayContaining(["pr-link", "test-output"]));
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
        "landing-artifact",
        "migration-output",
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

describe("evaluateEvidence — db-migration label", () => {
  it("passes when an EXPLAIN ANALYZE plan is pasted in the comment", () => {
    const body = [
      "Applied migration 0088_add_index_on_issue_events.sql.",
      "",
      "EXPLAIN ANALYZE:",
      "```",
      "Index Scan on issue_events  (cost=0.56..8.58 rows=1 width=32)",
      "  Index Cond: (issue_id = $1)",
      "Planning Time: 0.123 ms",
      "Execution Time: 0.045 ms",
      "```",
      LANDING_ARTIFACT,
    ].join("\n");
    const result = evaluateEvidence({
      issue: {
        description: "## Done when\n- index exists\n- no seq scan",
        labels: [{ name: "db-migration" }],
      },
      comments: [agentComment(body)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("pass");
    expect(result.missing).toEqual([]);
    expect(result.evidenceFound).toContain("migration-output");
  });

  it("passes for the 'migration' label alias", () => {
    const body = `Applied 1 migration successfully.\n\n(5 rows)\n${LANDING_ARTIFACT}`;
    const result = evaluateEvidence({
      issue: {
        description: "## Done when\n- migration applied",
        labels: [{ name: "migration" }],
      },
      comments: [agentComment(body)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("pass");
  });

  it("passes when drizzle-kit push output is pasted", () => {
    const body = [
      "Ran schema push:",
      "```",
      "drizzle-kit: push completed",
      "✓ done",
      "```",
      LANDING_ARTIFACT,
    ].join("\n");
    const result = evaluateEvidence({
      issue: {
        description: "## Done when\n- schema updated",
        labels: [{ name: "db-migration" }],
      },
      comments: [agentComment(body)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("pass");
  });

  it("passes when a psql row-count line is paired with migration runner output", () => {
    const body = [
      "Applied 1 migration successfully.",
      "",
      "Post-migration row count check:",
      "```sql",
      "SELECT COUNT(*) FROM issue_events;",
      " count",
      "-------",
      " 98432",
      "(1 row)",
      "```",
      LANDING_ARTIFACT,
    ].join("\n");
    const result = evaluateEvidence({
      issue: {
        description: "## Done when\n- row count verified",
        labels: [{ name: "db-migration" }],
      },
      comments: [agentComment(body)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("pass");
  });

  it("blocks when agent comment contains only a SELECT row-count with no migration runner output", () => {
    const result = evaluateEvidence({
      issue: {
        description: "## Done when\n- migration applied",
        labels: [{ name: "db-migration" }],
      },
      comments: [
        agentComment(
          `Verified table exists.\n\nSELECT COUNT(*) FROM foo;\n(7 rows)\n${LANDING_ARTIFACT}`,
        ),
      ],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("block");
    expect(result.missing).toEqual(["migration-output"]);
  });

  it("blocks when agent only pastes raw migration SQL", () => {
    const body = [
      "Migration file content:",
      "```sql",
      "ALTER TABLE issues ADD COLUMN last_evidence_verdict jsonb;",
      "CREATE INDEX issue_events_issue_id_idx ON issue_events(issue_id);",
      "```",
      LANDING_ARTIFACT,
    ].join("\n");
    const result = evaluateEvidence({
      issue: {
        description: "## Done when\n- migration applied",
        labels: [{ name: "db-migration" }],
      },
      comments: [agentComment(body)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("block");
    expect(result.missing).toEqual(["migration-output"]);
  });

  it("blocks when agent only claims the migration ran with no observable output", () => {
    const result = evaluateEvidence({
      issue: {
        description: "## Done when\n- migration applied",
        labels: [{ name: "db-migration" }],
      },
      comments: [agentComment(`Migration ran successfully — trust me.\n${LANDING_ARTIFACT}`)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("block");
    expect(result.missing).toEqual(["migration-output"]);
  });

  it("blocks when migration output is in an operator comment (not agent-authored)", () => {
    const body = "Applied 1 migration.\n\nSELECT COUNT(*): (42 rows)";
    const result = evaluateEvidence({
      issue: {
        description: "## Done when\n- migration applied",
        labels: [{ name: "db-migration" }],
      },
      comments: [operatorComment(body)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("block");
  });

  it("resolveRequiredShapes: db-migration label returns migration and artifact requirements", () => {
    const { required, unlabeledFallback } = resolveRequiredShapes(
      { labels: [{ name: "db-migration" }] },
      DEFAULT_EVIDENCE_REGISTRY,
    );
    expect(unlabeledFallback).toBe(false);
    expect(required).toEqual(["migration-output", "landing-artifact"]);
  });
});

describe("countDoneWhenBullets — criteria heading synonyms (BLO-19047)", () => {
  it("counts bullets under the historical `## Done when` heading", () => {
    expect(countDoneWhenBullets("## Done when\n- a\n- b")).toBe(2);
  });

  it.each([
    "Acceptance criteria",
    "acceptance criteria",
    "ACCEPTANCE CRITERIA",
    "Success criteria",
    "Exit criteria",
  ])("counts bullets under `## %s`", (heading) => {
    expect(countDoneWhenBullets(`## ${heading}\n- a\n- b\n- c`)).toBe(3);
  });

  it("matches at any heading depth", () => {
    expect(countDoneWhenBullets("#### Acceptance criteria\n- a")).toBe(1);
  });

  it("stops at the next heading so later bullets are not counted", () => {
    const description =
      "## Acceptance criteria\n- a\n- b\n\n## Verifying signal\n- ci job\n- dashboard";
    expect(countDoneWhenBullets(description)).toBe(2);
  });

  it("does not match an unrecognized heading", () => {
    expect(countDoneWhenBullets("## Definition of done\n- a\n- b")).toBe(0);
    expect(countDoneWhenBullets("## AC\n- a\n- b")).toBe(0);
  });

  it("does not match a bolded pseudo-heading", () => {
    expect(countDoneWhenBullets("**Acceptance criteria**\n- a\n- b")).toBe(0);
  });

  it("does not match the phrase in prose", () => {
    expect(countDoneWhenBullets("We agreed on acceptance criteria below.\n- a")).toBe(0);
  });
});

describe("evaluateEvidence — criteria heading synonyms (BLO-19047)", () => {
  // Regression for the exact BLO-18833 shape: a description written to the
  // company issue-creation policy (which mandates `## Acceptance criteria`)
  // plus a matching marker table. Before the synonym fix this was a permanent
  // `warn` on an unlabeled issue and a permanent 422 `block` on a labeled one,
  // satisfiable by no comment the agent could post.
  const ACCEPTANCE_CRITERIA = [
    "## Acceptance criteria",
    "- cards drop the h-100 dead space",
    "- the lone odd card no longer overlaps page decoration",
    "- grid reflows at 390px",
    "- no visual regression at 1440px",
  ].join("\n");

  const MARKER_TABLE = [
    "| Criterion | Status | Evidence |",
    "|---|---|---|",
    "| h-100 dead space gone | ✅ | screenshot |",
    "| odd card no overlap | ✅ | screenshot |",
    "| reflows at 390px | ✅ | screenshot |",
    "| no 1440px regression | ✅ | screenshot |",
  ].join("\n");

  it("passes an unlabeled issue whose criteria use `## Acceptance criteria`", () => {
    const result = evaluateEvidence({
      issue: { description: ACCEPTANCE_CRITERIA, labels: [] },
      comments: [agentComment(MARKER_TABLE)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    // `checklist:done-when` is the whole unlabeled required set, so detecting
    // it clears the verdict outright. This is the BLO-18833 case: previously a
    // permanent `warn` that no comment could clear.
    expect(result.verdict).toBe("pass");
    expect(result.missing).toEqual([]);
    expect(result.evidenceFound).toContain("checklist:done-when");
    expect(result.diagnostics).not.toContain("no-done-when-heading");
  });

  it("satisfies checklist:done-when for a labeled issue using `## Acceptance criteria`", () => {
    const result = evaluateEvidence({
      issue: {
        description: ACCEPTANCE_CRITERIA,
        labels: [{ name: "backend" }],
      },
      comments: [
        agentComment(`Test Files  3 passed (3)\n${LANDING_ARTIFACT}\n\n${MARKER_TABLE}`),
      ],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("pass");
    expect(result.missing).toEqual([]);
    expect(result.evidenceFound).toContain("checklist:done-when");
  });

  it("still requires one marker row per criterion under a synonym heading", () => {
    const shortTable = [
      "| Criterion | Status |",
      "|---|---|",
      "| h-100 dead space gone | ✅ |",
    ].join("\n");
    const result = evaluateEvidence({
      issue: { description: ACCEPTANCE_CRITERIA, labels: [] },
      comments: [agentComment(shortTable)],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.missing).toEqual(["checklist:done-when"]);
  });
});

describe("evaluateEvidence — no-done-when-heading diagnostic (BLO-19047)", () => {
  it("names the description as the remedy when the heading is unrecognized", () => {
    const result = evaluateEvidence({
      issue: { description: "## Definition of done\n- a\n- b", labels: [] },
      comments: [agentComment("done")],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.missing).toEqual(["checklist:done-when"]);
    expect(result.diagnostics).toContain("no-done-when-heading");
    expect(result.diagnostics).toContain("missing-done-when-bullets");
  });

  it("emits missing-description (not no-done-when-heading) when there is no description", () => {
    const result = evaluateEvidence({
      issue: { description: null, labels: [] },
      comments: [agentComment("done")],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.diagnostics).toContain("missing-description");
    expect(result.diagnostics).not.toContain("no-done-when-heading");
  });

  it("omits the diagnostic once a recognized heading is present", () => {
    const result = evaluateEvidence({
      issue: { description: "## Success criteria\n- a", labels: [] },
      comments: [agentComment("| x | ✅ |")],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.diagnostics).not.toContain("no-done-when-heading");
    expect(result.diagnostics).not.toContain("missing-done-when-bullets");
  });

  it("does not turn an unrecognized heading into a bypass for a labeled issue", () => {
    // The shape stays REQUIRED when it cannot be evaluated — renaming a
    // heading to something the gate ignores must not weaken the gate.
    const result = evaluateEvidence({
      issue: {
        description: "## Definition of done\n- a",
        labels: [{ name: "backend" }],
      },
      comments: [
        agentComment(`Test Files  3 passed (3)\n${LANDING_ARTIFACT}\n| x | ✅ |`),
      ],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.verdict).toBe("block");
    expect(result.missing).toEqual(["checklist:done-when"]);
  });
});

// Regressions found by adversarial review of the BLO-19047 fix. Each of these
// failed on the first cut of the synonym change.
describe("countDoneWhenBullets — review regressions (BLO-19047)", () => {
  it("uses the first section that HAS bullets, not merely the first heading", () => {
    // A pointer section preceding the real list: anchoring on the first
    // heading counted 0 and made the shape unsatisfiable.
    const description = [
      "## Summary",
      "fix the thing",
      "",
      "## Acceptance criteria",
      "",
      "See the Done when list below.",
      "",
      "## Done when",
      "- a",
      "- b",
    ].join("\n");
    expect(countDoneWhenBullets(description)).toBe(2);
  });

  it("does not report a pointer-section edit as removed bullets", () => {
    // The `doneWhenBulletsRemoved` tamper signal compares prior vs current
    // counts; a policy-aligned edit must not read as gate-dodging.
    const before = "## Done when\n- a\n- b";
    const after = "## Acceptance criteria\n\nSee below.\n\n## Done when\n- a\n- b";
    expect(countDoneWhenBullets(before)).toBe(2);
    expect(countDoneWhenBullets(after)).toBe(2);
  });

  it("ignores criteria headings inside fenced code blocks", () => {
    const description = [
      "## Context",
      "Template we follow:",
      "",
      "```markdown",
      "## Acceptance criteria",
      "- [ ] one",
      "- [ ] two",
      "- [ ] three",
      "- [ ] four",
      "- [ ] five",
      "```",
      "",
      "## Done when",
      "- real one",
      "- real two",
    ].join("\n");
    expect(countDoneWhenBullets(description)).toBe(2);
  });

  it("ignores a tilde-fenced block too", () => {
    const description = "~~~\n## Acceptance criteria\n- fake\n~~~\n\n## Done when\n- real";
    expect(countDoneWhenBullets(description)).toBe(1);
  });

  it("keeps sub-grouped criteria inside the section", () => {
    const description = [
      "## Acceptance criteria",
      "",
      "### Functional",
      "- a",
      "- b",
      "",
      "### Non-functional",
      "- c",
      "",
      "## Verifying signal",
      "- ci job",
    ].join("\n");
    expect(countDoneWhenBullets(description)).toBe(3);
  });

  it("stops at a shallower heading", () => {
    const description = "## Acceptance criteria\n- a\n- b\n\n# Appendix\n- not a criterion";
    expect(countDoneWhenBullets(description)).toBe(2);
  });

  it("accepts a single-hash H1 heading", () => {
    expect(countDoneWhenBullets("# Acceptance criteria\n- a\n- b")).toBe(2);
  });

  it("handles CRLF line endings", () => {
    expect(countDoneWhenBullets("## Acceptance criteria\r\n- a\r\n- b\r\n")).toBe(2);
  });

  it("handles bare-CR line endings", () => {
    expect(countDoneWhenBullets("## Done when\r- a\r- b\r")).toBe(2);
  });

  it("tolerates trailing punctuation and parentheticals in the heading", () => {
    expect(countDoneWhenBullets("## Acceptance criteria:\n- a")).toBe(1);
    expect(countDoneWhenBullets("## Acceptance criteria (v2)\n- a\n- b")).toBe(2);
  });

  it("returns 0 for a criteria heading on the final line with no body", () => {
    expect(countDoneWhenBullets("## Goal\nx\n\n## Acceptance criteria")).toBe(0);
  });

  it("does not let the heading gap span a newline", () => {
    expect(
      countDoneWhenBullets("##\n\nAcceptance criteria are tracked elsewhere:\n- doc1\n- doc2"),
    ).toBe(0);
  });
});

describe("hasDoneWhenHeading (BLO-19047)", () => {
  it("is true for each recognized synonym", () => {
    for (const heading of ["Done when", "Acceptance criteria", "Success criteria", "Exit criteria"]) {
      expect(hasDoneWhenHeading(`## ${heading}\n- a`)).toBe(true);
    }
  });

  it("is false for an unrecognized heading", () => {
    expect(hasDoneWhenHeading("## Definition of done\n- a")).toBe(false);
  });

  it("is false when the only match is inside a fence", () => {
    expect(hasDoneWhenHeading("```\n## Acceptance criteria\n- a\n```")).toBe(false);
  });

  it("is true even when the section carries no bullets", () => {
    expect(hasDoneWhenHeading("## Acceptance criteria\n\nprose only")).toBe(true);
  });
});

describe("evaluateEvidence — no-done-when-heading accuracy (BLO-19047)", () => {
  it("does NOT claim a missing heading when the heading exists but bullets were not found", () => {
    // Criteria expressed as a table under a recognized heading: the counter
    // finds no bullets, but telling the agent to rename the heading is wrong.
    const description = [
      "## Acceptance criteria",
      "",
      "| Criterion | Notes |",
      "|---|---|",
      "| a | x |",
    ].join("\n");
    const result = evaluateEvidence({
      issue: { description, labels: [] },
      comments: [agentComment("done")],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.diagnostics).toContain("missing-done-when-bullets");
    expect(result.diagnostics).not.toContain("no-done-when-heading");
  });

  it("still claims a missing heading when none is recognized", () => {
    const result = evaluateEvidence({
      issue: { description: "## Definition of done\n- a", labels: [] },
      comments: [agentComment("done")],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });
    expect(result.diagnostics).toContain("no-done-when-heading");
  });
});
