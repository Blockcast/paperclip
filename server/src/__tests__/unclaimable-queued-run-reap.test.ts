import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS } from "../services/issue-tree-control.js";
import {
  BRANCH_CLAIM_RETRY_AT_CONTEXT_KEY,
  classifyQueuedRunForDependencyReap,
  isRunClaimable,
  K8S_ISOLATION_RETRY_AT_CONTEXT_KEY,
} from "../services/dispatch-readiness.js";

/**
 * PEN-4385 — the out-of-band reap of dependency-blocked `queued` runs.
 *
 * Covers the two properties that are decidable without a database:
 *
 *   1. WHICH rows the sweep is allowed to destroy, exhaustively over the
 *      predicate's whole input space (the `describe` blocks below); and
 *   2. that the sweep reaches that verdict by CALLING the dispatcher's
 *      predicate rather than restating any part of it (the static guard at the
 *      bottom).
 *
 * (2) is not decoration. `isEffectivelyDependencyReadyForDispatch` exists
 * because BLO-21792 leaks 2-5 and BLO-22091 were each a site re-deriving this
 * verdict slightly differently, and PEN-4280 found a fourth. This sweep is the
 * first reader whose verdict CANCELS a run rather than ranking or counting it,
 * so a re-derivation that drifted permissive here destroys dispatchable work
 * instead of mis-sorting it.
 *
 * The end-to-end behaviour — a blocked row actually leaving `status='queued'`
 * without a claim, and the assignee still being woken when the blockers clear —
 * is pinned against a real database in
 * `unclaimable-queued-run-reap-postgres.test.ts`.
 */

const READY = { isDependencyReady: true };
const BLOCKED = { isDependencyReady: false };
const OPEN_ISSUE = { status: "in_progress" };
const NOW = new Date("2026-10-20T00:00:00.000Z");
const FUTURE = new Date(NOW.getTime() + 60_000).toISOString();
const PAST = new Date(NOW.getTime() - 60_000).toISOString();

/**
 * A wake that the claim path deliberately lets run on a blocked issue: an
 * issue-interaction wake carrying the comment id of the thing a human said.
 *
 * The reason is asserted to be a real member of
 * ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS rather than written as a literal
 * and trusted. A reason OUTSIDE that set is simply not exempt, so a stale
 * literal here would not fail — it would silently turn every exemption test
 * into another assertion that an ordinary blocked run gets reaped, and the one
 * case with a person waiting on it would go uncovered.
 */
const INTERACTION_WAKE_REASON = "issue_commented";
const INTERACTION_WAKE = {
  wakeReason: INTERACTION_WAKE_REASON,
  wakeCommentId: "6f1b7a3e-6a1f-4a2b-8a7d-2f0c1d9e4b55",
};
const NON_INTERACTION_WAKE_REASON = "issue_assigned";

