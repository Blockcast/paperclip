// PEN-6237: the image must be able to say which commit it was built from.
//
// WHAT THIS GUARDS, AND WHY IT IS A WIRING TEST
// --------------------------------------------
// `server/src/build-commit.ts` has always known how to READ a build marker, and
// `server/src/__tests__/build-commit.test.ts` has always covered that read. What
// never existed was anything that WROTE one. Measured in production on
// 2026-11-09: `/api/health` returned
// `serverInfo.git = {available: false, unavailableReason: "git_unavailable"}`,
// because the image ships no `.git` (so `readGitInfo()`'s `git show` throws) and
// neither `PAPERCLIP_BUILD_COMMIT` nor `/app/.paperclip-build-commit` was ever
// provided. Every individual piece was correct and the chain was open.
//
// That field is the only build identifier an agent can reach. Agents read MCP
// tool descriptions shipped in a DIFFERENT image (`paperclip-agent`) on a
// different cadence, so without it there is no way to tell "this documented
// contract is not deployed yet" from "this documented contract is broken" —
// which on 2026-11-08 turned an eight-hour deploy lag into a false bug report.
//
// A wiring defect cannot be caught by testing either end, so this file asserts
// the ends AGREE: the path the reader resolves is the path the Dockerfile
// writes, and the commit the workflow passes is the same one that names the
// image tag and stamps the pod annotation.
//
// The last test is not a grep — it executes the Dockerfile's actual `RUN` body.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(repoRoot, p), "utf8");

const MARKER = ".paperclip-build-commit";
const ARG = "PAPERCLIP_BUILD_COMMIT";

const dockerfile = read("Dockerfile");
const workflow = read(".github/workflows/docker.yml");

/** The body of the `RUN` that writes the marker, as a single shell script. */
function markerRunBody() {
  const lines = dockerfile.split("\n");
  const start = lines.findIndex(
    (l) => l.startsWith("RUN ") && l.includes("set -eu"),
  );
  // Walk forward from each `RUN set -eu` until one mentions the marker.
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("RUN ")) continue;
    const block = [];
    let j = i;
    while (j < lines.length) {
      block.push(lines[j]);
      if (!lines[j].endsWith("\\")) break;
      j++;
    }
    const joined = block.join("\n");
    if (joined.includes(MARKER)) {
      return joined.replace(/^RUN /, "").replace(/\\\n/g, "\n");
    }
  }
  assert.fail(`no RUN block in the Dockerfile mentions ${MARKER} (start=${start})`);
}

test("the reader's default path is the repo-root marker the Dockerfile writes", () => {
  // `DEFAULT_BUILD_COMMIT_PATH` is `../../<marker>` from the module, which is
  // /app/<marker> for both the compiled (server/dist) and source (server/src)
  // layouts. Pinning the literal keeps a future move of build-commit.ts from
  // silently re-pointing the reader away from the file the image carries.
  const source = read("server/src/build-commit.ts");
  assert.match(
    source,
    new RegExp(`new URL\\(\\s*"\\.\\./\\.\\./${MARKER.replace(/\./g, "\\.")}"`),
    "build-commit.ts must resolve the marker two levels above the module",
  );
  assert.ok(
    dockerfile.includes(`/app/${MARKER}`),
    "the Dockerfile must write the marker at /app, where the reader looks",
  );
});

test("the stamp is declared after the expensive build layers", () => {
  // The ARG value changes on every commit, so everything after it rebuilds.
  // Declared before `pnpm build` it would discard the whole compile cache on
  // every single push — a real cost, and an invisible one.
  const argAt = dockerfile.indexOf(`ARG ${ARG}`);
  const lastBuildAt = dockerfile.lastIndexOf("pnpm --filter @paperclipai/server build");
  assert.ok(argAt > 0, `Dockerfile must declare ARG ${ARG}`);
  assert.ok(
    argAt > lastBuildAt,
    `ARG ${ARG} must come after the pnpm build layers (arg=${argAt}, build=${lastBuildAt})`,
  );
});

