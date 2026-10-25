/**
 * PEN-3314 — GC-class attribution.
 *
 * This module exists to answer one question (which class of major GC runs when
 * the V8 page pool releases), so the properties worth testing are the ones whose
 * failure would answer it *wrongly* rather than visibly:
 *
 * 1. **`flags` is a bitfield, not an enum.** A cycle can carry several bits at
 *    once. Rendering them in observation order would split one real combination
 *    across several series and make every rate read low; the order must be
 *    fixed, so `A|B` and `B|A` can never both exist.
 *
 * 2. **Cardinality is bounded on unknown input.** The whole point is a label
 *    driven by a value V8 chooses. If an unrecognised bit or kind rendered as a
 *    raw integer, a future V8 would silently turn this counter into a
 *    cardinality incident on the `/metrics` path this repo already took the DB
 *    off (BLO-33243).
 *
 * 3. **A malformed entry must not throw.** The callback runs inside a
 *    `PerformanceObserver`, where an exception does not fail a request — it
 *    escapes as an unhandled rejection and can take down the scrape this series
 *    was added to serve.
 *
 * Real garbage collection is not reliably schedulable, so entries are injected
 * through the `createObserver` seam rather than provoked; the one thing that
 * cannot be faked — that Node populates `detail.flags` at all — is asserted
 * against this process's own GC in the final case.
 */

import { PerformanceObserver, constants } from "node:perf_hooks";
import type { PerformanceEntry } from "node:perf_hooks";

import { Registry } from "prom-client";
import { describe, expect, it } from "vitest";

import {
  GC_CYCLES_METRIC,
  GC_FLAGS_NONE,
  GC_KIND_UNKNOWN,
  gcFlagsLabel,
  gcKindLabel,
  registerGcFlagsCollector,
} from "../services/gc-flags-metrics.js";

const {
  NODE_PERFORMANCE_GC_MAJOR,
  NODE_PERFORMANCE_GC_MINOR,
  NODE_PERFORMANCE_GC_FLAGS_FORCED,
  NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE,
  NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE,
} = constants;

/** Minimal stand-in for a `gc` PerformanceEntry. */
function gcEntry(kind: number | undefined, flags: number | undefined): PerformanceEntry {
  return { detail: { kind, flags } } as unknown as PerformanceEntry;
}

/**
 * Drive the collector with a fixed set of entries and return the rendered text.
 *
 * `when` selects *where in registration* the entries arrive:
 *
 * - `"after-register"` (default) feeds them once `registerGcFlagsCollector` has
 *   returned. Every statement in the function body has already run, so this
 *   cannot distinguish their order.
 * - `"during-observe"` feeds them synchronously from inside `observe()`, which
 *   the collector calls as its last act. That places observed cycles *before*
 *   anything a future edit might append after the observer is wired, which is
 *   the only way an ordering claim about the zero-init loop can be tested
 *   rather than merely asserted in a comment.
 */
async function renderAfter(
  entries: readonly PerformanceEntry[],
  when: "after-register" | "during-observe" = "after-register",
): Promise<string> {
  const registry = new Registry();
  let emit: ((e: readonly PerformanceEntry[]) => void) | undefined;
  const handle = registerGcFlagsCollector({
    registry,
    createObserver: onEntries => {
      emit = onEntries;
      return {
        observe: () => {
          if (when === "during-observe") onEntries(entries);
        },
        disconnect: () => {},
      };
    },
  });
  if (when === "after-register") emit?.(entries);
  const text = await registry.metrics();
  handle.stop();
  return text;
}

