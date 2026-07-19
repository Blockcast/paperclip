import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // ACP subprocess startup and repeated auth-merge shell fixtures can exceed
    // Vitest's 5s default when ARC nodes are under I/O contention.
    testTimeout: 30_000,
  },
});
