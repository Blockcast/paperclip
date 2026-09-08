import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const agentDockerfile = readFileSync(
  path.join(repoRoot, "Dockerfile.agent"),
  "utf8",
);
const dockerWorkflow = readFileSync(
  path.join(repoRoot, ".github/workflows/docker.yml"),
  "utf8",
);
const runbook = readFileSync(
  path.join(repoRoot, "docs/runbooks/penstock-claude-local-rollout.md"),
  "utf8",
);

function dockerStage(name) {
  const lines = dockerfile.split("\n");
  const start = lines.findIndex((line) => line === `FROM base AS ${name}`);
  assert.notEqual(start, -1, `Dockerfile stage ${name} is present`);
  const end = lines.findIndex((line, index) => index > start && /^FROM /.test(line));
  return lines.slice(start, end === -1 ? lines.length : end).join("\n");
}

function renderStatefulSet() {
  return execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      "deploy/helm/paperclip",
      "--namespace",
      "paperclip",
      "-f",
      "deploy/helm/paperclip/values.blockcast.yaml",
      "--show-only",
      "templates/statefulset.yaml",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

test("production image packages the pinned launcher and Caveman proxy", () => {
  const launcherStage = dockerStage("penstock-agent-runtime");
  assert.match(
    launcherStage,
    /--mount=type=secret,id=penstock_runtime_token/,
  );
  assert.doesNotMatch(
    launcherStage,
    /--mount=type=secret,id=gh_token(?:[^_a-zA-Z0-9]|$)/,
  );
  assert.match(launcherStage, /test -s \/run\/secrets\/penstock_runtime_token/);
  assert.match(
    dockerfile,
    /ARG PENSTOCK_RUNTIME_REF=2823acc1b4d730a86aded6b228f748aa12f40f53/,
  );
  assert.match(
    dockerfile,
    /ARG PENSTOCK_RUNTIME_SHA256=fa6c923f78900919ec6fd3cbfe1c878078dab267e82e5faaa695d0c49f50f29e/,
  );
  assert.match(
    launcherStage,
    /raw\.githubusercontent\.com\/Blockcast\/penstock-llm-proxy-core\//,
  );
  assert.match(
    launcherStage,
    /\$\{PENSTOCK_RUNTIME_REF\}\/scripts\/penstock-agent-runtime\.mjs/,
  );
  assert.match(
    dockerfile,
    /COPY --from=penstock-agent-runtime \/opt\/penstock\/bin\/penstock-agent-runtime\.mjs/,
  );
  assert.match(dockerfile, /ARG CAVEMAN_RELEASE=bin-v1\.1\.6/);
  assert.match(
    dockerfile,
    /5085c65788a569bf978868084bc849261a2acef8c334124d6fc7240a3f83a35c/,
  );
  assert.match(
    dockerfile,
    /6781f31728c403805e2a93af5be9e9535e4b8b1607650d8e0fbbb4b5a9b8ae52/,
  );
  assert.match(dockerfile, /SHA256 mismatch[\s\S]*expected[\s\S]*received/);
  assert.doesNotMatch(dockerfile, /sha256sum --check --status/);
  assert.match(dockerfile, /COPY --from=caveman-proxy \/usr\/local\/bin\/caveman-proxy/);
  assert.doesNotMatch(dockerfile, /PENSTOCK_API_KEY\s*=\s*[^$\s]/);
  assert.doesNotMatch(agentDockerfile, /PENSTOCK_API_KEY\s*=\s*[^$\s]/);
});

test("the Docker workflow keeps launcher credentials separate from vendor credentials", () => {
  assert.match(
    dockerWorkflow,
    /gh_token=\$\{\{ secrets\.PAPERCLIP_BOARD_TOKEN \}\}/,
  );
  assert.match(
    dockerWorkflow,
    /penstock_runtime_token=\$\{\{ secrets\.PENSTOCK_RUNTIME_TOKEN \}\}/,
  );
  assert.doesNotMatch(
    dockerWorkflow,
    /penstock_runtime_token=\$\{\{ secrets\.PAPERCLIP_BOARD_TOKEN \}\}/,
  );
});

test("the agent overlay carries every packaged Penstock runtime asset", () => {
  assert.ok(
    agentDockerfile.includes(
      "COPY --from=server /opt/penstock/bin/penstock-agent-runtime.mjs /opt/penstock/bin/penstock-agent-runtime.mjs",
    ),
  );
  assert.match(
    agentDockerfile,
    /COPY --from=server \/usr\/local\/bin\/caveman-proxy \/usr\/local\/bin\/caveman-proxy/,
  );
  assert.match(
    agentDockerfile,
    /COPY --from=server \/opt\/penstock\/ponytail \/opt\/penstock\/ponytail/,
  );
});

test("production image carries a pinned Ponytail tree without shared activation", () => {
  assert.match(
    dockerfile,
    /ARG PONYTAIL_REF=0a4dd63ad4541f4f655c4108a295916f3c1d8fda/,
  );
  assert.match(
    dockerfile,
    /ARG PONYTAIL_HOOKS_SHA256=dd0837e870a8b81eb45ef4adebfc413a48c6daf84329befd897640f731aa0e39/,
  );
  assert.match(
    dockerfile,
    /git clone --no-tags https:\/\/github\.com\/dietrichgebert\/ponytail\.git/,
  );
  assert.match(dockerfile, /git -C \/tmp\/ponytail checkout --detach/);
  assert.match(dockerfile, /hooks\/claude-codex-hooks\.json/);
  assert.doesNotMatch(dockerfile, /PONYTAIL_ARCHIVE_SHA256|codeload\.github\.com/);
  assert.match(dockerfile, /COPY --from=ponytail-marketplace \/opt\/penstock\/ponytail/);

  const rendered = renderStatefulSet();
  // Forward-looking chart-boundary guards: this PR packages the runtime in
  // Docker and must not activate Ponytail in the shared seed volume.
  assert.doesNotMatch(rendered, /PONYTAIL_REF/);
  assert.doesNotMatch(rendered, /PONYTAIL_MARKETPLACE/);
  assert.doesNotMatch(rendered, /PONYTAIL_MARKER/);
  assert.doesNotMatch(rendered, /ponytail@ponytail/);
  assert.doesNotMatch(rendered, /plugin marketplace add[^\n]*ponytail/i);
  assert.doesNotMatch(rendered, /plugin marketplace remove[^\n]*ponytail/i);
  assert.doesNotMatch(rendered, /plugin uninstall[^\n]*ponytail/i);
  assert.doesNotMatch(rendered, /DietrichGebert\/ponytail/);
});

test("rollout runbook requires one agent, a secret ref, and agent-scoped plugin loading", () => {
  assert.match(runbook, /exactly one[\s\S]*`claude_local`/i);
  assert.match(runbook, /BLO-26540/);
  assert.match(runbook, /BLO-26695/);
  assert.match(runbook, /\"type\": \"secret_ref\"/);
  assert.match(runbook, /\"key\": \"PENSTOCK_API_KEY\"/);
  assert.match(runbook, /\"engine\": \"cli\"/);
  assert.match(runbook, /\"--plugin-dir\"/);
  assert.match(runbook, /PONYTAIL_DEFAULT_MODE/);
  assert.match(runbook, /127\.0\.0\.1/);
  assert.match(runbook, /generic[\s\S]*deliberately skips its normal Claude hello\s+probe/i);
  assert.match(runbook, /caveman\.json/);
  assert.match(runbook, /real Caveman accepted caveman\.json/i);
  assert.doesNotMatch(runbook, /PENSTOCK_API_KEY\s*=\s*sk-/i);
});