describe("gcFlagsLabel", () => {
  it("renders the no-flags cycle as a name, not an empty label", async () => {
    // Every scavenge observed in practice carries 0. An empty string here would
    // render as `flags=""`, which reads on a dashboard as "missing", not "none".
    expect(gcFlagsLabel(0)).toBe(GC_FLAGS_NONE);
    expect(gcFlagsLabel(undefined)).toBe(GC_FLAGS_NONE);
  });

  it("names the memory-reducing cycle — the bit this module exists for", () => {
    expect(gcFlagsLabel(NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE)).toBe(
      "all_available_garbage",
    );
  });

  it("joins co-occurring bits in a fixed order, so one combination is one series", () => {
    const combined =
      NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE
      | NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE
      | NODE_PERFORMANCE_GC_FLAGS_FORCED;
    // Declaration order is forced < all_available_garbage < schedule_idle, and
    // must not follow the order the bits were OR'd in above.
    expect(gcFlagsLabel(combined)).toBe("forced|all_available_garbage|schedule_idle");
  });

  it("folds unknown bits into one term instead of rendering an integer", () => {
    // Bit 1 is not a GCCallbackFlag today. If V8 starts setting it, the label
    // set must stay finite.
    expect(gcFlagsLabel(1)).toBe("other");
    expect(gcFlagsLabel(1 | NODE_PERFORMANCE_GC_FLAGS_FORCED)).toBe("forced|other");
    expect(gcFlagsLabel(1 << 20)).toBe("other");
  });

  it("treats a negative or non-finite bitfield as none rather than throwing", () => {
    expect(gcFlagsLabel(-1)).toBe(GC_FLAGS_NONE);
    expect(gcFlagsLabel(Number.NaN)).toBe(GC_FLAGS_NONE);
  });
});

describe("gcKindLabel", () => {
  it("maps the kinds prom-client already distinguishes", () => {
    expect(gcKindLabel(NODE_PERFORMANCE_GC_MAJOR)).toBe("major");
    expect(gcKindLabel(NODE_PERFORMANCE_GC_MINOR)).toBe("minor");
  });

  it("bounds an unrecognised kind", () => {
    expect(gcKindLabel(999)).toBe(GC_KIND_UNKNOWN);
    expect(gcKindLabel(undefined)).toBe(GC_KIND_UNKNOWN);
  });
});

