import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  evaluateReviewSubmission,
  inspectReviewAttestation,
  parseReviewSubmission,
  type CommitReachability,
  type ReviewAttestationGuardIo,
} from "./github-review-attestation.js";
import { runGitHubCliEgressRuntime } from "./github-cli-egress-runtime.js";

// Real values from the two incidents this guard exists for, so the regression
// is pinned to what actually happened rather than to a synthetic shape.
//
// BLO-32844 — cross-repository contamination (fails OPEN):
const MEDIAMTX_HEAD = "dbe4e10e1068fc43383b59ea5a52ea1bb6134fce";
const PIM_2864_HEAD = "81d63ac9ca72ddafc12919d3b40ae0870a901b7f";
// The malformed-marker defect on review-gate-action#7 (fails CLOSED): the real
// SHA with "f6" spliced in at offset 25, giving 42 characters.
const MALFORMED_MARKER = "160a571d83f8e0bcd6dc23a072f6f9a9bda1983556";
const REVIEW_GATE_ACTION_HEAD = "160a571d83f8e0bcd6dc23a072f9a9bda1983556";

/** The contaminated review body as posted to mediamtx#33, trimmed. */
function bodyAttesting(sha: string): string {
  return [
    "## Ally — Consolidated PR Review",
    "",
    "_Lenses: pr-review-toolkit + gstack/review._",
    `Reviewed head: ${sha}`,
    "",
    "Looks good. The change pins the cached wasm-pack toolchain.",
    "",
    "### Critical Issues (0)",
    "",
    "None.",
  ].join("\n");
}

function makeIo(
  overrides: Partial<ReviewAttestationGuardIo> = {},
): ReviewAttestationGuardIo & {
  reachabilityCalls: Array<{ repo: string; sha: string }>;
} {
  const reachabilityCalls: Array<{ repo: string; sha: string }> = [];
  return {
    reachabilityCalls,
    readText: overrides.readText ?? (() => bodyAttesting(MEDIAMTX_HEAD)),
    resolveCommitReachability:
      overrides.resolveCommitReachability ??
      (async (repo, sha) => {
        reachabilityCalls.push({ repo, sha });
        return "reachable" as CommitReachability;
      }),
    resolveDefaultRepo: overrides.resolveDefaultRepo ?? (async () => null),
  };
}

describe("parseReviewSubmission", () => {
  it("recognises the review form Ally actually posts", () => {
    const submission = parseReviewSubmission([
      "pr",
      "review",
      "33",
      "--repo",
      "Blockcast/mediamtx",
      "--approve",
      "--body-file",
      "/tmp/ally-review.md",
    ]);

    expect(submission).toEqual({
      repo: "Blockcast/mediamtx",
      repoSource: "argv-flag",
      pullNumber: 33,
      body: { kind: "file", path: "/tmp/ally-review.md" },
    });
  });

  it("accepts fused long and short spellings of the same flags", () => {
    expect(
      parseReviewSubmission([
        "pr",
        "review",
        "33",
        "--repo=Blockcast/mediamtx",
        "--body-file=/tmp/b.md",
      ]),
    ).toMatchObject({ repo: "Blockcast/mediamtx", body: { kind: "file", path: "/tmp/b.md" } });

    expect(
      parseReviewSubmission(["pr", "review", "33", "-RBlockcast/mediamtx", "-F/tmp/b.md"]),
    ).toMatchObject({ repo: "Blockcast/mediamtx", body: { kind: "file", path: "/tmp/b.md" } });
  });

  // `gh pr review` spells --body-file as -F, which is --field on `gh api`. A
  // single shared flag table would read the body path as a field expression
  // and silently stop guarding this form.
  it("treats -F on pr review as the body file, not as a typed api field", () => {
    expect(parseReviewSubmission(["pr", "review", "7", "-F", "/tmp/body.md"])).toMatchObject({
      body: { kind: "file", path: "/tmp/body.md" },
    });
  });

  it("reads repo and number out of a pull request URL", () => {
    expect(
      parseReviewSubmission([
        "pr",
        "review",
        "https://github.com/Blockcast/mediamtx/pull/33",
        "--approve",
        "--body",
        "text",
      ]),
    ).toMatchObject({
      repo: "Blockcast/mediamtx",
      repoSource: "argv-url",
      pullNumber: 33,
      body: { kind: "inline", text: "text" },
    });
  });

  it("does not mistake a flag value for the positional PR argument", () => {
    expect(
      parseReviewSubmission(["pr", "review", "--repo", "Blockcast/mediamtx", "33", "--comment"]),
    ).toMatchObject({ repo: "Blockcast/mediamtx", pullNumber: 33 });
  });

  it("recognises the raw api submission form", () => {
    expect(
      parseReviewSubmission([
        "api",
        "repos/Blockcast/mediamtx/pulls/33/reviews",
        "-X",
        "POST",
        "-f",
        "event=COMMENT",
        "-F",
        "body=@/tmp/ally-review.md",
      ]),
    ).toEqual({
      repo: "Blockcast/mediamtx",
      repoSource: "argv-api-path",
      pullNumber: 33,
      body: { kind: "file", path: "/tmp/ally-review.md" },
    });
  });

  // Ally's own idempotency step GETs this exact path before deciding whether to
  // review. Guarding a read would double the cost of every review for nothing.
  it("ignores a GET against the reviews path", () => {
    expect(parseReviewSubmission(["api", "repos/Blockcast/mediamtx/pulls/33/reviews"])).toBeNull();
    expect(
      parseReviewSubmission(["api", "repos/Blockcast/mediamtx/pulls/33/reviews", "-X", "GET"]),
    ).toBeNull();
  });

  it("ignores invocations that are not review submissions", () => {
    expect(parseReviewSubmission(["pr", "comment", "33", "--body", "hi"])).toBeNull();
    expect(parseReviewSubmission(["pr", "view", "33"])).toBeNull();
    expect(parseReviewSubmission(["api", "repos/Blockcast/mediamtx/issues/33/comments"])).toBeNull();
    expect(parseReviewSubmission([])).toBeNull();
  });
});

