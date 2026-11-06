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
import { redactionMarker } from "./github-egress-scrub.js";

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

  it("refuses a credential-shaped repository blob before the target starts", () => {
    // BLO-33171. Same fail-closed shape as the stdin rejection above: gh never
    // runs, so no corrupted blob can reach GitHub.
    const fixture = makeFixture();

    const result = spawnSync(
      process.execPath,
      [
        "--import", "tsx", runtimeEntryPoint, fixture.target,
        "api", "repos/acme/widget/git/blobs",
        "-f", `content=const FIXTURES = ["${syntheticCredential}"];`,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("refusing to rewrite GitHub repository content");
    expect(result.stderr).toContain("`content`");
    expect(result.stderr).toContain("vendor-key");
    expect(() => readFileSync(fixture.record, "utf8")).toThrow();
  });

  it("names no line inside a refused environment dump, and says why", () => {
    // A region class has no line attribution: re-scanning a line inside the
    // dump on its own would echo the short assignment the dump rule exists to
    // catch into stderr and from there into run logs.
    const fixture = makeFixture();
    const shortSecret = "s3cretpw";
    const dump = [
      "HOME=/root",
      `TOKEN=${syntheticCredential} DB_PASS=${shortSecret}`,
      "PATH=/usr/bin",
      "LANG=C",
      "SHELL=/bin/sh",
    ].join("\n");

    const result = spawnSync(
      process.execPath,
      [
        "--import", "tsx", runtimeEntryPoint, fixture.target,
        "api", "repos/acme/widget/git/blobs", "-f", `content=${dump}`,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("environment-dump");
    expect(result.stderr).toContain("no per-line location is reported");
    expect(result.stderr).not.toContain(shortSecret);
    expect(() => readFileSync(fixture.record, "utf8")).toThrow();
  });

  it("passes a clean repository blob through to the target byte-exact", () => {
    const fixture = makeFixture();
    const source = 'export const VERSION = "1.2.3";\n';

    const result = spawnSync(
      process.execPath,
      [
        "--import", "tsx", runtimeEntryPoint, fixture.target,
        "api", "repos/acme/widget/git/blobs", "-f", `content=${source}`,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    const recorded = JSON.parse(readFileSync(fixture.record, "utf8")) as {
      fieldArgs: string[];
    };
    expect(recorded.fieldArgs).toContain(`content=${source}`);
  });

  it("still scrubs a prose comment body reaching the same target", () => {
    const fixture = makeFixture();

    const result = spawnSync(
      process.execPath,
      [
        "--import", "tsx", runtimeEntryPoint, fixture.target,
        "api", "repos/acme/widget/issues/7/comments", "-f", `body=leak ${syntheticCredential}`,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    const recorded = JSON.parse(readFileSync(fixture.record, "utf8")) as {
      fieldArgs: string[];
    };
    expect(recorded.fieldArgs.join("\n")).toContain(
      redactionMarker("vendor-key"),
    );
    expect(recorded.fieldArgs.join("\n")).not.toContain(syntheticCredential);
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

describe("PEN-5734: a rewrite is announced, never silent", () => {
  /**
   * The defect this block pins, stated as the measurement that found it.
   *
   * On 2026-11-06 a `gh pr edit --body-file` carrying a force-push recipe ran,
   * exited 0, and printed NOTHING on either stream — while the body GitHub
   * then served back had the author's text replaced in place by a redaction
   * marker. Nothing in the tool result, the exit code, or the output
   * distinguished that from a clean write. The only reason anyone noticed was
   * that the author happened to read the artifact back.
   *
   * That is strictly worse than the refusal every other door in this family
   * performs: a refusal fails closed and tells you, whereas this published a
   * corrupted instruction and reported success, on a WRITE path, where the
   * corrupted text becomes the artifact other agents and humans then execute.
   */
  const opaqueValue = ["xJ9vQ2mTzR4pLw8", "KdH3NbYcF6sEa0UgV"].join("");
  const assignment = ["SOME_UNENUMERATED_NAME", opaqueValue].join("=");

  function captureNotices(argv: string[], io?: { readText(p: string): string }) {
    const notices: string[] = [];
    const result = prepareGitHubCliInvocation({
      target: "/usr/bin/gh",
      argv,
      io: { notify: (message) => notices.push(message) },
      ...(io ?? {}),
    });
    return { notices, result };
  }

  it("announces an inline --body rewrite", () => {
    const { notices, result } = captureNotices([
      "issue",
      "comment",
      "1435",
      "--body",
      `before\n${assignment}\nafter`,
    ]);

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("REWROTE outbound text");
    // Names the FIELD, so a caller knows which of several values moved.
    expect(notices[0]).toContain("`--body`");
    expect(notices[0]).toContain("high-entropy-assignment");
    // Names the SPAN: the 1-based line within the value that fired.
    expect(notices[0]).toContain("2: ");
    // The argv really was rewritten — the notice is not decorative.
    expect(result.argv.join(" ")).not.toContain(opaqueValue);
  });

  it("announces a --body-file rewrite and names the file", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "paperclip-gh-egress-rewrite-"));
    temporaryDirectories.push(directory);
    const bodyPath = path.join(directory, "body.md");
    writeFileSync(bodyPath, `line one\n${assignment}\nline three\n`);

    const { notices, result } = captureNotices(["pr", "edit", "3055", "--body-file", bodyPath]);

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("`--body-file`");
    expect(notices[0]).toContain(bodyPath);
    expect(notices[0]).toContain("2: ");
    // gh is handed a different file, and that file carries the marker.
    const rewrittenPath = result.argv[result.argv.length - 1] as string;
    expect(rewrittenPath).not.toBe(bodyPath);
    expect(readFileSync(rewrittenPath, "utf8")).toContain(
      redactionMarker("high-entropy-assignment"),
    );
    if (result.temporaryDirectory) rmSync(result.temporaryDirectory, { recursive: true, force: true });
  });

  it("never echoes the material it removed", () => {
    // The excerpt is the SCRUBBED line. Echoing the raw match would send the
    // material into agent stderr and from there into run logs and whatever the
    // agent pastes when it reports — PEN-2526's shape, reached from inside the
    // control built to prevent it.
    const { notices } = captureNotices([
      "issue",
      "comment",
      "1435",
      "--body",
      `token ${syntheticCredential}`,
    ]);

    expect(notices).toHaveLength(1);
    expect(notices[0]).not.toContain(syntheticCredential);
    expect(notices[0]).toContain("vendor-key");
  });

  it("says nothing when the payload passes through byte-exact", () => {
    // The notice has to stay rare enough to mean something. A clean call must
    // be silent, or the signal is noise and the next reader filters it out.
    const { notices, result } = captureNotices([
      "issue",
      "comment",
      "1435",
      "--body",
      "## Review\n\nOne finding in `server/src/routes/issues.ts`. LGTM otherwise.",
    ]);

    expect(notices).toEqual([]);
    expect(result.rewrites).toEqual([]);
    expect(result.argv).toContain("## Review\n\nOne finding in `server/src/routes/issues.ts`. LGTM otherwise.");
  });

  it("is silent on the force-push recipe that provoked the row", () => {
    // Both halves of the fix in one assertion: the mandated form is no longer
    // rewritten, so there is nothing to announce.
    const branch = ["chore", "/", "PEN-5215-lock-holder-notes-and-render-guards"].join("");
    const recipe = `git push ${["--force-with-lease", `${branch}:ff113077`].join("=")}`;

    const { notices, result } = captureNotices(["pr", "edit", "3055", "--body", recipe]);

    expect(notices).toEqual([]);
    expect(result.argv).toContain(recipe);
  });

  it("reports every rewritten value, not just the first", () => {
    const { notices } = captureNotices([
      "issue",
      "comment",
      "1435",
      "--title",
      `t ${syntheticCredential}`,
      "--body",
      `b ${assignment}`,
    ]);

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("`--title`");
    expect(notices[0]).toContain("`--body`");
  });

  it("keeps the notice OFF the refusal path, which still fails closed", () => {
    // A repository-content field is refused rather than rewritten, and the two
    // dispositions must not blur: a refusal that also printed "REWROTE" would
    // tell the author their bytes were published when they were not.
    expect(() =>
      prepareGitHubCliInvocation({
        target: "/usr/bin/gh",
        argv: ["api", "repos/o/r/contents/f", "-f", `content=${syntheticCredential}`],
        io: {
          notify: () => {
            throw new Error("a refusal must not emit a rewrite notice");
          },
        },
      }),
    ).toThrow(/refusing to rewrite GitHub repository content/);
  });
});
