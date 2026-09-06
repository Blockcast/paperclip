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
      'const fileFlag = argv.findIndex((arg) => arg === "--body-file" || arg === "--input");',
      "const filePath = fileFlag >= 0 ? argv[fileFlag + 1] : undefined;",
      "const inputBody = filePath && filePath !== \"-\" ? readFileSync(filePath, \"utf8\") : null;",
      'const fieldArgs = [];',
      'for (let i = 0; i < argv.length; i += 1) {',
      '  const arg = argv[i];',
      '  const match = /^(--raw-field|--field)=([\\s\\S]*)$/.exec(arg);',
      '  if (match) fieldArgs.push(match[2]);',
      '  else if (arg === "-f" || arg === "-F" || arg === "--raw-field" || arg === "--field") fieldArgs.push(argv[i + 1]);',
      '}',
      `writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, inputBody, fieldArgs }));`,
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
    expect(result.stderr).toContain("stdin-backed GitHub text/request body is disabled");
    expect(() => readFileSync(fixture.record, "utf8")).toThrow();
  });

  it("rejects gh api --input - before the target starts", () => {
    const fixture = makeFixture();

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", runtimeEntryPoint, fixture.target, "api", "repos/acme/widget/issues/7", "--input", "-"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        input: `{"body":"comment contains ${syntheticCredential}"}`,
      },
    );

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("stdin-backed GitHub text/request body is disabled");
    expect(() => readFileSync(fixture.record, "utf8")).toThrow();
  });

  it("rejects --body-file - before the target GitHub CLI starts", () => {
    const fixture = makeFixture();

    expect(() => {
      prepareGitHubCliInvocation({
        target: fixture.target,
        argv: ["pr", "review", "123", "--body-file", "-"],
      });
    }).toThrow("stdin-backed GitHub text/request body is disabled");
    expect(() => readFileSync(fixture.record, "utf8")).toThrow();
  });

  it("rejects the fused --body-file=- form before the target starts", () => {
    const fixture = makeFixture();

    expect(() => {
      prepareGitHubCliInvocation({
        target: fixture.target,
        argv: ["pr", "review", "123", "--body-file=-"],
      });
    }).toThrow("stdin-backed GitHub text/request body is disabled");
    expect(() => readFileSync(fixture.record, "utf8")).toThrow();
  });

  it("rejects a typed gh api field that reads its value from stdin", () => {
    const fixture = makeFixture();

    expect(() => {
      prepareGitHubCliInvocation({
        target: fixture.target,
        argv: ["api", "repos/acme/widget/issues/7/comments", "--field", "body=@-"],
      });
    }).toThrow("stdin-backed GitHub text/request body is disabled");
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
          inputBody: string | null;
          fieldArgs: string[];
        };
        expect(recorded.argv.slice(0, 4)).toEqual(["pr", "review", "123", "--body-file"]);
        expect(recorded.argv[4]).not.toBe(bodyPath);
        expect(recorded.inputBody).toContain("review text");
        expect(recorded.inputBody).not.toContain(syntheticCredential);
      });
  });

  it("scrubs generic gh api input and field values before the target reads them", () => {
    const fixture = makeFixture();
    const requestPath = path.join(fixture.directory, "request.json");
    writeFileSync(requestPath, `{"body":"issue comment ${syntheticCredential}"}`);

    return runGitHubCliEgressRuntime({
      target: fixture.target,
      argv: [
        "api",
        "repos/acme/widget/issues/7/comments",
        "--input",
        requestPath,
        "-f",
        `body=short inline comment ${syntheticCredential}`,
        "--raw-field",
        `body=inline comment ${syntheticCredential}`,
        "--field",
        `issue[body]=typed comment ${syntheticCredential}`,
      ],
    }).then((exitCode) => {
      expect(exitCode).toBe(0);

      const recorded = JSON.parse(readFileSync(fixture.record, "utf8")) as {
        argv: string[];
        inputBody: string | null;
        fieldArgs: string[];
      };
      expect(recorded.argv).toContain("api");
      expect(recorded.argv).toContain("--input");
      expect(recorded.argv[recorded.argv.indexOf("--input") + 1]).not.toBe(requestPath);
      expect(recorded.inputBody).toContain("issue comment");
      expect(recorded.inputBody).not.toContain(syntheticCredential);
      expect(recorded.fieldArgs).toHaveLength(3);
      expect(recorded.fieldArgs.every((value) => !value.includes(syntheticCredential))).toBe(true);
    });
  });
});
