import { describe, expect, it } from "vitest";
import { buildAdapterRunEventPayloadForPersistence } from "../services/heartbeat.js";

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
});