test("the production stage copies the stamped marker out of the build stage", () => {
  // The marker is written in `build`; production gets it only through this
  // COPY. The excludes must not swallow it.
  const copy = dockerfile
    .split("\n")
    .find((l) => l.startsWith("COPY") && l.includes("--from=build") && l.includes("/app /app"));
  assert.ok(copy, "production must COPY /app from the build stage");
  assert.ok(
    !copy.includes(`--exclude=${MARKER}`) && !copy.includes("--exclude=.*"),
    `the production COPY must not exclude ${MARKER}: ${copy}`,
  );
});

test("the workflow passes the same commit that names the tag and stamps the pod", () => {
  // One source for all three, so the marker in the image, the tag it is pushed
  // under and `paperclip.blockcast.net/deployed-commit` cannot disagree. If
  // they could, the identifier would be worse than none: an agent would read a
  // confident SHA that does not describe the code answering its call.
  assert.ok(
    workflow.includes(`${ARG}=\${{ steps.target.outputs.full }}`),
    `docker.yml must pass ${ARG} from steps.target.outputs.full`,
  );
  assert.ok(
    workflow.includes('api.deployedCommit="${COMMIT}"'),
    "the deploy must still stamp api.deployedCommit from COMMIT",
  );
  assert.ok(
    workflow.includes("COMMIT: ${{ steps.target.outputs.full }}"),
    "COMMIT must still come from steps.target.outputs.full",
  );
});

test("no comment line hides inside ANY build-args block scalar", () => {
  // `build-args` is parsed as KEY=VALUE lines, so a `#` line inside it becomes
  // an argument NAME rather than a comment. The explanation must sit above the
  // key. Cheap to get wrong and silent when wrong.
  //
  // EVERY block, not the first: docker.yml has two (the stable runtime image
  // and the main image). An earlier revision of this test used indexOf() and
  // so only ever examined the runtime block — it passed with a comment sitting
  // in the main one, which is the block this change touches.
  const blocks = [];
  const lines = workflow.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)build-args: \|\s*$/);
    if (!m) continue;
    const indent = m[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "") { body.push(line); continue; }
      const lead = line.length - line.trimStart().length;
      if (lead <= indent) break; // dedent ends the block scalar
      body.push(line);
    }
    blocks.push(body);
  }

  assert.equal(blocks.length, 2, `expected 2 build-args blocks, found ${blocks.length}`);
  for (const [n, body] of blocks.entries()) {
    assert.ok(body.length > 0, `build-args block ${n} parsed as empty`);
    for (const line of body) {
      assert.ok(
        !line.trim().startsWith("#"),
        `build-args block ${n} must contain no comment lines, found: ${line.trim()}`,
      );
    }
  }

  // The block this change touches must be one of them, and must carry the arg.
  assert.ok(
    blocks.some((b) => b.some((l) => l.trim().startsWith(`${ARG}=`))),
    `no build-args block declares ${ARG}`,
  );
});

test("the RUN body writes the marker when stamped and nothing when not", () => {
  // Executes the Dockerfile's own shell, with /app redirected to a temp root —
  // the only substitution. The guard matters in both directions: an unstamped
  // local build must leave NO file, because an empty or absent marker makes
  // `parseBuildCommit` return null and the field stays honestly unavailable,
  // whereas a file containing an empty line is a marker that reads as present.
  const script = markerRunBody();
  const sha = "972f4e5b3bf2c98a874c50e043002bb42fd18d04";

  for (const [value, expected] of [[sha, `${sha}\n`], ["", null]]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pen6237-"));
    fs.mkdirSync(path.join(root, "app"));
    const localised = script.replaceAll("/app/", `${root}/app/`);
    execFileSync("sh", ["-c", localised], {
      env: { ...process.env, [ARG]: value },
      stdio: "pipe",
    });
    const marker = path.join(root, "app", MARKER);
    if (expected === null) {
      assert.ok(
        !fs.existsSync(marker),
        "an unstamped build must write no marker at all",
      );
    } else {
      assert.equal(fs.readFileSync(marker, "utf8"), expected);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
