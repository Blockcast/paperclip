import { describe, expect, it } from "vitest";

import {
  DEFAULT_DATA_MOUNT_PATH,
  DEFAULT_HOOKS_DIR,
  GIT_HOOKS_SUBPATH,
  hooksDirForDataMount,
} from "./github-git-hooks-path.js";
import { DEFAULT_HOOKS_DIR as RUNTIME_DEFAULT_HOOKS_DIR } from "./github-git-egress-runtime.js";

describe("github-git-hooks-path", () => {
  it("composes the default from the mount point and the subpath", () => {
    expect(DEFAULT_HOOKS_DIR).toBe(
      `${DEFAULT_DATA_MOUNT_PATH}/${GIT_HOOKS_SUBPATH}`,
    );
  });

  it("is the same value the egress runtime resolves", () => {
    // The runtime re-exports it rather than declaring its own. Pinned because
    // a second declaration drifting from this one is exactly PEN-4518.
    expect(RUNTIME_DEFAULT_HOOKS_DIR).toBe(DEFAULT_HOOKS_DIR);
  });

  it("keeps the subpath relative, so path.posix.join onto a mount is safe", () => {
    // `ROOT_TOOLCHAIN_SUBPATHS` feeds this straight into a volumeMount subPath,
    // which Kubernetes rejects when absolute.
    expect(GIT_HOOKS_SUBPATH.startsWith("/")).toBe(false);
  });

  it("keeps the hook out of `.local/share` itself", () => {
    // Widening the mount to `.local/share` would re-expose mkcert's CA key,
    // which is the whole reason BLO-32734 put an overlay there.
    expect(GIT_HOOKS_SUBPATH).not.toBe(".local/share");
    expect(GIT_HOOKS_SUBPATH.startsWith(".local/share/")).toBe(true);
  });

  describe("hooksDirForDataMount", () => {
    it("joins a custom mount point", () => {
      expect(hooksDirForDataMount("/mnt/agent-data")).toBe(
        `/mnt/agent-data/${GIT_HOOKS_SUBPATH}`,
      );
    });

    it("agrees with the default for the default mount point", () => {
      expect(hooksDirForDataMount(DEFAULT_DATA_MOUNT_PATH)).toBe(
        DEFAULT_HOOKS_DIR,
      );
    });

    it("treats a trailing slash as the same mount point", () => {
      expect(hooksDirForDataMount("/paperclip/")).toBe(DEFAULT_HOOKS_DIR);
      expect(hooksDirForDataMount("/paperclip///")).toBe(DEFAULT_HOOKS_DIR);
    });

    it("falls back to the default rather than emitting a root-relative path", () => {
      // `""` or `"/"` would otherwise produce `/.local/...`, which looks
      // plausible and silently misses the mount.
      expect(hooksDirForDataMount("")).toBe(DEFAULT_HOOKS_DIR);
      expect(hooksDirForDataMount("/")).toBe(DEFAULT_HOOKS_DIR);
    });
  });
});
