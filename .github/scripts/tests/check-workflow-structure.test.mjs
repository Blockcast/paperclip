import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDedentedLines } from '../check-workflow-structure.mjs';

// The exact shape of the BLO-23128 regression: a heredoc body and its closing
// `EOF` written at column 0 inside a `run: |` block scalar.
const BROKEN = `name: Docker (agent base)
jobs:
  alert-on-failure:
    steps:
      - name: File tracking issue
        run: |
          cat > /tmp/body.md <<'EOF'
\`Docker (agent base)\` failed on master at commit \${HEAD_SHA}.
EOF
          gh issue create --body-file /tmp/body.md
`;

// Same file with the heredoc body and EOF indented to the block-scalar level.
// YAML strips the common indent, so the shell still gets EOF at column 0.
const FIXED = `name: Docker (agent base)
jobs:
  alert-on-failure:
    steps:
      - name: File tracking issue
        run: |
          cat > /tmp/body.md <<'EOF'
          \`Docker (agent base)\` failed on master at commit \${HEAD_SHA}.
          EOF
          gh issue create --body-file /tmp/body.md
`;

test('flags heredoc content dedented out of its block scalar', () => {
  const offenders = findDedentedLines(BROKEN);
  assert.equal(offenders.length, 2);
  assert.deepEqual(
    offenders.map((o) => o.line),
    [8, 9],
  );
  assert.match(offenders[0].text, /^`Docker \(agent base\)`/);
  assert.equal(offenders[1].text, 'EOF');
});

test('accepts the indented form that keeps the block scalar intact', () => {
  assert.deepEqual(findDedentedLines(FIXED), []);
});

test('accepts ordinary top-level keys, comments and document markers', () => {
  const source = ['---', '# a comment', 'name: CI', 'on:', '  push:', 'jobs:', '  build:', ''].join(
    '\n',
  );
  assert.deepEqual(findDedentedLines(source), []);
});

test('accepts keys containing dots, dashes and underscores', () => {
  assert.deepEqual(findDedentedLines('run-name: x\nsome_key: y\nfoo.bar: z\n'), []);
});

test('does not flag indented content, however deep', () => {
  assert.deepEqual(findDedentedLines('jobs:\n  a:\n    steps:\n      - run: |\n        EOF\n'), []);
});

test('flags a bare closing EOF at column 0', () => {
  const offenders = findDedentedLines('jobs:\n  a:\n    run: |\n      cat <<EOF\nEOF\n');
  assert.deepEqual(
    offenders.map((o) => o.text),
    ['EOF'],
  );
});

test('reports 1-indexed line numbers matching what YAML parsers cite', () => {
  // The real failure was reported at "line 423 column 1"; line numbers must be
  // 1-indexed so an operator can jump straight to the offending line.
  const offenders = findDedentedLines('name: x\n)bad\n');
  assert.equal(offenders[0].line, 2);
});

test('is a no-op on an empty file', () => {
  assert.deepEqual(findDedentedLines(''), []);
});
