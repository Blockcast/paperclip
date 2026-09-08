import { describe, expect, it } from "vitest";
import {
  boundHeartbeatRunEventPayloadForStorage,
  buildAdapterRunEventPayloadForPersistence,
  shouldWriteRunRuntimeStatusForEvent,
} from "../services/heartbeat.js";

/**
 * PEN-3093 item 1 -- the server side of a post-terminal lifecycle event.
 *
 * The ORDERING this guards against is proven adapter-side, in
 * `packages/adapter-utils/src/server-utils.test.ts`: "still emits kill_signal
 * when the grace SIGKILL reaches a surviving descendant" establishes that on
 * the genuine-orphan path the grace timer fires -- and emits a truthful
 * `kill_signal` -- AFTER `child.on("close")` has already resolved the run.
 * That test asserts the emit happens; it cannot assert what the server then
 * does with an event whose run has terminalized.
 *
 * This file covers exactly that: the event is kept (it is real evidence of a
 * leaked process tree, and losing it was the defect -- a truthful event that
 * failed to persist, not a false one) and it is marked, so a reader can tell it
 * apart from the live run's own stream rather than seeing an event that appears
 * to postdate the run's end. `onAdapterEvent` additionally logs a warning on
 * this path, so the case can never again be reached only via a swallowed
 * `.catch` upstream.
 */
describe("buildAdapterRunEventPayloadForPersistence", () => {
  it("leaves the payload untouched while the adapter is still live", () => {
    const payload = { stage: "first_output", stream: "stdout" };

    // Identity, not just equality: the live path must not clone or reshape the
    // payload of every ordinary adapter event.
    expect(buildAdapterRunEventPayloadForPersistence(payload, null)).toBe(payload);
  });

  it("passes an absent payload through unchanged while the adapter is live", () => {
    expect(buildAdapterRunEventPayloadForPersistence(undefined, null)).toBeUndefined();
  });

  it("marks a kill_signal that arrives after the adapter settled", () => {
    const settledAt = "2026-09-07T12:00:00.000Z";
    const payload = {
      stage: "kill_signal",
      observedAt: "2026-09-07T12:00:02.500Z",
      signal: "SIGKILL",
      elapsedMs: 62_500,
    };

    const marked = buildAdapterRunEventPayloadForPersistence(payload, settledAt);

    // The adapter's own evidence survives verbatim...
    expect(marked).toMatchObject({
      stage: "kill_signal",
      observedAt: "2026-09-07T12:00:02.500Z",
      signal: "SIGKILL",
      elapsedMs: 62_500,
    });
    // ...alongside the marker that says when the run had already settled.
    expect(marked).toMatchObject({
      postAdapterSettle: true,
      adapterSettledAt: settledAt,
    });
    // The input is not mutated in place.
    expect(payload).not.toHaveProperty("postAdapterSettle");
  });

  it("marks a post-settle event that carried no payload", () => {
    const settledAt = "2026-09-07T12:00:00.000Z";

    expect(buildAdapterRunEventPayloadForPersistence(undefined, settledAt)).toEqual({
      postAdapterSettle: true,
      adapterSettledAt: settledAt,
    });
  });

  it("does not let an adapter-supplied payload forge the marker's provenance", () => {
    const settledAt = "2026-09-07T12:00:00.000Z";

    // An adapter payload claiming it is not post-settle (or claiming a
    // different settle time) must not override the server's own observation:
    // the marker is the server's statement about its run, not the adapter's.
    const marked = buildAdapterRunEventPayloadForPersistence(
      {
        stage: "kill_signal",
        postAdapterSettle: false,
        adapterSettledAt: "1999-01-01T00:00:00.000Z",
      },
      settledAt,
    );

    expect(marked).toMatchObject({
      postAdapterSettle: true,
      adapterSettledAt: settledAt,
    });
  });

  /**
   * The marker is the *entire* justification for keeping this row rather than
   * dropping it, so it has to survive the rest of the persistence path -- not
   * just leave this function correct.
   *
   * `appendRunEvent` bounds the payload for storage after this function marks
   * it (`heartbeat.ts`: `boundHeartbeatRunEventPayloadForStorage(event.payload)`),
   * and that bounding keeps only the FIRST `MAX_RUN_EVENT_PAYLOAD_OBJECT_KEYS`
   * keys. The failure mode is the bad one: not a lost row, but a post-terminal
   * row that survives stripped of the marker, i.e. indistinguishable from an
   * ordinary live-run event that appears to postdate its own run's end -- and
   * `_truncated: true` is set either way, so nothing reveals the loss.
   *
   * These assert the composition as production performs it, because neither
   * function is wrong on its own. The two key shapes are NOT redundant: see the
   * integer-like case below.
   */
  it("keeps the marker through storage bounding on an over-wide payload", () => {
    const settledAt = "2026-09-07T12:00:00.000Z";
    // Over the 100-key storage bound, so truncation is guaranteed to bite.
    const wide: Record<string, unknown> = { stage: "kill_signal" };
    for (let index = 0; index < 150; index += 1) {
      wide[`detail${index}`] = index;
    }

    const stored = boundHeartbeatRunEventPayloadForStorage(
      buildAdapterRunEventPayloadForPersistence(wide, settledAt) ?? {},
    );

    expect(stored).toMatchObject({
      postAdapterSettle: true,
      adapterSettledAt: settledAt,
    });
    // Positive control: the bound still bit, so the assertion above is not
    // passing because the payload happened to fit.
    expect(stored).toMatchObject({ _truncated: true });
  });

  /**
   * The case above passes on key order alone; this one cannot, and that is the
   * whole point of it.
   *
   * `Object.entries` enumerates integer-like keys ("0", "1", ...) first, in
   * ascending numeric order, ahead of every string key no matter when it was
   * inserted. So a payload keyed `0..149` pushes both markers past the slice
   * even though the marked object lists them first -- measured: the
   * `detail<i>` fixture above keeps the markers and this one, differing only in
   * key shape, did not. That is why the survival guarantee is pinned at the
   * slice (`RUN_EVENT_PAYLOAD_PINNED_KEYS`) rather than expressed as key order,
   * which no object literal can control.
   *
   * A payload keyed by array-ish indices is not exotic: any adapter spreading
   * an array or an index-keyed map into a payload produces exactly this shape.
   */
  it("keeps the marker when the payload's own keys are integer-like", () => {
    const settledAt = "2026-09-07T12:00:00.000Z";
    const wide: Record<string, unknown> = { stage: "kill_signal" };
    for (let index = 0; index < 150; index += 1) {
      wide[String(index)] = index;
    }

    const stored = boundHeartbeatRunEventPayloadForStorage(
      buildAdapterRunEventPayloadForPersistence(wide, settledAt) ?? {},
    );

    expect(stored).toMatchObject({
      postAdapterSettle: true,
      adapterSettledAt: settledAt,
    });
    expect(stored).toMatchObject({ _truncated: true });
    // Pinning must reorder, never drop or duplicate: the bound still keeps
    // exactly its budget of payload keys plus the two truncation markers, and
    // still accounts for every omitted key (153 composed keys - 100 kept).
    expect(Object.keys(stored)).toHaveLength(102);
    expect(stored._omittedKeys).toBe(53);
  });

  /**
   * Because storage bounding now pins these key names, an adapter-supplied copy
   * left in place on the LIVE path would be handed precedence over the
   * adapter's real evidence during truncation -- and would persist a payload
   * asserting a post-terminal marker on a run that had not settled. Stripping
   * is therefore unconditional, not only done when marking.
   */
  it("strips adapter-supplied marker keys even while the adapter is live", () => {
    const stored = buildAdapterRunEventPayloadForPersistence(
      { stage: "first_output", postAdapterSettle: true, adapterSettledAt: "1999-01-01T00:00:00.000Z" },
      null,
    );

    expect(stored).toEqual({ stage: "first_output" });
  });
});

