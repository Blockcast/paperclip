import { describe, expect, it } from "vitest";
import { evaluateEvidence } from "./evidence-gate.js";
import { DEFAULT_EVIDENCE_REGISTRY } from "./evidence-shapes.js";

const DONE_WHEN_DESCRIPTION = `Implement the thing.

## Done when
- criterion one
- criterion two
`;

const CHECKLIST = `| Criterion | Status | Evidence |
|---|---|---|
| criterion one | ✅ | see above |
| criterion two | ✅ | see above |`;

const TEST_BANNER = ` ✓ src/__tests__/foo.test.ts (12 tests) 23ms

 Test Files  1 passed (1)
      Tests  12 passed (12)`;

function agentComment(body: string) {
  return {
    body,
    authorAgentId: "agent-1",
    authorUserId: null,
    createdAt: new Date("2026-07-22T00:00:00Z"),
  };
}

describe("evaluateEvidence — landing-artifact (BLO-17560)", () => {
  it("BLOCKS a backend claim with test-output + checklist but no PR/commit link (the BLO-6395 fabrication shape)", () => {
    const result = evaluateEvidence({
      issue: {
        description: DONE_WHEN_DESCRIPTION,
        labels: [{ name: "backend" }],
      },
      comments: [
        agentComment(
          `Implementation complete, unit-tested. Changed web/utils/portalCsv.ts.\n\n${TEST_BANNER}\n\n${CHECKLIST}`,
        ),
      ],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });

    expect(result.verdict).toBe("block");
    expect(result.missing).toContain("landing-artifact");
  });

  it("BLOCKS a frontend claim with screenshots + checklist but no PR/commit link (the BLO-6393 fabrication shape)", () => {
    const result = evaluateEvidence({
      issue: {
        description: DONE_WHEN_DESCRIPTION,
        labels: [{ name: "frontend" }],
      },
      comments: [
        agentComment(
          `Implementation ready. Added FleetNodeDetailContent.tsx.\n\n![desktop](./shot_1440x900.png)\n![mobile](./shot_390x844.png)\n\n${CHECKLIST}`,
        ),
      ],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });

    expect(result.verdict).toBe("block");
    expect(result.missing).toContain("landing-artifact");
  });

  it("PASSES a backend claim once a real PR link is included", () => {
    const result = evaluateEvidence({
      issue: {
        description: DONE_WHEN_DESCRIPTION,
        labels: [{ name: "backend" }],
      },
      comments: [
        agentComment(
          `Implementation complete: https://github.com/Blockcast/paperclip/pull/774\n\n${TEST_BANNER}\n\n${CHECKLIST}`,
        ),
      ],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });

    expect(result.verdict).toBe("pass");
    expect(result.missing).toEqual([]);
  });

  it("PASSES a backend claim with a commit link (no PR opened yet)", () => {
    const result = evaluateEvidence({
      issue: {
        description: DONE_WHEN_DESCRIPTION,
        labels: [{ name: "backend" }],
      },
      comments: [
        agentComment(
          `Landed directly: https://github.com/Blockcast/paperclip/commit/f64be7befb15f4919c6becb45f8642fa0c70c28f\n\n${TEST_BANNER}\n\n${CHECKLIST}`,
        ),
      ],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });

    expect(result.verdict).toBe("pass");
  });

  it("does not accept a bare short SHA mention as a landing artifact", () => {
    const result = evaluateEvidence({
      issue: {
        description: DONE_WHEN_DESCRIPTION,
        labels: [{ name: "backend" }],
      },
      comments: [
        agentComment(
          `Implementation complete, commit f64be7b.\n\n${TEST_BANNER}\n\n${CHECKLIST}`,
        ),
      ],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });

    expect(result.verdict).toBe("block");
    expect(result.missing).toContain("landing-artifact");
  });

  it("respects allowedPrRepos scoping for both PR and commit links", () => {
    const result = evaluateEvidence({
      issue: {
        description: DONE_WHEN_DESCRIPTION,
        labels: [{ name: "backend" }],
      },
      comments: [
        agentComment(
          `Implementation complete: https://github.com/some-other-org/unrelated-repo/pull/1\n\n${TEST_BANNER}\n\n${CHECKLIST}`,
        ),
      ],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
      allowedPrRepos: ["Blockcast/paperclip"],
    });

    expect(result.verdict).toBe("block");
    expect(result.missing).toContain("landing-artifact");
  });

  it("does not require landing-artifact for infra (kubectl-state stays sufficient)", () => {
    const result = evaluateEvidence({
      issue: {
        description: DONE_WHEN_DESCRIPTION,
        labels: [{ name: "infra" }],
      },
      comments: [
        agentComment(
          `Rolled out.\n\nNAME                       READY   STATUS    RESTARTS   AGE\npaperclip-0                1/1     Running   0          5m\n\n$ curl http://svc/healthz\nHTTP/1.1 200 OK\n{"status":"ok"}\n\n${CHECKLIST}`,
        ),
      ],
      workProducts: [],
      registry: DEFAULT_EVIDENCE_REGISTRY,
    });

    expect(result.verdict).toBe("pass");
  });
});
