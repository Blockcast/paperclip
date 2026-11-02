/**
 * Tests for check-script-test-registration.mjs (PEN-5272).
 *
 * Each arm is driven independently through `analyze`/`evaluate` on synthetic
 * inputs, so a mutation to one arm cannot be masked by another arm still
 * firing. The final test drives the REAL tree: that is the mutation test
 * PEN-5272 asks for -- delete any `node --test ./scripts/...` line from
 * pr.yml and it goes red, naming the file that lost its registration.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ALLOWLIST,
  analyze,
  collect,
  evaluate,
  stripCommentLines,
} from "./check-script-test-registration.mjs";

/** Minimal synthetic world: one candidate, whatever workflow text you pass. */
function world({ tracked = ["scripts/a.test.mjs"], workflows = [], scripts = {} } = {}) {
  return analyze({
    tracked,
    workflowSources: workflows,
    packageScripts: scripts,
  });
}

function errorsFor(analysis, allowlist = []) {
  return evaluate(analysis, allowlist).errors;
}

test("arm 1: a candidate named by no workflow is reported unregistered", () => {
  const errors = errorsFor(world({ workflows: ["jobs:\n  a:\n    steps: []\n"] }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^arm 1: scripts\/a\.test\.mjs is reachable from no workflow/);
});

test("arm 1: a full-path `node --test` registration satisfies it", () => {
  assert.deepEqual(
    errorsFor(world({ workflows: ["run: node --test scripts/a.test.mjs\n"] })),
    [],
  );
});

test("arm 1: a `./`-prefixed registration satisfies it", () => {
  assert.deepEqual(
    errorsFor(world({ workflows: ["run: node --test ./scripts/a.test.mjs\n"] })),
    [],
  );
});

test("arm 1: a bare basename does NOT satisfy it -- matching is by full path", () => {
  const errors = errorsFor(world({ workflows: ["run: node --test a.test.mjs\n"] }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /arm 1: scripts\/a\.test\.mjs/);
});

test("arm 1: a registered test does not cover one whose name is its SUFFIX", () => {
  // Ally's finding on PR #3275, pinned. With `check-pr-template.test.mjs`
  // registered, a substring match marked an unrun `scripts/pr-template.test.mjs`
  // reachable -- a fail-open in this guard's own defect class.
  const errors = errorsFor(
    world({
      tracked: [
        ".github/scripts/tests/check-pr-template.test.mjs",
        "scripts/pr-template.test.mjs",
      ],
      workflows: [
        "run: node --test ./.github/scripts/tests/check-pr-template.test.mjs\n",
      ],
    }),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /arm 1: scripts\/pr-template\.test\.mjs/);
});

test("arm 1: the same suffix hazard one level up, at PATH level, is closed too", () => {
  // No such pair exists in the tree today; tokenising removes the class.
  const errors = errorsFor(
    world({
      tracked: [".github/scripts/tests/x.test.mjs", "scripts/tests/x.test.mjs"],
      workflows: ["run: node --test .github/scripts/tests/x.test.mjs\n"],
    }),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /arm 1: scripts\/tests\/x\.test\.mjs/);
});

test("arm 1: a mention in a step `name:` is not a registration", () => {
  // Only a command can run a test. `- name: Test foo.test.mjs` with a `run:`
  // that does something else used to read as reachable.
  const errors = errorsFor(
    world({
      workflows: [
        "      - name: Test scripts/a.test.mjs\n        run: echo skipped\n",
      ],
    }),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /arm 1: scripts\/a\.test\.mjs/);
});

test("arm 1: a `run: |` block scalar registers every file it names", () => {
  assert.deepEqual(
    errorsFor(
      world({
        tracked: ["scripts/a.test.mjs", "scripts/b.test.mjs"],
        workflows: [
          "        run: |\n          node --test \\\n            ./scripts/a.test.mjs \\\n            ./scripts/b.test.mjs\n",
        ],
      }),
    ),
    [],
  );
});

test("arm 1: a quoted path still registers", () => {
  assert.deepEqual(
    errorsFor(world({ workflows: ['run: node --test "scripts/a.test.mjs"\n'] })),
    [],
  );
});

test("arm 1: a file named ONLY in a whole-line comment is still unregistered", () => {
  // The PEN-5272 failure mode in one assertion: being documented as runnable.
  const errors = errorsFor(
    world({ workflows: ["      # see scripts/a.test.mjs for the parse rules\n"] }),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /arm 1: scripts\/a\.test\.mjs/);
});

test("arm 1: an inline `#` inside a run block is shell, not a comment", () => {
  // Only WHOLE-LINE comments are stripped; stripping inline `#` would discard
  // real shell and make a registered file read as unregistered.
  assert.deepEqual(
    errorsFor(
      world({ workflows: ["        run: node --test scripts/a.test.mjs # pinned\n"] }),
    ),
    [],
  );
});

test("arm 1: reachable through a root npm script a workflow invokes", () => {
  assert.deepEqual(
    errorsFor(
      world({
        workflows: ["run: pnpm run test:a\n"],
        scripts: { "test:a": "node --test scripts/a.test.mjs" },
      }),
    ),
    [],
  );
});

test("arm 1: an npm script no workflow invokes does NOT make it reachable", () => {
  // The `test:security-audit-overrides` shape: a script exists, nothing calls it.
  const errors = errorsFor(
    world({
      workflows: ["run: pnpm run something-else\n"],
      scripts: { "test:a": "node --test scripts/a.test.mjs" },
    }),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /arm 1: scripts\/a\.test\.mjs/);
});

test("arm 1: npm-script reachability is transitively closed", () => {
  assert.deepEqual(
    errorsFor(
      world({
        workflows: ["run: pnpm run ci\n"],
        scripts: { ci: "pnpm run test:a", "test:a": "node --test scripts/a.test.mjs" },
      }),
    ),
    [],
  );
});

test("arm 1: `pnpm X`, `npm run X` and `yarn X` all count as invocations", () => {
  for (const invocation of ["pnpm test:a", "npm run test:a", "yarn test:a"]) {
    assert.deepEqual(
      errorsFor(
        world({
          workflows: [`run: ${invocation}\n`],
          scripts: { "test:a": "node --test scripts/a.test.mjs" },
        }),
      ),
      [],
      invocation,
    );
  }
});

test("arm 1: a script name that is a PREFIX of the invoked one does not count", () => {
  const errors = errorsFor(
    world({
      workflows: ["run: pnpm run test:ab\n"],
      scripts: { "test:a": "node --test scripts/a.test.mjs", "test:ab": "true" },
    }),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /arm 1: scripts\/a\.test\.mjs/);
});

test("arm 1: only scripts/ and .github/scripts/ are candidates", () => {
  assert.deepEqual(
    errorsFor(world({ tracked: ["server/src/a.test.mjs", "deploy/b.test.js"], workflows: [] })),
    [],
  );
});

test("arm 1: .test.ts is not a candidate (vitest owns those)", () => {
  assert.deepEqual(errorsFor(world({ tracked: ["scripts/a.test.ts"], workflows: [] })), []);
});

test("arm 2: an allowlist entry naming no candidate file is dangling", () => {
  const errors = errorsFor(world({ workflows: [] }), [
    { file: "scripts/renamed-away.test.mjs", reason: "stale" },
  ]);
  assert.ok(errors.some((e) => /^arm 2: .*renamed-away.*names no candidate test file/.test(e)));
});

test("arm 2: a dangling entry does not also exempt the real candidate", () => {
  const errors = errorsFor(world({ workflows: [] }), [
    { file: "scripts/gone.test.mjs", reason: "stale" },
  ]);
  assert.ok(errors.some((e) => /arm 1: scripts\/a\.test\.mjs/.test(e)));
});

test("arm 3: an entry with no reason is refused", () => {
  for (const reason of [undefined, "", "   "]) {
    const errors = errorsFor(world({ workflows: [] }), [
      { file: "scripts/a.test.mjs", reason },
    ]);
    assert.ok(
      errors.some((e) => /^arm 3: allowlist entry scripts\/a\.test\.mjs carries no reason/.test(e)),
      JSON.stringify(reason),
    );
  }
});

test("arm 3: a duplicate entry is refused", () => {
  const errors = errorsFor(world({ workflows: [] }), [
    { file: "scripts/a.test.mjs", reason: "one" },
    { file: "scripts/a.test.mjs", reason: "two" },
  ]);
  assert.ok(errors.some((e) => /^arm 3: duplicate allowlist entry/.test(e)));
});

test("arm 3: a reasoned entry exempts an unregistered file", () => {
  assert.deepEqual(
    errorsFor(world({ workflows: [] }), [
      { file: "scripts/a.test.mjs", reason: "needs live credentials" },
    ]),
    [],
  );
});

test("arm 4: an allowlist entry whose file became reachable is refused", () => {
  const errors = errorsFor(
    world({ workflows: ["run: node --test scripts/a.test.mjs\n"] }),
    [{ file: "scripts/a.test.mjs", reason: "was manual" }],
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^arm 4: allowlist entry scripts\/a\.test\.mjs is reachable from CI/);
});

test("arm 4: a pendingRegistrationPr entry becoming reachable is a notice, not an error", () => {
  // Landing the named PR must not need a second push to this allowlist.
  const { errors, notices } = evaluate(
    world({ workflows: ["run: node --test scripts/a.test.mjs\n"] }),
    [{ file: "scripts/a.test.mjs", reason: "held on #42", pendingRegistrationPr: 42 }],
  );
  assert.deepEqual(errors, []);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /PR #42 was going to do.*Delete its\s+allowlist entry/s);
});

test("arm 4: a pendingRegistrationPr entry still exempts a file that is NOT yet reachable", () => {
  const { errors, notices } = evaluate(world({ workflows: [] }), [
    { file: "scripts/a.test.mjs", reason: "held on #42", pendingRegistrationPr: 42 },
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(notices, []);
});

test("arm 1: identical basenames in different directories are judged independently", () => {
  // Previously refused outright by an arm-5 collision check; exact-path
  // matching makes the pair perfectly decidable, so it is allowed and each
  // file stands on its own registration.
  const errors = errorsFor(
    world({
      tracked: ["scripts/a.test.mjs", "scripts/__tests__/a.test.mjs"],
      workflows: ["run: node --test scripts/a.test.mjs\n"],
    }),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /arm 1: scripts\/__tests__\/a\.test\.mjs/);
});

test("arm 5: a workflow glob covering a guarded directory is refused", () => {
  const errors = errorsFor(
    world({ workflows: ["run: node --test ./scripts/*.test.mjs\n"] }),
  );
  assert.ok(errors.some((e) => /^arm 5: workflow glob .* covers a guarded directory/.test(e)));
});

test("arm 5: a glob over an unguarded directory is fine", () => {
  // deploy/helm/paperclip/tests/*.test.mjs is the one real glob in the set.
  assert.deepEqual(
    errorsFor(
      world({
        workflows: [
          "run: |\n  node --test deploy/helm/paperclip/tests/*.test.mjs\n  node --test scripts/a.test.mjs\n",
        ],
      }),
    ),
    [],
  );
});

test("arm 5: a glob named only in a comment is not treated as a glob", () => {
  const errors = errorsFor(
    world({
      workflows: ["      # never do node --test ./scripts/*.test.mjs\n      run: node --test scripts/a.test.mjs\n"],
    }),
  );
  assert.deepEqual(errors, []);
});

test("stripCommentLines drops whole-line comments and keeps everything else", () => {
  assert.equal(
    stripCommentLines("# a\n  # b\nkeep\nrun: x # inline\n"),
    "keep\nrun: x # inline\n",
  );
});

test("the real repository is clean: every script test is registered or allowlisted", () => {
  // THE MUTATION TEST. Remove a `node --test ./scripts/<f>.test.mjs` line from
  // .github/workflows/pr.yml and this fails, naming <f>. It is also what keeps
  // the shipped ALLOWLIST honest: arms 2-4 run against the real tree here.
  const { tracked, workflowSources, packageScripts } = collect();
  const analysis = analyze({ tracked, workflowSources, packageScripts });
  const { errors } = evaluate(analysis, ALLOWLIST);
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.ok(analysis.candidates.length > 100, "candidate discovery collapsed");
});

test("the shipped allowlist is small and every entry is justified", () => {
  assert.ok(ALLOWLIST.length <= 5, `allowlist grew to ${ALLOWLIST.length}`);
  for (const entry of ALLOWLIST) {
    assert.ok(entry.reason.trim().length > 40, `thin reason for ${entry.file}`);
  }
});