describe("classifyQueuedRunForDependencyReap — what the sweep may destroy", () => {
  it("uses wake reasons that actually are (and are not) issue-interaction wakes", () => {
    expect(ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS.has(INTERACTION_WAKE_REASON)).toBe(true);
    expect(ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS.has(NON_INTERACTION_WAKE_REASON)).toBe(false);
  });

  it("reaps a queued run whose issue has unresolved blockers", () => {
    expect(classifyQueuedRunForDependencyReap({}, OPEN_ISSUE, BLOCKED, NOW)).toEqual({
      reap: true,
      reason: "dependency_blocked",
    });
  });

  it("never reaps a dependency-ready run", () => {
    expect(classifyQueuedRunForDependencyReap({}, OPEN_ISSUE, READY, NOW)).toEqual({
      reap: false,
      reason: "claimable",
    });
  });

  it("treats absent readiness as ready, matching the claim path's own default", () => {
    // `listDependencyReadiness` returns no entry for an issue with no blocker
    // rows at all. Reading that as "blocked" would reap every run on every
    // unblocked issue — the catastrophic direction of this change.
    expect(classifyQueuedRunForDependencyReap({}, OPEN_ISSUE, null, NOW)).toEqual({
      reap: false,
      reason: "claimable",
    });
  });

  describe("the issue-interaction-wake exemption is preserved", () => {
    it("spares a blocked run whose wake carries a comment id", () => {
      // The one case in this whole population with a person waiting on it: a
      // human commented on a blocked issue and is owed a reply from its
      // assignee. `claimQueuedRun` lets this run; so must the sweep.
      expect(
        classifyQueuedRunForDependencyReap(INTERACTION_WAKE, OPEN_ISSUE, BLOCKED, NOW),
      ).toEqual({ reap: false, reason: "claimable" });
    });

    it("does not extend the exemption to an interaction wake with no comment id", () => {
      // The comment id IS the exemption's evidence — without one there is no
      // human utterance to answer, so the row is an ordinary blocked run.
      expect(
        classifyQueuedRunForDependencyReap(
          { wakeReason: INTERACTION_WAKE_REASON },
          OPEN_ISSUE,
          BLOCKED,
          NOW,
        ),
      ).toEqual({ reap: true, reason: "dependency_blocked" });
    });

    it("does not extend the exemption to a non-interaction wake reason", () => {
      expect(
        classifyQueuedRunForDependencyReap(
          { wakeReason: NON_INTERACTION_WAKE_REASON, wakeCommentId: INTERACTION_WAKE.wakeCommentId },
          OPEN_ISSUE,
          BLOCKED,
          NOW,
        ),
      ).toEqual({ reap: true, reason: "dependency_blocked" });
    });
  });

  describe("populations that belong to someone else", () => {
    it.each(["done", "cancelled"])("leaves a %s issue's run to the staleness path", (status) => {
      // `evaluateQueuedRunStaleness` owns terminal issues and is
      // resume-intent-aware: it deliberately keeps a wake-comment-carrying row
      // alive against a done issue so a comment can reopen it. This classifier
      // cannot see that intent, so reaping here would kill rows that are
      // legitimately waiting to be reopened.
      expect(classifyQueuedRunForDependencyReap({}, { status }, BLOCKED, NOW)).toEqual({
        reap: false,
        reason: "terminal_issue",
      });
    });

    it("leaves a run whose issue could not be read", () => {
      expect(classifyQueuedRunForDependencyReap({}, null, BLOCKED, NOW)).toEqual({
        reap: false,
        reason: "issue_missing",
      });
    });

    it.each([
      ["k8s isolation", K8S_ISOLATION_RETRY_AT_CONTEXT_KEY],
      ["branch claim", BRANCH_CLAIM_RETRY_AT_CONTEXT_KEY],
    ])("leaves a %s retry sitting out its own backoff", (_label, key) => {
      // Unclaimable on purpose and bounded by its own timestamp: the stamp
      // clears itself. Cancelling it would destroy a run that is behaving
      // exactly as designed.
      expect(
        classifyQueuedRunForDependencyReap({ [key]: FUTURE }, OPEN_ISSUE, READY, NOW),
      ).toEqual({ reap: false, reason: "admission_deferred" });
    });

    it("re-admits a retry whose backoff stamp has lapsed", () => {
      expect(
        classifyQueuedRunForDependencyReap(
          { [K8S_ISOLATION_RETRY_AT_CONTEXT_KEY]: PAST },
          OPEN_ISSUE,
          READY,
          NOW,
        ),
      ).toEqual({ reap: false, reason: "claimable" });
    });

    it("still reaps a row that is BOTH admission-deferred and dependency-blocked", () => {
      // The backoff bounds itself; the blockers do not. Deferring to the stamp
      // here would leave the unbounded wait in place behind a bounded one.
      expect(
        classifyQueuedRunForDependencyReap(
          { [K8S_ISOLATION_RETRY_AT_CONTEXT_KEY]: FUTURE },
          OPEN_ISSUE,
          BLOCKED,
          NOW,
        ),
      ).toEqual({ reap: true, reason: "dependency_blocked" });
    });
  });
});

describe("the reap is gated on isRunClaimable, not on a local copy of it", () => {
  it("never reaps a row the dispatcher could claim, over the whole input space", () => {
    // The safety interlock, proven exhaustively rather than by example: for
    // every combination of the inputs the predicate reads, `reap: true` implies
    // `isRunClaimable` is false. This is the property that must survive any
    // future edit to either function — if someone widens the reap's own reason
    // screen, this fails before the widening can cancel dispatchable work.
    const issues = [null, { status: "todo" }, { status: "in_progress" }, { status: "done" }, { status: "cancelled" }];
    const readinesses = [null, READY, BLOCKED];
    const contexts = [
      {},
      INTERACTION_WAKE,
      { wakeReason: INTERACTION_WAKE_REASON },
      { [K8S_ISOLATION_RETRY_AT_CONTEXT_KEY]: FUTURE },
      { [BRANCH_CLAIM_RETRY_AT_CONTEXT_KEY]: FUTURE },
      { [K8S_ISOLATION_RETRY_AT_CONTEXT_KEY]: PAST },
      { ...INTERACTION_WAKE, [K8S_ISOLATION_RETRY_AT_CONTEXT_KEY]: FUTURE },
    ];

    let reapedAtLeastOne = false;
    for (const issue of issues) {
      for (const readiness of readinesses) {
        for (const context of contexts) {
          const verdict = classifyQueuedRunForDependencyReap(context, issue, readiness, NOW);
          const claimable = isRunClaimable(context, issue, readiness, NOW);
          if (verdict.reap) {
            reapedAtLeastOne = true;
            expect({ context, issue, readiness, claimable }).toMatchObject({ claimable: false });
          }
          if (claimable) expect(verdict).toEqual({ reap: false, reason: "claimable" });
        }
      }
    }
    // Guards the vacuous pass: a classifier that reaped nothing would satisfy
    // every assertion above.
    expect(reapedAtLeastOne).toBe(true);
  });
});

