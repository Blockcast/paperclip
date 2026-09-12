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
    /ARG PENSTOCK_RUNTIME_REF=9878ca2499ea8a8e24ec7d8bcf3222db65ac014a/,
  );
  assert.match(
    dockerfile,
    /ARG PENSTOCK_RUNTIME_SHA256=961f38a5901fe5f775188d99ca542781f8dddec42f1e2ad0100a62b6bf409324/,
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
  assert.doesNotMatch(dockerfile, /PENSTOCK_RUNTIME_TOKEN/);
  assert.doesNotMatch(agentDockerfile, /PENSTOCK_API_KEY\s*=\s*[^$\s]/);
});

test("the Docker workflow keeps launcher credentials separate from vendor credentials", () => {
  assert.match(
    dockerWorkflow,
    /gh_token=\$\{\{ secrets\.PAPERCLIP_BOARD_TOKEN \}\}/,
  );
  assert.match(
    dockerWorkflow,
    /uses: actions\/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349 # v2\.2\.2/,
  );
  assert.match(dockerWorkflow, /app-id: \$\{\{ vars\.COMMITPERCLIP_APP_ID \}\}/);
  assert.match(
    dockerWorkflow,
    /private-key: \$\{\{ secrets\.COMMITPERCLIP_KEY \}\}/,
  );
  assert.match(dockerWorkflow, /owner: Blockcast/);
  assert.match(dockerWorkflow, /repositories: penstock-llm-proxy-core/);
  assert.match(dockerWorkflow, /permission-contents: read/);
  assert.match(
    dockerWorkflow,
    /penstock_runtime_token=\$\{\{ steps\.penstock-runtime-token\.outputs\.token \}\}/,
  );
  assert.doesNotMatch(
    dockerWorkflow,
    /penstock_runtime_token=\$\{\{ secrets\.PAPERCLIP_BOARD_TOKEN \}\}/,
  );
  assert.doesNotMatch(dockerWorkflow, /secrets\.PENSTOCK_RUNTIME_TOKEN/);

  const runtimeBuild = dockerWorkflow.indexOf("- name: Build and push stable runtime image");
  const tokenMint = dockerWorkflow.indexOf("- name: Mint read-only Penstock runtime token");
  const consumingBuild = dockerWorkflow.indexOf("- name: Build and push\n", tokenMint);
  assert.ok(runtimeBuild >= 0 && runtimeBuild < tokenMint);
  assert.ok(tokenMint < consumingBuild);
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
  assert.match(
    dockerfile,
    /\/opt\/penstock\/ponytail\/\.claude-plugin\/plugin\.json/,
  );
  assert.match(
    dockerfile,
    /\/opt\/penstock\/ponytail\/\.opencode\/plugins\/ponytail\.mjs/,
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

test("rollout runbook requires one Kubernetes canary and adapter-specific plugin loading", () => {
  assert.match(runbook, /Kubernetes-only/i);
  assert.match(runbook, /one named non-production agent/i);
  assert.match(runbook, /`claude_k8s`/);
  assert.match(runbook, /`opencode_k8s`/);
  assert.doesNotMatch(runbook, /`claude_local`/);
  assert.match(runbook, /worker-only Kubernetes Secret binding/i);
  assert.match(runbook, /worker:\n\s+extraEnv:[\s\S]*name: PENSTOCK_API_KEY/);
  assert.match(runbook, /must not appear in the\s+API Deployment/i);
  assert.match(runbook, /\/opt\/penstock\/ponytail`[\s\S]*Claude `--plugin-dir`/);
  assert.match(
    runbook,
    /\/opt\/penstock\/ponytail\/\.opencode\/plugins\/ponytail\.mjs`[\s\S]*Generated OpenCode config/,
  );
  assert.match(runbook, /PONYTAIL_DEFAULT_MODE/);
  assert.match(runbook, /127\.0\.0\.1/);
  assert.match(runbook, /\.ok == true|\"ok\": true/);
  assert.match(runbook, /caveman\.proxy\.health\.v1/);
  assert.match(runbook, /billing[\s\S]*byok/i);
  assert.match(runbook, /successful completion cleanup[\s\S]*cancelled-run cleanup/i);
  assert.match(runbook, /allocation_missing/);
  assert.doesNotMatch(runbook, /PENSTOCK_API_KEY\s*=\s*sk-/i);
});
