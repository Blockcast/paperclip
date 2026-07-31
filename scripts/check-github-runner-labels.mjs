import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const workflowsDir = path.resolve(".github/workflows");
const workflowFiles = (await readdir(workflowsDir))
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
  .sort();
const ALLOWED_RUNNERS = new Set(["default", "arc-light", "arc-dind", "arc-deploy", "arc-e2e"]);
const violations = [];

for (const file of workflowFiles) {
  const lines = (await readFile(path.join(workflowsDir, file), "utf8")).split("\n");

  for (const [index, line] of lines.entries()) {
    const runner = line.match(/^\s*runs-on:\s*(.*?)\s*(?:#.*)?$/)?.[1];
    if (!runner) continue;

    if (!ALLOWED_RUNNERS.has(runner)) {
      violations.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  }
}

if (violations.length > 0) {
  console.error(`Runner labels must use one of: ${[...ALLOWED_RUNNERS].join(", ")}:`);
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${workflowFiles.length} workflows: all runner labels use ARC.`);
}
