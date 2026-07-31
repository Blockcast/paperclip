import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const workflowsDir = path.resolve(".github/workflows");
const workflowFiles = (await readdir(workflowsDir))
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
  .sort();
const violations = [];

for (const file of workflowFiles) {
  const lines = (await readFile(path.join(workflowsDir, file), "utf8")).split("\n");

  for (const [index, line] of lines.entries()) {
    const runner = line.match(/^\s*runs-on:\s*(.*?)\s*(?:#.*)?$/)?.[1];
    if (!runner) continue;

    if (/\b(?:ubuntu|windows|macos)-[\w.-]+\b|\bself-hosted\b/i.test(runner)) {
      violations.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  }
}

if (violations.length > 0) {
  console.error("GitHub-hosted and legacy self-hosted runner labels are forbidden; use default, arc-light, arc-dind, arc-deploy, or arc-e2e:");
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${workflowFiles.length} workflows: all runner labels use ARC.`);
}
