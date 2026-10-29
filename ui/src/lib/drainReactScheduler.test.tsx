// @vitest-environment jsdom

import { useEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { drainReactScheduler } from "./drainReactScheduler";

afterEach(() => {
  delete (window as { event?: unknown }).event;
});

it("leaves no scheduler task that reads window pending after an unmount", async () => {
  let reads = 0;
  Object.defineProperty(window, "event", {
    configurable: true,
    get: () => {
      reads++;
      return undefined;
    },
  });
  function WithEffect() {
    useEffect(() => () => {}, []);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  flushSync(() => root.render(<WithEffect />));
  flushSync(() => root.unmount());

  await drainReactScheduler();
  const afterDrain = reads;
  // Anything the drain left queued runs on these turns and reads window.event
  // again -- after a real teardown, that read is the "window is not defined".
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  expect(reads).toBe(afterDrain);
});

it("runs a 0ms timer that a scheduler task posts during the drain", async () => {
  // Shape of Radix FocusScope's unmount cleanup: a task on the immediate queue
  // that posts setTimeout(fn, 0). It must have fired by the time the drain
  // returns, or it fires after jsdom teardown (BLO-46894).
  let fired = false;
  setImmediate(() => {
    setTimeout(() => {
      fired = true;
    }, 0);
  });

  await drainReactScheduler();
  expect(fired).toBe(true);
});