describe("inspectReviewAttestation", () => {
  it("extracts a well-formed attestation", () => {
    expect(inspectReviewAttestation(bodyAttesting(PIM_2864_HEAD))).toEqual({
      kind: "well-formed",
      sha: PIM_2864_HEAD,
    });
  });

  it("accepts the backticked and upper-case spellings the consumer accepts", () => {
    expect(
      inspectReviewAttestation(`## Ally — Consolidated PR Review\nReviewed head: \`${PIM_2864_HEAD}\``),
    ).toEqual({ kind: "well-formed", sha: PIM_2864_HEAD });

    expect(
      inspectReviewAttestation(`Reviewed head: ${PIM_2864_HEAD.toUpperCase()}`),
    ).toEqual({ kind: "well-formed", sha: PIM_2864_HEAD });
  });

  it("reports no attestation when the body carries none", () => {
    expect(inspectReviewAttestation("## Ally — Consolidated PR Review\n\nLooks good.")).toEqual({
      kind: "absent",
    });
  });

  // The defect the consumer cannot see: extractAllyReviewedHeadSha requires
  // exactly 40 hex followed by end-of-line, so a 42-character token matches
  // nothing and reads as "no attestation" rather than as a broken one.
  it("classifies the real 42-character marker as malformed, not absent", () => {
    const attestation = inspectReviewAttestation(bodyAttesting(MALFORMED_MARKER));
    expect(attestation).toEqual({ kind: "malformed", raw: MALFORMED_MARKER });
    expect(MALFORMED_MARKER).toHaveLength(42);
  });

  it("treats several attestations as ambiguous", () => {
    const body = `Reviewed head: ${PIM_2864_HEAD}\nReviewed head: ${MEDIAMTX_HEAD}`;
    expect(inspectReviewAttestation(body)).toEqual({
      kind: "ambiguous",
      raw: [PIM_2864_HEAD, MEDIAMTX_HEAD],
    });
  });

  // A review *of this guard* quotes `Reviewed head:` lines in fenced examples.
  // Counting those would refuse honest reviews of the refusing code itself.
  it("ignores an attestation quoted inside a fenced block", () => {
    const body = [
      "## Ally — Consolidated PR Review",
      `Reviewed head: ${MEDIAMTX_HEAD}`,
      "",
      "The docs show:",
      "```",
      `Reviewed head: ${PIM_2864_HEAD}`,
      "```",
    ].join("\n");

    expect(inspectReviewAttestation(body)).toEqual({ kind: "well-formed", sha: MEDIAMTX_HEAD });
  });

  it("ignores an attestation indented into a code block", () => {
    expect(inspectReviewAttestation(`text\n    Reviewed head: ${PIM_2864_HEAD}`)).toEqual({
      kind: "absent",
    });
  });
});

