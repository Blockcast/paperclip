import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ensureReferencedSharedDocsMaterialized,
  ensureRemoteOpenCodeModelConfiguredAndAvailable,
  extractReferencedSharedDocPaths,
  sharedDocSourceRoots,
} from "./execute.js";

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable", () => {
  afterEach(() => {
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
  });

  // The remote/sandbox execution path must honour OPENCODE_ALLOW_ALL_MODELS just
  // like the local path: gateway-routed models (e.g. anthropic/<gateway>/<model>
  // via Bifrost) never appear in `opencode models`, so the availability probe
  // must be skipped. The early return happens before the executionTarget is ever
  // touched, so a bogus target proves the probe was not run.
  const bogusTarget = {} as never;

  it("skips the remote availability probe when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-1",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-2",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: {},
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("still enforces provider/model format even when the bypass flag is set", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-3",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).rejects.toThrow();
  });
});

describe("referenced shared docs materialization", () => {
  it("extracts unique docs/*.md references from instructions", () => {
    expect(extractReferencedSharedDocPaths([
      "Read: docs/definition-of-done.md",
      "Read `docs/architecture-template.md` before coding.",
      "Ignore ../docs/secret.md and docs/not-markdown.txt.",
      "Read: docs/definition-of-done.md",
    ].join("\n"))).toEqual([
      "docs/architecture-template.md",
      "docs/definition-of-done.md",
    ]);
  });

  it("copies referenced shared docs from the instructions bundle without overwriting workspace docs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-docs-"));
    const cwd = path.join(root, "workspace");
    const instructionsRootPath = path.join(root, "instructions");
    await fs.mkdir(path.join(cwd, "docs"), { recursive: true });
    await fs.mkdir(path.join(instructionsRootPath, "docs"), { recursive: true });
    await fs.writeFile(path.join(instructionsRootPath, "docs", "architecture-template.md"), "# Architecture\n", "utf8");
    await fs.writeFile(path.join(cwd, "docs", "definition-of-done.md"), "# Existing\n", "utf8");

    try {
      await ensureReferencedSharedDocsMaterialized({
        cwd,
        instructionsRootPath,
        instructionsContents: [
          "Read: docs/architecture-template.md",
          "Read: docs/definition-of-done.md",
        ].join("\n"),
        onLog: async () => {},
      });

      await expect(fs.readFile(path.join(cwd, "docs", "architecture-template.md"), "utf8")).resolves.toBe("# Architecture\n");
      await expect(fs.readFile(path.join(cwd, "docs", "definition-of-done.md"), "utf8")).resolves.toBe("# Existing\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("creates a non-fatal placeholder for missing referenced shared docs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-docs-missing-"));
    const cwd = path.join(root, "workspace");
    const instructionsRootPath = path.join(root, "instructions");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(instructionsRootPath, { recursive: true });

    try {
      await ensureReferencedSharedDocsMaterialized({
        cwd,
        instructionsRootPath,
        instructionsContents: "Read: docs/backlog-process.md",
        onLog: async () => {},
      });

      const materialized = await fs.readFile(path.join(cwd, "docs", "backlog-process.md"), "utf8");
      expect(materialized).toContain("# Missing Shared Documentation: docs/backlog-process.md");
      expect(materialized).toContain("Continue the run without failing");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves shared docs curated above the instructions root", async () => {
    // Mirrors the external-bundle layout: instructions at <company>/agents/<role>,
    // shared docs at <company>/docs.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-docs-ancestor-"));
    const cwd = path.join(root, "workspace");
    const companyRoot = path.join(root, "company");
    const instructionsRootPath = path.join(companyRoot, "agents", "cto");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(instructionsRootPath, { recursive: true });
    await fs.mkdir(path.join(companyRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(companyRoot, "docs", "pr-conventions.md"), "# PR Conventions\n", "utf8");

    try {
      await ensureReferencedSharedDocsMaterialized({
        cwd,
        instructionsRootPath,
        instructionsContents: "Read: docs/pr-conventions.md",
        sharedDocSearchBoundaryPath: root,
        onLog: async () => {},
      });

      await expect(fs.readFile(path.join(cwd, "docs", "pr-conventions.md"), "utf8"))
        .resolves.toBe("# PR Conventions\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prefers the instructions root over an ancestor when both carry the doc", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-docs-precedence-"));
    const cwd = path.join(root, "workspace");
    const companyRoot = path.join(root, "company");
    const instructionsRootPath = path.join(companyRoot, "agents", "cto");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(instructionsRootPath, "docs"), { recursive: true });
    await fs.mkdir(path.join(companyRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(instructionsRootPath, "docs", "git-workflow.md"), "# Agent override\n", "utf8");
    await fs.writeFile(path.join(companyRoot, "docs", "git-workflow.md"), "# Company default\n", "utf8");

    try {
      await ensureReferencedSharedDocsMaterialized({
        cwd,
        instructionsRootPath,
        instructionsContents: "Read: docs/git-workflow.md",
        sharedDocSearchBoundaryPath: root,
        onLog: async () => {},
      });

      await expect(fs.readFile(path.join(cwd, "docs", "git-workflow.md"), "utf8"))
        .resolves.toBe("# Agent override\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("replaces a stale placeholder once the shared doc becomes resolvable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-docs-refresh-"));
    const cwd = path.join(root, "workspace");
    const companyRoot = path.join(root, "company");
    const instructionsRootPath = path.join(companyRoot, "agents", "cto");
    await fs.mkdir(instructionsRootPath, { recursive: true });
    await fs.mkdir(path.join(cwd, "docs"), { recursive: true });

    try {
      // Run 1: no source anywhere, so a placeholder lands in the workspace.
      await ensureReferencedSharedDocsMaterialized({
        cwd,
        instructionsRootPath,
        instructionsContents: "Read: docs/definition-of-done.md",
        sharedDocSearchBoundaryPath: root,
        onLog: async () => {},
      });
      await expect(fs.readFile(path.join(cwd, "docs", "definition-of-done.md"), "utf8"))
        .resolves.toContain("# Missing Shared Documentation: docs/definition-of-done.md");

      // Run 2: the company-root source now exists; the placeholder must not survive it.
      await fs.mkdir(path.join(companyRoot, "docs"), { recursive: true });
      await fs.writeFile(path.join(companyRoot, "docs", "definition-of-done.md"), "# Definition of Done\n", "utf8");
      await ensureReferencedSharedDocsMaterialized({
        cwd,
        instructionsRootPath,
        instructionsContents: "Read: docs/definition-of-done.md",
        sharedDocSearchBoundaryPath: root,
        onLog: async () => {},
      });

      await expect(fs.readFile(path.join(cwd, "docs", "definition-of-done.md"), "utf8"))
        .resolves.toBe("# Definition of Done\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a placeholder that still has no resolvable source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-docs-keep-"));
    const cwd = path.join(root, "workspace");
    const instructionsRootPath = path.join(root, "instructions");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(instructionsRootPath, { recursive: true });

    try {
      for (let run = 0; run < 2; run += 1) {
        await ensureReferencedSharedDocsMaterialized({
          cwd,
          instructionsRootPath,
          instructionsContents: "Read: docs/backlog-process.md",
          onLog: async () => {},
        });
      }

      await expect(fs.readFile(path.join(cwd, "docs", "backlog-process.md"), "utf8"))
        .resolves.toContain("# Missing Shared Documentation: docs/backlog-process.md");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("never overwrites a workspace doc that only looks like a placeholder for another path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-docs-guard-"));
    const cwd = path.join(root, "workspace");
    const companyRoot = path.join(root, "company");
    const instructionsRootPath = path.join(companyRoot, "agents", "cto");
    await fs.mkdir(instructionsRootPath, { recursive: true });
    await fs.mkdir(path.join(cwd, "docs"), { recursive: true });
    await fs.mkdir(path.join(companyRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(companyRoot, "docs", "vision-template.md"), "# Company vision\n", "utf8");
    // A real repo doc whose heading names a *different* shared doc must not be treated
    // as our own placeholder for this path.
    await fs.writeFile(
      path.join(cwd, "docs", "vision-template.md"),
      "# Missing Shared Documentation: docs/some-other-doc.md\n",
      "utf8",
    );

    try {
      await ensureReferencedSharedDocsMaterialized({
        cwd,
        instructionsRootPath,
        instructionsContents: "Read: docs/vision-template.md",
        sharedDocSearchBoundaryPath: root,
        onLog: async () => {},
      });

      await expect(fs.readFile(path.join(cwd, "docs", "vision-template.md"), "utf8"))
        .resolves.toBe("# Missing Shared Documentation: docs/some-other-doc.md\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("never overwrites a workspace doc whose heading only shares a prefix with the placeholder", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-docs-prefix-"));
    const cwd = path.join(root, "workspace");
    const companyRoot = path.join(root, "company");
    const instructionsRootPath = path.join(companyRoot, "agents", "cto");
    await fs.mkdir(instructionsRootPath, { recursive: true });
    await fs.mkdir(path.join(cwd, "docs"), { recursive: true });
    await fs.mkdir(path.join(companyRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(companyRoot, "docs", "vision-template.md"), "# Company vision\n", "utf8");
    await fs.writeFile(path.join(companyRoot, "docs", "pr-conventions.md"), "# PR conventions\n", "utf8");

    // Both of these begin with this path's placeholder heading and then continue on the
    // same line, so a prefix test mistakes them for our own placeholder. The first is a
    // placeholder for a *longer* path that happens to share the prefix; the second is a
    // genuine doc whose title quotes the heading. Neither is ours; neither may be lost.
    await fs.writeFile(
      path.join(cwd, "docs", "vision-template.md"),
      "# Missing Shared Documentation: docs/vision-template.md.bak\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(cwd, "docs", "pr-conventions.md"),
      "# Missing Shared Documentation: docs/pr-conventions.md — resolved, see below\n\nReal content.\n",
      "utf8",
    );

    try {
      await ensureReferencedSharedDocsMaterialized({
        cwd,
        instructionsRootPath,
        instructionsContents: "Read: docs/vision-template.md\nRead: docs/pr-conventions.md",
        sharedDocSearchBoundaryPath: root,
        onLog: async () => {},
      });

      await expect(fs.readFile(path.join(cwd, "docs", "vision-template.md"), "utf8"))
        .resolves.toBe("# Missing Shared Documentation: docs/vision-template.md.bak\n");
      await expect(fs.readFile(path.join(cwd, "docs", "pr-conventions.md"), "utf8"))
        .resolves.toBe(
          "# Missing Shared Documentation: docs/pr-conventions.md — resolved, see below\n\nReal content.\n",
        );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("probes no ancestor without a boundary, so a bare root cannot reach /docs", () => {
    expect(sharedDocSourceRoots("/tmp/instructions")).toEqual(["/tmp/instructions"]);
    expect(sharedDocSourceRoots("/tmp/instructions", null)).toEqual(["/tmp/instructions"]);
    expect(sharedDocSourceRoots("/tmp/instructions", "   ")).toEqual(["/tmp/instructions"]);
  });

  it("never walks above the boundary, and caps the depth inside it", () => {
    expect(sharedDocSourceRoots("/home/instances/default/companies/Acme/agents/cto", "/home/instances/default"))
      .toEqual([
        "/home/instances/default/companies/Acme/agents/cto",
        "/home/instances/default/companies/Acme/agents",
        "/home/instances/default/companies/Acme",
        "/home/instances/default/companies",
      ]);
    // Boundary reached before the depth cap.
    expect(sharedDocSourceRoots("/home/instances/default/companies", "/home/instances/default"))
      .toEqual(["/home/instances/default/companies", "/home/instances/default"]);
    // Depth cap reached before the boundary.
    expect(sharedDocSourceRoots("/a/b/c/d/e/f", "/a")).toEqual(["/a/b/c/d/e/f", "/a/b/c/d/e", "/a/b/c/d", "/a/b/c"]);
  });

  it("refuses to walk up from an instructions root outside the boundary", () => {
    expect(sharedDocSourceRoots("/tmp/scratch/instructions", "/home/instances/default"))
      .toEqual(["/tmp/scratch/instructions"]);
    // A sibling whose path merely shares a textual prefix is still outside.
    expect(sharedDocSourceRoots("/home/instances/default-evil/agents/cto", "/home/instances/default"))
      .toEqual(["/home/instances/default-evil/agents/cto"]);
  });

  it("ignores an ancestor doc when no boundary permits the walk", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-docs-noboundary-"));
    const cwd = path.join(root, "workspace");
    const companyRoot = path.join(root, "company");
    const instructionsRootPath = path.join(companyRoot, "agents", "cto");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(instructionsRootPath, { recursive: true });
    await fs.mkdir(path.join(companyRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(companyRoot, "docs", "pr-conventions.md"), "# PR Conventions\n", "utf8");

    try {
      await ensureReferencedSharedDocsMaterialized({
        cwd,
        instructionsRootPath,
        instructionsContents: "Read: docs/pr-conventions.md",
        onLog: async () => {},
      });

      await expect(fs.readFile(path.join(cwd, "docs", "pr-conventions.md"), "utf8"))
        .resolves.toContain("# Missing Shared Documentation: docs/pr-conventions.md");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
