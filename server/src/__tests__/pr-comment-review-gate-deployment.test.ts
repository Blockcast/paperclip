import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALLY_HEAD_ATTESTED_CHECK_NAME,
  allyHeadAttestedCheckSummary,
  type CommentReviewGateVerdict,
} from "../services/pr-comment-review-gate.js";

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
// Resolved from this file, not from `process.cwd()`. Vitest is invoked from the
// repo root by `pnpm test` and from `server/` by a filtered run, so a cwd-based
// root makes these assertions pass or throw ENOENT depending on how the suite
// was started — the reads must be anchored to the source tree instead.
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function read(relativePath: string): string {
  const contents = readFileSync(join(repoRoot, relativePath), "utf8");
  // An empty read would satisfy every `not.toContain` assertion below, so a
  // future path regression must fail loudly rather than vacuously pass.
  if (contents.trim().length === 0) {
    throw new Error(`${relativePath} resolved to an empty file under ${repoRoot}`);
  }
  return contents;
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

/**
 * Ally-gated heavy CI, design 4.0b. `ci/ally-head-attested` is a SCHEDULE signal:
 * it says WHEN a heavy-CI dispatcher may run a lane at a head, never WHETHER the
 * change may merge. That only holds while nothing requires it, and nothing in
 * this repo can read branch protection (the App gets 403 on it), so the claim
 * has to be pinned where this repo CAN see: the wiring that could carry the name
 * somewhere a rule might match it, and the text a reader sees on the check.
 *
 * Why requiring it would be wrong in both directions. It is `success` for a PR
 * the review gate deliberately reports `neutral` (the App-authored population,
 * BLO-34316), so a required `success` would authorize a merge the gate withheld.
 * And it is `neutral` for every head nothing attests, which includes heads that
 * are perfectly mergeable, so a required `success` would block those.
 */
describe("ci/ally-head-attested is a schedule signal, never a required context", () => {
  const SIGNAL = "ci/ally-head-attested";

  it("is the literal the dispatchers key on", () => {
    // The name is the contract with every consumer. Pinned from both sides: a
    // rename here that the dispatchers do not follow would starve heavy CI on the
    // whole App-authored population without failing anything.
    expect(ALLY_HEAD_ATTESTED_CHECK_NAME).toBe(SIGNAL);
    expect(read("server/src/services/pr-comment-review-gate.ts")).toContain(
      `ALLY_HEAD_ATTESTED_CHECK_NAME = "${SIGNAL}"`,
    );
  });

  it("is reachable from no env var, config key or chart file", () => {
    // A literal, not configuration, on purpose: a chart value that could rename
    // it could point it at a name some branch rule already requires, or at the
    // gate's own context (`prCommentReviewGateStatusContext`), which IS the name a
    // rule requires. Nothing may name it but the service.
    const config = read("server/src/config.ts");
    expect(config).not.toContain(SIGNAL);
    expect(config).not.toMatch(/HEAD_ATTESTED/i);

    const chart = "deploy/helm/paperclip";
    const files = [
      `${chart}/values.yaml`,
      `${chart}/values.blockcast.yaml`,
      ...readdirSync(join(repoRoot, chart, "templates")).map((name) => `${chart}/templates/${name}`),
    ];
    // Non-vacuous: the scan has to have covered the files that carry the gate's
    // own context, or an empty directory read would pass every assertion below.
    expect(files).toEqual(
      expect.arrayContaining([
        `${chart}/values.blockcast.yaml`,
        `${chart}/templates/deployment-api.yaml`,
        `${chart}/templates/statefulset.yaml`,
      ]),
    );

    for (const file of files) {
      const text = readFileSync(join(repoRoot, file), "utf8");
      expect(text, `${file} must not name the schedule signal`).not.toContain(SIGNAL);
      expect(text, `${file} must not carry a knob for the schedule signal`).not.toMatch(/HEAD_ATTESTED/i);
    }
  });

  it("is never mirrored onto a merge-queue ref", () => {
    // The mirror is the one writer that puts the gate's verdict on the ref a
    // merge queue evaluates, under ALLGREEN, where a required context that no
    // one writes costs a 6h `checkResponseTimeout` and an ejection. A schedule
    // signal that appeared there would be one step from being required.
    for (const file of [
      "scripts/mirror-comment-review-gate-to-merge-group.mjs",
      ".github/workflows/comment-review-gate-merge-group.yml",
    ]) {
      expect(read(file), `${file} must not name the schedule signal`).not.toContain(SIGNAL);
    }
  });

  it("keeps the attested marker out of every other module", () => {
    // `headAttested` on a verdict says a comment EXISTS that attests the head, not
    // that anyone independent of the PR author examined it (BLO-34316). Reading it
    // anywhere that decides a merge, `evidence-truth.ts` above all, would turn the
    // App-authored population's self-attestation back into review evidence. Only
    // the module that builds the verdict and publishes the signal may name it.
    const sourceRoot = join(repoRoot, "server/src");
    const readers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && entry.name !== "dist" && entry.name !== "__tests__") walk(path);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          if (readFileSync(path, "utf8").includes("headAttested")) readers.push(relative(repoRoot, path));
        }
      }
    };
    walk(sourceRoot);

    expect(readers).toEqual(["server/src/services/pr-comment-review-gate.ts"]);
  });

  it("says in the check-run summary that it is never a required context, for every verdict", () => {
    // Every outcome the gate can publish, because the sentence is for the reader
    // who lands on the check from a red PR as much as from a green one.
    const verdicts: CommentReviewGateVerdict[] = [
      { state: "success", outcome: "clean", reason: "r" },
      { state: "success", outcome: "deferred_finding", reason: "r" },
      { state: "success", outcome: "not_evaluated", reason: "r", headAttested: true },
      { state: "success", outcome: "not_evaluated", reason: "r" },
      { state: "failure", outcome: "blocking_finding", reason: "r", commentCreatedAt: "2026-10-08T10:00:00Z" },
      {
        state: "failure",
        outcome: "carried_finding",
        reason: "r",
        commentCreatedAt: "2026-10-08T10:00:00Z",
        carriedFromHeadSha: "0".repeat(40),
      },
      { state: "failure", outcome: "unreadable_verdict", reason: "r", commentCreatedAt: "2026-10-08T10:00:00Z" },
    ];

    for (const verdict of verdicts) {
      const summary = allyHeadAttestedCheckSummary(verdict, "gate/ally-comment-findings");
      expect(summary, `${verdict.outcome}`).toContain("Schedule signal only");
      expect(summary, `${verdict.outcome}`).toContain("must never be added to required contexts");
    }
  });
});