describe("evaluateReviewSubmission", () => {
  const crossRepoArgv = [
    "pr",
    "review",
    "33",
    "--repo",
    "Blockcast/mediamtx",
    "--approve",
    "--body-file",
    "/tmp/ally-review.md",
  ];

  // THE REGRESSION. Review 5146990033: computed against pim#2864, submitted to
  // mediamtx#33. GitHub stamped commit_id with mediamtx#33's real head, so
  // every commit_id-based check passed; only the body marker disagreed.
  it("refuses a review whose attestation names a commit absent from the target repo", async () => {
    const io = makeIo({
      readText: () => bodyAttesting(PIM_2864_HEAD),
      resolveCommitReachability: async () => "unreachable",
    });

    const refusal = await evaluateReviewSubmission(crossRepoArgv, io);

    expect(refusal).not.toBeNull();
    expect(refusal?.reason).toBe("unreachable-attestation");
    expect(refusal?.message).toContain(PIM_2864_HEAD);
    expect(refusal?.message).toContain("Blockcast/mediamtx");
  });

  it("asks about the attested SHA in the argv-named repository", async () => {
    const io = makeIo({ readText: () => bodyAttesting(PIM_2864_HEAD) });

    await evaluateReviewSubmission(crossRepoArgv, io);

    expect(io.reachabilityCalls).toEqual([
      { repo: "Blockcast/mediamtx", sha: PIM_2864_HEAD },
    ]);
  });

  // Rejected locally: a 42-character token cannot be a commit anywhere, so
  // spending an API call to discover that is pure latency.
  it("refuses a malformed attestation without consulting the network", async () => {
    const resolveCommitReachability = vi.fn(async () => "reachable" as CommitReachability);
    const io = makeIo({
      readText: () => bodyAttesting(MALFORMED_MARKER),
      resolveCommitReachability,
    });

    const refusal = await evaluateReviewSubmission(crossRepoArgv, io);

    expect(refusal?.reason).toBe("malformed-attestation");
    expect(refusal?.message).toContain("42 characters");
    expect(resolveCommitReachability).not.toHaveBeenCalled();
  });

  it("refuses an ambiguous attestation", async () => {
    const io = makeIo({
      readText: () => `Reviewed head: ${PIM_2864_HEAD}\nReviewed head: ${MEDIAMTX_HEAD}`,
    });

    expect((await evaluateReviewSubmission(crossRepoArgv, io))?.reason).toBe(
      "ambiguous-attestation",
    );
  });

  // Reviewing a prior head is legitimate and common; the gate's own staleness
  // rules handle it. Refusing it here would break normal review traffic, so
  // reachability — not head equality — is the test.
  it("allows an attestation for a prior head that still exists in the repo", async () => {
    const io = makeIo({
      readText: () => bodyAttesting(REVIEW_GATE_ACTION_HEAD),
      resolveCommitReachability: async () => "reachable",
    });

    expect(await evaluateReviewSubmission(crossRepoArgv, io)).toBeNull();
  });

  it("refuses when reachability cannot be determined", async () => {
    const io = makeIo({
      readText: () => bodyAttesting(PIM_2864_HEAD),
      resolveCommitReachability: async () => "indeterminate",
    });

    const refusal = await evaluateReviewSubmission(crossRepoArgv, io);
    expect(refusal?.reason).toBe("unreachable-attestation");
    expect(refusal?.message).toContain("could not confirm");
  });

  it("passes through a review that attests nothing", async () => {
    const resolveCommitReachability = vi.fn(async () => "reachable" as CommitReachability);
    const io = makeIo({ readText: () => "## Ally — Consolidated PR Review\n\nLooks good.", resolveCommitReachability });

    expect(await evaluateReviewSubmission(crossRepoArgv, io)).toBeNull();
    expect(resolveCommitReachability).not.toHaveBeenCalled();
  });

  it("passes through invocations that are not review submissions", async () => {
    const resolveCommitReachability = vi.fn(async () => "reachable" as CommitReachability);
    const io = makeIo({ resolveCommitReachability });

    expect(
      await evaluateReviewSubmission(["pr", "comment", "33", "--body", "hi"], io),
    ).toBeNull();
    expect(resolveCommitReachability).not.toHaveBeenCalled();
  });

  it("falls back to gh's default repository when argv names none", async () => {
    const io = makeIo({
      readText: () => bodyAttesting(PIM_2864_HEAD),
      resolveDefaultRepo: async () => "Blockcast/pim-multicast-gateway",
    });

    expect(
      await evaluateReviewSubmission(["pr", "review", "2864", "--body-file", "/tmp/b.md"], io),
    ).toBeNull();
    expect(io.reachabilityCalls).toEqual([
      { repo: "Blockcast/pim-multicast-gateway", sha: PIM_2864_HEAD },
    ]);
  });

  it("refuses when neither argv nor the checkout names a target repository", async () => {
    const io = makeIo({
      readText: () => bodyAttesting(PIM_2864_HEAD),
      resolveDefaultRepo: async () => null,
    });

    expect(
      (await evaluateReviewSubmission(["pr", "review", "33", "--body-file", "/tmp/b.md"], io))
        ?.reason,
    ).toBe("unresolved-target");
  });

  it("refuses when the body file cannot be read", async () => {
    const io = makeIo({
      readText: () => {
        throw new Error("ENOENT");
      },
    });

    expect((await evaluateReviewSubmission(crossRepoArgv, io))?.reason).toBe("unreadable-body");
  });

  it("guards an inline body too", async () => {
    const io = makeIo({ resolveCommitReachability: async () => "unreachable" });

    const refusal = await evaluateReviewSubmission(
      [
        "pr",
        "review",
        "33",
        "--repo",
        "Blockcast/mediamtx",
        "--approve",
        "--body",
        bodyAttesting(PIM_2864_HEAD),
      ],
      io,
    );

    expect(refusal?.reason).toBe("unreachable-attestation");
  });
});

