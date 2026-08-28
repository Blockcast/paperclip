import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * BLO-29711 AC#1. The gate's status context moved out of the `review/`
 * namespace, and the context it vacated is superseded in place rather than left
 * showing its final fail-open green forever.
 *
 * These assertions are on the deployment wiring, not the logic — the logic is
 * covered in pr-comment-review-gate{,-check}.test.ts. A typo in an env-var name
 * here does not fail any of those: the server reads an unset variable, the
 * feature is silently inert, and every test still passes. That is the same
 * "green while nothing is happening" shape this issue exists to remove, so the
 * name is pinned on both sides of the wire.
 */
const repoRoot = process.cwd();

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

const CONTEXT_ENV = "PAPERCLIP_PR_COMMENT_REVIEW_GATE_STATUS_CONTEXT";
const RETIRED_ENV = "PAPERCLIP_PR_COMMENT_REVIEW_GATE_RETIRED_STATUS_CONTEXTS";

describe("comment-review-gate deployment wiring", () => {
  it("reads both env vars under the names the chart sets", () => {
    const config = read("server/src/config.ts");

    // Both directions: the reader names them, and the chart writes them.
    expect(config).toContain(`process.env.${CONTEXT_ENV}`);
    expect(config).toContain(`process.env.${RETIRED_ENV}`);

    for (const template of ["deploy/helm/paperclip/templates/deployment-api.yaml", "deploy/helm/paperclip/templates/statefulset.yaml"]) {
      const rendered = read(template);
      expect(rendered, `${template} must set ${CONTEXT_ENV}`).toContain(`- name: ${CONTEXT_ENV}`);
      expect(rendered, `${template} must set ${RETIRED_ENV}`).toContain(`- name: ${RETIRED_ENV}`);
    }
  });

  it("publishes the Blockcast gate outside the review/ namespace", () => {
    const values = read("deploy/helm/paperclip/values.blockcast.yaml");

    // A green under `review/` reads as review evidence. This gate observes only
    // the comment surface, so "nothing attests this head" is both common and
    // legitimately green — the two cannot coexist under that namespace.
    expect(values).toContain('prCommentReviewGateStatusContext: "gate/ally-comment-findings"');
    expect(values).not.toMatch(/prCommentReviewGateStatusContext:\s*"review\//);
  });

  it("retires the context it moved off, so the stale green is superseded rather than frozen", () => {
    const values = read("deploy/helm/paperclip/values.blockcast.yaml");

    // Commit statuses cannot be deleted. Without this the pre-rename green
    // stands on every head that already carries it — 42 of 43 open
    // penstock-llm-proxy-core PRs when measured on 2026-08-22.
    expect(values).toContain('prCommentReviewGateRetiredStatusContexts: "review/ally-comment"');
  });

  it("stays inert for deployments that never opted in", () => {
    const values = read("deploy/helm/paperclip/values.yaml");

    expect(values).toContain('prCommentReviewGateStatusContext: ""');
    expect(values).toContain('prCommentReviewGateRetiredStatusContexts: ""');
  });
});