/**
 * PEN-3093, second review pass -- the marker alone was not enough.
 *
 * Marking the payload keeps the STORED row honest, but `appendRunEvent` also
 * writes the run's live runtime-status entry, and that write was gated on
 * `isHeartbeatRunRuntimeStatusActive(run.status)` alone. `run` there is a
 * snapshot bound before `execute()` ran, so its `status` reads "running" even
 * after the run terminalized: a marked post-terminal event still republished
 * the run as live until the 90s TTL expired it. The half an operator actually
 * watches was the half the marker never reached.
 *
 * The first case below is the regression. The rest pin the boundaries, so a
 * later "simplification" back to the single `run.status` check fails here
 * rather than in production.
 */
describe("shouldWriteRunRuntimeStatusForEvent", () => {
  it("refuses a post-settle event even though the run snapshot still says running", () => {
    // The exact production state: the snapshot is stale-live, and the only
    // trustworthy signal that the run is over is the server's own settle
    // observation.
    expect(
      shouldWriteRunRuntimeStatusForEvent({
        runStatusSnapshot: "running",
        adapterSettledAt: "2026-09-07T12:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("still writes progress for an ordinary in-flight event", () => {
    // Positive control: if this ever goes false, the live progress display is
    // dead and the test above would pass for the wrong reason.
    expect(
      shouldWriteRunRuntimeStatusForEvent({
        runStatusSnapshot: "running",
        adapterSettledAt: null,
      })
    ).toBe(true);
  });

  it("treats an absent settle marker the same as an explicit null", () => {
    expect(
      shouldWriteRunRuntimeStatusForEvent({
        runStatusSnapshot: "running",
        adapterSettledAt: undefined,
      }),
    ).toBe(true);
  });

  it("refuses a terminal snapshot with no settle marker, as before", () => {
    // The pre-existing half of the gate is unchanged: a caller that passes a
    // genuinely terminal row (every `nextRunEventSeq` caller does) is still
    // refused without needing a marker.
    for (const status of ["succeeded", "failed", "cancelled", "timed_out", "interrupted"]) {
      expect(
        shouldWriteRunRuntimeStatusForEvent({
          runStatusSnapshot: status,
          adapterSettledAt: null,
        }),
      ).toBe(false);
    }
  });

  it("refuses a post-settle event on a terminal snapshot too", () => {
    expect(
      shouldWriteRunRuntimeStatusForEvent({
        runStatusSnapshot: "succeeded",
        adapterSettledAt: "2026-09-07T12:00:00.000Z",
      }),
    ).toBe(false);
  });
});
