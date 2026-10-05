import { describe, expect, it } from "vitest";

import {
  RETAIN_ORIGIN_SUFFIXES,
  UNCLEANED_RETAIN_REASON,
  decodeRunAttribution,
  encodeRetainedReason,
} from "../services/execution-workspace-cleanup.js";
import { WORKTREE_RECLAIM_SAFETY_REASONS } from "../services/workspace-runtime.js";

/**
 * PEN-3692, suggested by Ally on PR #2175.
 *
 * `encodeRetainedReason` records a deferred row's ORIGIN as a suffix on its
 * retain reason (`retained_dirty_run_ended`), and `decodeRunAttribution` reads
 * it back with `endsWith`. That round trip is only unambiguous while no retain
 * reason itself ends in one of the suffixes: a safety verdict named, say,
 * `stale_unknown` would decode as origin `unknown` no matter which origin
 * actually deferred it, silently relabelling run-attributable teardown as
 * unattributed — the exact collapse the suffix mechanism exists to prevent.
 *
 * That property held by inspection when the suffixes were chosen, but nothing
 * pinned it, so the next person to add a reason had no way to find out they had
 * broken it. This is that pin. It iterates the REAL values from both modules
 * rather than a hand-maintained mirror, so a new reason is covered by existing
 * here rather than by someone remembering to update a list.
 */
describe("retain-reason origin suffixes", () => {
  /**
   * Every value that can reach `encodeRetainedReason`'s `reason` parameter.
   * Two call shapes feed it, and between them they cover exactly this set:
   * `safety.reason` (the full safety union) and `classifyRemovalProof`, which
   * returns either a safety verdict or `uncleaned`.
   */
  const retainReasons = [...WORKTREE_RECLAIM_SAFETY_REASONS, UNCLEANED_RETAIN_REASON];

  it("covers a non-empty reason domain", () => {
    // Guards the guard: an import resolving to undefined would make every
    // assertion below vacuous.
    expect(retainReasons.length).toBeGreaterThan(0);
    expect(RETAIN_ORIGIN_SUFFIXES.length).toBe(2);
  });

  it("no retain reason ends in an origin suffix", () => {
    const collisions: string[] = [];
    for (const reason of retainReasons) {
      for (const suffix of RETAIN_ORIGIN_SUFFIXES) {
        if (reason.endsWith(suffix)) {
          collisions.push(`${reason} ends in ${suffix}`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it("round-trips every reason back to the origin that deferred it", () => {
    // The property the suffix exists to provide, asserted end-to-end rather
    // than inferred from the collision check above.
    for (const reason of retainReasons) {
      for (const origin of ["run_ended", "idle_backfill", "unknown"] as const) {
        const stored = encodeRetainedReason(reason, origin);
        expect(decodeRunAttribution(stored), `${reason} @ ${origin}`).toBe(origin);
      }
    }
  });

  it("re-deferring an already-suffixed row does not stack suffixes", () => {
    for (const reason of retainReasons) {
      for (const origin of ["run_ended", "idle_backfill", "unknown"] as const) {
        const once = encodeRetainedReason(reason, origin);
        const twice = encodeRetainedReason(reason, decodeRunAttribution(once));
        expect(twice, `${reason} @ ${origin}`).toBe(once);
      }
    }
  });
});
