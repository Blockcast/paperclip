import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyWorkspaceReuseRefusal,
  formatGitProbeRefusal,
  formatOriginMismatchRefusal,
  REUSE_FAILURE_HEADLINE,
  WORKSPACE_REUSE_REFUSAL_CLASSES,
} from "./workspace-reuse-refusal-class.js";

/**
 * PEN-3633 item 3. The aggregation alert buckets on the error BODY, so every
 * assertion that matters here is a round-trip: a message built by the real
 * producer must classify back to the class the alert expects.
 *
 * Asserting against hand-written literals instead would pass forever while the
 * producers drifted away from the matcher, and the failure mode of that drift
 * is silence -- the detector would simply stop counting a live episode. These
 * tests exist to convert that silence into a red test.
 */

// The wrapper in heartbeat.ts. Rebuilt here from the exported marker rather
// than imported, because importing heartbeat.ts pulls in the kube client; the
// marker is the shared contract and `heartbeat-reuse-failure-headline.test.ts`
// upstream pins that the wrapper still uses it.
function wrapReuseFailure(cause: string | null): string {
  return cause
    ? `${REUSE_FAILURE_HEADLINE} because ${cause}.`
    : `${REUSE_FAILURE_HEADLINE}: the referenced execution workspace could not be restored, and no cause was reported (execution workspace ws-1).`;
}

describe("classifyWorkspaceReuseRefusal", () => {
  it("classifies the episode-1 origin-mismatch refusal its own producer builds", () => {
    const message = formatOriginMismatchRefusal({
      cwd: "/paperclip/instances/default/workspaces/abc",
      actualUrl: "git@github.com:Blockcast/paperclip.git",
      expectedRepoUrl: "https://github.com/Blockcast/penstock-llm-proxy-core",
    });
    expect(classifyWorkspaceReuseRefusal(message)).toBe("origin_mismatch");
  });

  it("classifies both arms of the episode-2 git-probe refusal its own producer builds", () => {
    const notACheckout = formatGitProbeRefusal({
      state: "not_a_checkout",
      cwd: "/paperclip/instances/default/workspaces/abc",
      probeReason: 'no directory exists at "/paperclip/.../abc" (path is absent or not a directory)',
    });
    expect(classifyWorkspaceReuseRefusal(notACheckout)).toBe("not_a_checkout");

    const indeterminate = formatGitProbeRefusal({
      state: "indeterminate",
      cwd: "/paperclip/instances/default/workspaces/abc",
      probeReason: "fatal: detected dubious ownership in repository",
    });
    expect(classifyWorkspaceReuseRefusal(indeterminate)).toBe("probe_indeterminate");
  });

  it("keeps git's own stderr in the refusal, which is what makes the class attributable", () => {
    // PEN-3633 item 1 stopped `isGitCheckout` discarding this. If the reason
    // stopped reaching the message, the alert would still fire but the
    // responder could no longer tell a disk fault from a pod-local one.
    const message = formatGitProbeRefusal({
      state: "indeterminate",
      cwd: "/w",
      probeReason: "fatal: detected dubious ownership in repository at '/w'",
    });
    expect(message).toContain("fatal: detected dubious ownership in repository at '/w'");
  });

  it("prefers the inner cause over the wrapper when the wrapper embeds one", () => {
    // The wrapper always embeds the inner cause, so a composed body carries
    // BOTH markers. Classifying it as `cause_unreported` would throw away the
    // only informative half and merge the two distinguishable episodes back
    // into one bucket -- the exact failure this row exists to undo.
    const composed = wrapReuseFailure(
      formatGitProbeRefusal({
        state: "not_a_checkout",
        cwd: "/w",
        probeReason: "no git directory",
      }),
    );
    expect(classifyWorkspaceReuseRefusal(composed)).toBe("not_a_checkout");
  });

  it("classifies a wrapper that reported no cause as cause_unreported", () => {
    expect(classifyWorkspaceReuseRefusal(wrapReuseFailure(null))).toBe("cause_unreported");
  });

  it("returns null for bodies outside the class, so unrelated setup_failed is not absorbed", () => {
    // Negative control. A catch-all `other` bucket would make this alert fire
    // on every unrelated setup failure in the fleet and turn a project-scoped
    // signal back into the undifferentiated one it replaced.
    for (const body of [
      null,
      undefined,
      "",
      "Error: connect ECONNREFUSED 10.0.0.1:5432",
      "adapter_failed: entitlement 403",
      "k8s_job_create_failed: BackoffLimitExceeded",
      // Near-miss: names a repo and a checkout but is not a refusal.
      'Cloned "https://github.com/Blockcast/paperclip" into a fresh checkout.',
    ]) {
      expect(classifyWorkspaceReuseRefusal(body)).toBeNull();
    }
  });

  it("holds a closed four-value vocabulary, because the other label is unbounded", () => {
    // project_workspace_id cannot be bounded, so this set is the only factor of
    // the metric's cardinality that is ours to cap. Widening it is a deliberate
    // act, not an accident.
    expect([...WORKSPACE_REUSE_REFUSAL_CLASSES]).toEqual([
      "origin_mismatch",
      "not_a_checkout",
      "probe_indeterminate",
      "cause_unreported",
    ]);
  });

  it("maps every producer output onto a member of the declared vocabulary", () => {
    const produced = [
      formatOriginMismatchRefusal({ cwd: "/w", actualUrl: "a", expectedRepoUrl: "b" }),
      formatGitProbeRefusal({ state: "not_a_checkout", cwd: "/w", probeReason: "r" }),
      formatGitProbeRefusal({ state: "indeterminate", cwd: "/w", probeReason: "r" }),
      wrapReuseFailure(null),
    ];
    const classes = produced.map((message) => classifyWorkspaceReuseRefusal(message));
    expect(classes).toEqual([...WORKSPACE_REUSE_REFUSAL_CLASSES]);
    expect(new Set(classes).size).toBe(WORKSPACE_REUSE_REFUSAL_CLASSES.length);
  });
});

describe("the real producers are wired to the shared markers", () => {
  // Without this, every assertion above could pass while the builders sat
  // unused and the live refusals carried reworded inline literals the
  // classifier no longer matches. The round-trip tests prove the builders are
  // correct; these prove the builders are what production actually calls.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const read = (file: string) => readFileSync(path.join(here, file), "utf8");

  it("workspace-runtime.ts builds both refusals through this module", () => {
    const source = read("workspace-runtime.ts");
    expect(source).toContain('from "./workspace-reuse-refusal-class.js"');
    expect(source).toContain("formatOriginMismatchRefusal({");
    expect(source).toContain("formatGitProbeRefusal({");
    // The inline literals these replaced must be gone, or a stale copy could
    // still be the one that throws.
    expect(source).not.toContain("` is checked out from `");
    expect(source).not.toContain('git rev-parse --git-dir found no git repository in "${');
    expect(source).not.toContain('git rev-parse --git-dir could not verify a checkout in "${');
  });

  it("heartbeat.ts builds the reuse-failure headline through this module", () => {
    const source = read("heartbeat.ts");
    expect(source).toContain('import { REUSE_FAILURE_HEADLINE } from "./workspace-reuse-refusal-class.js"');
    expect(source).toContain("`${REUSE_FAILURE_HEADLINE} because ${causeMessage}.`");
    // PEN-3633 item 4 put the cause on line 1 so the 240-char summarizers cannot
    // elide it. If the headline is ever rebuilt as an inline literal, that fix
    // and this detector both regress together, so pin the literal's absence.
    expect(source).not.toContain("`Inherited execution workspace reuse failed because ${");
  });
});
