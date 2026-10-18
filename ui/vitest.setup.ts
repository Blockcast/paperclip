import { afterAll } from "vitest";
import { drainReactScheduler } from "./src/lib/drainReactScheduler";

// React's `act` refuses to drive the work loop unless the environment
// advertises itself, and this was armed by hand in 173 separate test files
// (five different casts of the same statement). Arm it once, here, so every
// test file gets it and no file has to remember (PEN-4255).
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const storageEntries = new Map<string, string>();

function installStorageMock(target: Record<string, unknown>) {
  Object.defineProperty(target, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storageEntries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageEntries.set(key, String(value));
      },
      removeItem: (key: string) => {
        storageEntries.delete(key);
      },
      clear: () => {
        storageEntries.clear();
      },
    },
  });
}

if (
  typeof globalThis.localStorage?.getItem !== "function"
  || typeof globalThis.localStorage?.setItem !== "function"
  || typeof globalThis.localStorage?.removeItem !== "function"
  || typeof globalThis.localStorage?.clear !== "function"
) {
  installStorageMock(globalThis);
}

if (typeof window !== "undefined" && window.localStorage !== globalThis.localStorage) {
  installStorageMock(window as unknown as Record<string, unknown>);
}

// jsdom does not implement Element.prototype.scrollIntoView. Several surfaces
// (e.g. IssueChatThread's auto-scroll-to-latest) call it during normal render,
// so provide a no-op default. Tests that assert on scroll behaviour override
// this on the prototype themselves and restore it afterwards.
if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// A scheduler task React left behind (see drainReactScheduler) that fires after
// jsdom is torn down throws "window is not defined" as an unhandled error and
// turns an all-green workspaces-a run red (BLO-23426; merge groups 35903530339,
// 35993984182). After-hooks run in reverse registration order, so this one runs
// after every test file's own hooks and before the environment goes away.
if (typeof window !== "undefined") {
  afterAll(drainReactScheduler);
}