describe("registerGcFlagsCollector", () => {
  it("publishes the measured GC classes at zero before any cycle is observed", async () => {
    // The property that makes a negative result readable. Without it, "this
    // class never ran" and "this build predates the collector" are the same
    // empty scrape — the confusion that cost PEN-3314 a source grep, a
    // merge-base and a pod inspection on 2026-10-25.
    const text = await renderAfter([]);
    expect(text).toContain(`${GC_CYCLES_METRIC}{kind="major",flags="none"} 0`);
    expect(text).toContain(`${GC_CYCLES_METRIC}{kind="major",flags="schedule_idle"} 0`);
    expect(text).toContain(`${GC_CYCLES_METRIC}{kind="minor",flags="none"} 0`);
  });

  it("does not pre-create a flag value that was measured never to fire", async () => {
    // Guards against re-introducing the refuted hypothesis: an earlier
    // revision named `all_available_garbage` as the unmapper marker, and it
    // fired 0 times in 13 natural major cycles. Pre-creating it would publish
    // a permanently-zero series that reads as a standing claim.
    //
    // Scoped to sample lines on purpose: the HELP text is prose about the
    // open question and is corrected separately (#3010), so asserting over
    // the whole rendering would couple this test to that wording.
    const text = await renderAfter([]);
    const series = text
      .split("\n")
      .filter(line => line.startsWith(`${GC_CYCLES_METRIC}{`));
    expect(series.join("\n")).not.toContain("all_available_garbage");
  });

  it("keeps the pre-created series bounded to three", async () => {
    // Zero-init is a cardinality decision as much as a readability one: the
    // flags label is a bitfield set, so pre-creating the cross-product would
    // be 4 kinds x 64 combinations.
    const text = await renderAfter([]);
    const series = text
      .split("\n")
      .filter(line => line.startsWith(`${GC_CYCLES_METRIC}{`));
    expect(series).toHaveLength(3);
  });

  it("renders one series, not two, when a pre-created class also fires", async () => {
    // ⛔ This does NOT guard "the zero-init must not reset an already-counted
    // series", which an earlier revision of this comment claimed. That bug
    // cannot exist: prom-client's counter `inc(labels, value)` is additive on
    // an existing child (`hashMap[hash].value += value`, counter.js:138-145),
    // so `inc(labels, 0)` is a no-op at any point in the sequence and can
    // never lose a count. Do not "fix" an ordering hazard that is not there.
    //
    // What IS worth guarding is label-rendering agreement between the two call
    // sites. Zero-init goes through `gcKindLabel`/`gcFlagsLabel` and so does
    // the observer; if those ever disagreed for the same cycle, the class
    // would render as two series — a permanent 0 beside the real count — and
    // the readable-negative-result property this PR adds would instead become
    // a second way to misread the scrape. The count and the series *cardinality*
    // together are the assertion; the count alone would pass with a stray
    // zero-series sitting next to it.
    //
    // Fed from inside `observe()` so the cycles genuinely arrive during
    // registration rather than after it.
    const text = await renderAfter(
      [
        gcEntry(NODE_PERFORMANCE_GC_MAJOR, NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE),
        gcEntry(NODE_PERFORMANCE_GC_MAJOR, NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE),
      ],
      "during-observe",
    );
    expect(text).toContain(
      `${GC_CYCLES_METRIC}{kind="major",flags="schedule_idle"} 2`,
    );
    // Counted over ALL series, not over lines matching this class: two series
    // for one class necessarily carry *different* label values, so a filter
    // keyed on the expected rendering can never see the stray one. The drift
    // shows up as a fourth series, beside the three that were pre-created.
    const series = text
      .split("\n")
      .filter(line => line.startsWith(`${GC_CYCLES_METRIC}{`));
    expect(series).toHaveLength(3);
  });

  it("separates a memory-reducing major from an ordinary one", async () => {
    // The discriminator PEN-3314 needs: both are kind=major, and today both
    // land in the same `nodejs_gc_duration_seconds` series.
    const text = await renderAfter([
      gcEntry(NODE_PERFORMANCE_GC_MAJOR, 0),
      gcEntry(NODE_PERFORMANCE_GC_MAJOR, 0),
      gcEntry(NODE_PERFORMANCE_GC_MAJOR, NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE),
      gcEntry(NODE_PERFORMANCE_GC_MINOR, 0),
    ]);
    expect(text).toContain(`${GC_CYCLES_METRIC}{kind="major",flags="none"} 2`);
    expect(text).toContain(
      `${GC_CYCLES_METRIC}{kind="major",flags="all_available_garbage"} 1`,
    );
    expect(text).toContain(`${GC_CYCLES_METRIC}{kind="minor",flags="none"} 1`);
  });

  it("survives a malformed entry and keeps counting the rest", async () => {
    const text = await renderAfter([
      { detail: null } as unknown as PerformanceEntry,
      {} as unknown as PerformanceEntry,
      { detail: { kind: "major", flags: "forced" } } as unknown as PerformanceEntry,
      gcEntry(NODE_PERFORMANCE_GC_MAJOR, 0),
    ]);
    // Three unreadable entries land as unknown/none rather than throwing...
    expect(text).toContain(`${GC_CYCLES_METRIC}{kind="unknown",flags="none"} 3`);
    // ...and the well-formed one is unaffected.
    expect(text).toContain(`${GC_CYCLES_METRIC}{kind="major",flags="none"} 1`);
  });

  it("stops observing after stop(), idempotently", async () => {
    const registry = new Registry();
    let disconnects = 0;
    const handle = registerGcFlagsCollector({
      registry,
      createObserver: () => ({ observe: () => {}, disconnect: () => { disconnects += 1; } }),
    });
    handle.stop();
    handle.stop();
    expect(disconnects).toBe(1);
  });

  it("observes this process's real GC entries with a populated flags field", async () => {
    // The one property the injected seam cannot prove: that Node actually
    // supplies `detail.flags`. prom-client reads `detail.kind` and drops
    // `detail.flags`, so if that field were absent or always zero this whole
    // module would be measuring nothing.
    const observed: Array<{ kind?: number; flags?: number }> = [];
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const detail = (entry as { detail?: { kind?: number; flags?: number } }).detail;
        if (detail) observed.push(detail);
      }
    });
    observer.observe({ entryTypes: ["gc"] });

    // Provoke collection. Scavenges are reliable under this churn even though a
    // major is not, which is why the assertion below is about the field being
    // present and typed — not about which kind arrived.
    let retained: number[][] = [];
    for (let i = 0; i < 80; i += 1) {
      retained.push(new Array<number>(50_000).fill(i));
      if (retained.length > 4) retained.shift();
    }
    retained = [];
    await new Promise(resolve => setTimeout(resolve, 150));
    observer.disconnect();

    expect(observed.length).toBeGreaterThan(0);
    for (const detail of observed) {
      expect(typeof detail.kind).toBe("number");
      expect(typeof detail.flags).toBe("number");
      // And every real entry must render to a bounded label.
      expect(gcFlagsLabel(detail.flags)).not.toMatch(/\d/);
    }
  });
});
