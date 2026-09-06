#!/usr/bin/env node
/**
 * check-workflow-structure.mjs
 * Fails when a workflow file contains a non-blank line at column 0 that is not a
 * valid top-level YAML construct.
 *
 * Export: findDedentedLines(source) → [{ line, text }]
 *
 * BLO-23128: `f94d521` wrote an `alert-on-failure` heredoc body and its closing
 * `EOF` at column 0 *inside* a `run: |` block scalar. Column 0 terminates the
 * block scalar, so YAML then reads the heredoc prose as a new top-level key and
 * the whole document fails to parse:
 *
 *     could not find expected ':' while scanning a simple key
 *       at line 423 column 1
 *
 * That defect is invisible to every existing gate. GitHub does not report
 * "your workflow is invalid" — it manufactures a run that fails instantly with
 * zero jobs, so there is no failing job for a required check to notice, and the
 * `alert-on-failure` job added to catch a red pipeline could never itself run.
 * Agent image delivery was dead for ~9h before a human spotted it by hand.
 *
 * Why this rule rather than a real YAML parse: the `policy` job that hosts the
 * repo's validators never installs node_modules (every check there is
 * Node-builtins-only), and `js-yaml` is present in the lockfile transitively,
 * not as a resolvable direct dependency. This rule needs no parser, is decidable
 * from the text alone, and has no false positives across the repo's workflows.
 *
 * Known limit — this is deliberately a targeted structural gate, not a YAML
 * validator. A dedented line that still *looks* like a mapping key (the
 * `Run: ${RUN_URL}` line in the same broken heredoc) is accepted in isolation,
 * because at column 0 it is genuinely valid top-level YAML. It is the file, not
 * every individual line, that this check is required to reject — and the broken
 * file is rejected on its other seven lines. A full `actionlint` gate remains
 * the strictly-stronger follow-up once a pinning/vendoring decision is made.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A line at column 0 may legitimately be: a mapping key (`on:`, `jobs:`), a
// comment, a document marker, or blank. Anything else means content has escaped
// the block scalar that was supposed to contain it.
const VALID_TOP_LEVEL = /^(?:[A-Za-z_][A-Za-z0-9_.-]*\s*:|#|---|\.\.\.)/;

export function findDedentedLines(source) {
  const offenders = [];
  source.split('\n').forEach((text, index) => {
    if (text.length === 0) return; // blank
    if (/^\s/.test(text)) return; // indented — inside some block, fine
    if (VALID_TOP_LEVEL.test(text)) return; // valid top-level construct
    offenders.push({ line: index + 1, text });
  });
  return offenders;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const workflowsDir = path.resolve('.github/workflows');
  const files = readdirSync(workflowsDir)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .sort();

  let failed = 0;
  for (const file of files) {
    const source = readFileSync(path.join(workflowsDir, file), 'utf8');
    for (const { line, text } of findDedentedLines(source)) {
      failed += 1;
      console.error(
        `.github/workflows/${file}:${line}: line is at column 0 but is not valid ` +
          `top-level YAML — it has escaped its block scalar: ${JSON.stringify(text.slice(0, 80))}`,
      );
    }
  }

  if (failed > 0) {
    console.error(
      `\n${failed} dedented line(s) found. A line at column 0 ends the enclosing ` +
        `\`run: |\` block, which corrupts the document; GitHub then reports the ` +
        `workflow as an instant 0-job failure rather than a parse error. ` +
        `Indent heredoc bodies (and their closing EOF) to the block-scalar level — ` +
        `YAML strips the common indent, so the shell still receives EOF at column 0.`,
    );
    process.exit(1);
  }

  console.log(`Checked ${files.length} workflow file(s): no dedented block-scalar content.`);
}