describe("runGitHubCliEgressRuntime review guard", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    while (temporaryDirectories.length > 0) {
      const directory = temporaryDirectories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  function makeRecordingTarget(): { target: string; record: string; bodyPath: string } {
    const directory = mkdtempSync(path.join(os.tmpdir(), "paperclip-review-guard-"));
    temporaryDirectories.push(directory);
    const target = path.join(directory, "gh-target.mjs");
    const record = path.join(directory, "target-record.json");
    const bodyPath = path.join(directory, "review.md");

    writeFileSync(
      target,
      [
        "#!/usr/bin/env node",
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2) }));`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(bodyPath, bodyAttesting(PIM_2864_HEAD));

    return { target, record, bodyPath };
  }

  // The whole point of the guard: the review must never reach GitHub. A
  // refusal that still spawned the CLI would have already posted the review.
  it("never starts the GitHub CLI when the attestation is unreachable", async () => {
    const fixture = makeRecordingTarget();

    await expect(
      runGitHubCliEgressRuntime({
        target: fixture.target,
        argv: [
          "pr",
          "review",
          "33",
          "--repo",
          "Blockcast/mediamtx",
          "--approve",
          "--body-file",
          fixture.bodyPath,
        ],
        guardIo: makeIo({
          readText: (filePath) => readFileSync(filePath, "utf8"),
          resolveCommitReachability: async () => "unreachable",
        }),
      }),
    ).rejects.toThrow("unreachable-attestation");

    expect(() => readFileSync(fixture.record, "utf8")).toThrow();
  });

  it("runs the GitHub CLI when the attestation resolves in the target repo", async () => {
    const fixture = makeRecordingTarget();

    const exitCode = await runGitHubCliEgressRuntime({
      target: fixture.target,
      argv: [
        "pr",
        "review",
        "2864",
        "--repo",
        "Blockcast/pim-multicast-gateway",
        "--approve",
        "--body-file",
        fixture.bodyPath,
      ],
      guardIo: makeIo({
        readText: (filePath) => readFileSync(filePath, "utf8"),
        resolveCommitReachability: async () => "reachable",
      }),
    });

    expect(exitCode).toBe(0);
    const recorded = JSON.parse(readFileSync(fixture.record, "utf8")) as { argv: string[] };
    expect(recorded.argv).toContain("--approve");
  });
});
