import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  prepareGitHubCliInvocation,
  runGitHubCliEgressRuntime,
} from "./github-cli-egress-runtime.js";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(sourceDirectory, "../../..");
const runtimeEntryPoint = path.join(sourceDirectory, "github-cli-egress-runtime.ts");

const syntheticCredential = "ghp_S7kq2Vt9Lm4Xb8Nd3Wp6Zc1Yr5Hj0TgAbCd";

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function makeFixture(): {
  directory: string;
  target: string;
  record: string;
} {
  const directory = mkdtempSync(path.join(os.tmpdir(), "paperclip-gh-egress-runtime-"));
  temporaryDirectories.push(directory);
  const target = path.join(directory, "gh-target.mjs");
  const record = path.join(directory, "target-record.json");

  writeFileSync(
    target,
    [
      "#!/usr/bin/env node",
      'import { readFileSync, writeFileSync } from "node:fs";',
      "const argv = process.argv.slice(2);",
      'const bodyFlag = argv.indexOf("--body-file");',
      "const bodyPath = bodyFlag >= 0 ? argv[bodyFlag + 1] : undefined;",
      "const body = bodyPath && bodyPath !== \"-\" ? readFileSync(bodyPath, \"utf8\") : null;",
      `writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, body }));`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  return { directory, target, record };
}

describe("github-cli-egress-runtime", () => {
  it("rejects stdin-backed bodies at the CLI entrypoint before the target starts", () => {
    const fixture = makeFixture();

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", runtimeEntryPoint, fixture.target, "pr", "review", "123", "--body-file", "-"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, RECORD_PATH: fixture.record },
        input: `review contains ${syntheticCredential}`,
      },
    );

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("--body-file -/--notes-file - is disabled");
    expect(() => readFileSync(fixture.record, "utf8")).toThrow();
  });

  it("rejects --body-file - before the target GitHub CLI starts", () => {
    const fixture = makeFixture();

    expect(() => {
      prepareGitHubCliInvocation({
        target: fixture.target,
        argv: ["pr", "review", "123", "--body-file", "-"],
      });
    }).toThrow("--body-file -/--notes-file - is disabled");
    expect(() => readFileSync(fixture.record, "utf8")).toThrow();
  });

  it("rejects the fused --body-file=- form before the target starts", () => {
    const fixture = makeFixture();

    expect(() => {
      prepareGitHubCliInvocation({
        target: fixture.target,
        argv: ["pr", "review", "123", "--body-file=-"],
      });
    }).toThrow("--body-file -/--notes-file - is disabled");
    expect(() => readFileSync(fixture.record, "utf8")).toThrow();
  });

  it("scrubs a file-backed body before the target GitHub CLI reads it", () => {
    const fixture = makeFixture();
    const bodyPath = path.join(fixture.directory, "review.md");
    writeFileSync(bodyPath, `review text\n${syntheticCredential}\n`);

    return runGitHubCliEgressRuntime({ target: fixture.target, argv: ["pr", "review", "123", "--body-file", bodyPath] })
      .then((exitCode) => {
        expect(exitCode).toBe(0);

        const recorded = JSON.parse(readFileSync(fixture.record, "utf8")) as {
          argv: string[];
          body: string | null;
        };
        expect(recorded.argv.slice(0, 4)).toEqual(["pr", "review", "123", "--body-file"]);
        expect(recorded.argv[4]).not.toBe(bodyPath);
        expect(recorded.body).toContain("review text");
        expect(recorded.body).not.toContain(syntheticCredential);
      });
  });
});
