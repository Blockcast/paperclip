import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/refresh-shard-manifest.yml", import.meta.url),
  "utf8",
);

function stepBlock(name, nextName) {
  const start = workflow.indexOf(`\n      - name: ${name}\n`);
  assert.notEqual(start, -1, `refresh workflow must define the ${name} step`);
  const end = workflow.indexOf(`\n      - name: ${nextName}\n`, start + 1);
  assert.notEqual(end, -1, `refresh workflow must define ${nextName} after ${name}`);
  return workflow.slice(start, end);
}

test("refresh refuses to create a GITHUB_TOKEN-authored pull request", () => {
  assert.match(
    workflow,
    /COMMITPERCLIP_ENABLED: \$\{\{ secrets\.COMMITPERCLIP_KEY != '' \}\}/,
  );

  const credentialGuard = stepBlock(
    "Require commitperclip App credential",
    "Download measured durations",
  );
  assert.match(credentialGuard, /if: env\.COMMITPERCLIP_ENABLED != 'true'/);
  assert.match(credentialGuard, /exit 1/);

  const upsert = stepBlock("Create or update pull request", "Alert if the refresh PR got no CI");
  assert.match(upsert, /GH_TOKEN: \$\{\{ steps\.bot-token\.outputs\.value \}\}/);
  assert.doesNotMatch(
    upsert,
    /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}|\|\|\s*github\.token/,
  );
  assert.match(
    upsert,
    /git push(?: --force(?:-with-lease)?)? "https:\/\/x-access-token:\$\{GH_TOKEN\}@github\.com\/\$\{\{ github\.repository \}\}\.git" "\$BRANCH"/,
  );
  assert.match(upsert, /git config user\.email "shard-manifest-bot@paperclip\.blockcast\.net"/);
  assert.doesNotMatch(upsert, /git config user\.email .*allyblockcast\[bot\]/);
  assert.doesNotMatch(upsert, /git push(?: --force)? origin/);
  assert.doesNotMatch(workflow, /\|\|\s*github\.token/);
});

test("refresh keeps partial-shard recovery and uses the workflow token for the alarm", () => {
  assert.match(workflow, /needs: \[measure\][\s\S]*?if: \$\{\{ !cancelled\(\) \}\}/);
  assert.match(workflow, /permissions:[\s\S]*?actions: read/);
  assert.match(workflow, /permissions:[\s\S]*?pull-requests: write/);

  const alarmStart = workflow.indexOf("\n      - name: Alert if the refresh PR got no CI\n");
  assert.notEqual(alarmStart, -1, "refresh workflow must retain the no-CI alarm");
  const alarm = workflow.slice(alarmStart);
  assert.match(alarm, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(alarm, /GH_TOKEN: \$\{\{ steps\.bot-token\.outputs\.value \}\}/);
  assert.match(alarm, /action_required_count/);
  assert.match(alarm, /total_run_count/);
});
