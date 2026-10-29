import { describe, expect, it } from "vitest";

import {
  omitSharedDocContents,
  type PaperclipSharedDocOverlay,
} from "../services/heartbeat.js";

/**
 * PEN-3329 round two. The shared-doc overlay gained `contents` — the document bodies, up
 * to 512 KiB of them — so that a run-isolated pod can be handed the docs it cannot reach
 * by path. Those bodies are transport to the adapter and nothing else: no reader anywhere
 * takes them back out of a run row.
 *
 * The hazard is that the overlay is set on `context`, and `context` is written verbatim
 * into `heartbeat_runs.context_snapshot` (`contextSnapshot: context`) at roughly fifteen
 * call sites. Left on that object, every run with runtime services would store a private
 * copy of every company doc in the JSONB column migrations 0079/0080 worked to keep below
 * the detoast threshold — a few hundred bytes of paths becoming hundreds of kilobytes.
 *
 * So `context` carries the paths and the adapter context carries the bodies. These tests
 * pin the split at the one function that performs it, which is the whole of the
 * invariant: `contents` is dropped, and nothing else is.
 */
describe("shared-doc overlay: bodies are not persisted with the run context", () => {
  const overlay: PaperclipSharedDocOverlay = {
    sourceCwd: "/paperclip/instances/default/projects/co/proj/repo",
    paths: ["docs/definition-of-done.md", "docs/pr-conventions.md"],
    contents: {
      "docs/definition-of-done.md": "# Definition of Done\n\nA pushed PR.\n",
      "docs/pr-conventions.md": "# PR conventions\n\nSign off.\n",
    },
  };

  it("drops contents from the persisted shape", () => {
    const persisted = omitSharedDocContents(overlay);

    expect(persisted.contents).toBeUndefined();
    // Absent, not merely undefined: `JSON.stringify` skips an undefined value, but an own
    // key set to undefined would survive a structured clone and read as "delivered, empty"
    // to anything inspecting the object rather than its JSON.
    expect(Object.hasOwn(persisted, "contents")).toBe(false);
    expect(JSON.stringify(persisted)).not.toContain("Definition of Done");
  });

  it("keeps every other field, so the pod still knows what it was owed", () => {
    const persisted = omitSharedDocContents(overlay);

    // `paths` is what makes an undelivered document reportable by name rather than
    // silently missing, so dropping it along with the bodies would defeat the point.
    expect(persisted.sourceCwd).toBe(overlay.sourceCwd);
    expect(persisted.paths).toEqual(["docs/definition-of-done.md", "docs/pr-conventions.md"]);
  });

  it("does not mutate the overlay the adapter is handed", () => {
    // The caller passes the SAME object on to the adapter, which needs the bodies to
    // stage the Secret. A `delete overlay.contents` implementation would pass both tests
    // above and still deliver nothing — exactly the failure round one shipped.
    const persisted = omitSharedDocContents(overlay);

    expect(persisted).not.toBe(overlay);
    expect(overlay.contents).toBeDefined();
    expect(Object.keys(overlay.contents ?? {})).toHaveLength(2);
  });

  it("is a no-op shape-wise when no bodies were carried", () => {
    // Deploy skew: an overlay built before the bodies existed, or one whose documents
    // were all over budget, has no `contents` to drop.
    const noBodies: PaperclipSharedDocOverlay = {
      sourceCwd: overlay.sourceCwd,
      paths: overlay.paths,
    };

    expect(omitSharedDocContents(noBodies)).toEqual(noBodies);
  });
});