const SERVICES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "services");

function readSource(file: string): string {
  return readFileSync(join(SERVICES_DIR, file), "utf8");
}

/** The body of `reapUnclaimableQueuedRuns`, from its signature to the next sibling. */
function reapFunctionBody(): string {
  const source = readSource("heartbeat.ts");
  const start = source.indexOf("async function reapUnclaimableQueuedRuns(");
  expect(start, "reapUnclaimableQueuedRuns not found in heartbeat.ts").toBeGreaterThan(-1);
  const end = source.indexOf("\n  /**", start);
  expect(end, "could not find the end of reapUnclaimableQueuedRuns").toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("static guard: no part of the claimability predicate is re-derived", () => {
  it("routes the sweep's verdict through classifyQueuedRunForDependencyReap", () => {
    expect(reapFunctionBody()).toContain("classifyQueuedRunForDependencyReap(");
  });

  // Each token is a PIECE of the predicate. Reaching for any of them inside the
  // sweep means it has started deciding claimability for itself, which is the
  // bug class BLO-22091 centralized the predicate to end.
  it.each([
    ["the terminal-issue screen", "TERMINAL_ISSUE_STATUSES"],
    ["the dependency conjunct", "isDependencyReady"],
    ["the admission-backoff screen", "isQueuedRunAdmissionDeferred"],
    ["the k8s-isolation stamp", "isK8sIsolationRetryDeferred"],
    ["the branch-claim stamp", "isBranchClaimRetryDeferred"],
    ["the k8s-isolation context key", "K8S_ISOLATION_RETRY_AT_CONTEXT_KEY"],
    ["the branch-claim context key", "BRANCH_CLAIM_RETRY_AT_CONTEXT_KEY"],
    ["the interaction-wake exemption", "allowsIssueInteractionWake"],
    ["the wake-reason screen", "wakeReason"],
  ])("does not restate %s", (_label, token) => {
    expect(reapFunctionBody()).not.toContain(token);
  });

  it("keeps isRunClaimable as the classifier's first and binding screen", () => {
    // Called whole and FIRST: every later arm only splits the already-
    // unclaimable remainder by cause. If this call were moved after another
    // screen, that screen would be deciding the fate of claimable rows.
    const source = readSource("dispatch-readiness.ts");
    const signatureEnd = "): QueuedRunDependencyReapVerdict {";
    const start = source.indexOf("export function classifyQueuedRunForDependencyReap(");
    expect(start, "classifyQueuedRunForDependencyReap not found").toBeGreaterThan(-1);
    const bodyStart = source.indexOf(signatureEnd, start);
    expect(bodyStart, "classifier signature changed shape").toBeGreaterThan(start);
    const firstStatement = source.slice(bodyStart + signatureEnd.length).trimStart();
    expect(firstStatement.startsWith("if (isRunClaimable(contextSnapshot, issue, readiness, now))")).toBe(true);
  });

  it("defines isRunClaimable and the terminal-status set exactly once, in the leaf module", () => {
    // `heartbeat.ts` used to own both. They moved so the sweep could hold them
    // without importing the ~40k-line run lifecycle — a move that is only worth
    // anything if no copy stayed behind.
    const heartbeat = readSource("heartbeat.ts");
    const leaf = readSource("dispatch-readiness.ts");
    expect(heartbeat).not.toContain("function isRunClaimable(");
    expect(heartbeat).not.toContain('TERMINAL_ISSUE_STATUSES = new Set(');
    expect(leaf.match(/export function isRunClaimable\(/g)).toHaveLength(1);
    expect(leaf.match(/export const TERMINAL_ISSUE_STATUSES/g)).toHaveLength(1);
  });
});
