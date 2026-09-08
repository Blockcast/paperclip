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
const runbook = readFileSync(
  path.join(repoRoot, "docs/runbooks/penstock-claude-local-rollout.md"),
  "utf8",
);

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

test("production image pins the Caveman proxy", () => {
  assert.match(dockerfile, /--mount=type=secret,id=gh_token/);
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
  assert.doesNotMatch(dockerfile, /PENSTOCK_API_KEY=/);
});

// BLO-32824. The `penstock-agent-runtime` stage was removed to restore a green
// master build: it fetched the `Blockcast/*` private repo using the `gh_token`
// BuildKit secret, which is `PAPERCLIP_BOARD_TOKEN` — a PAT provisioned for the
// `kkroo/*` vendor clones and with no read on that org repo. Guard the defect
// rather than the absence, so a re-land carrying a correctly-scoped credential
// passes this unchanged.
test("penstock launcher is never fetched with the kkroo-scoped vendor credential", () => {
  const stage = dockerfile.match(
    /FROM base AS penstock-agent-runtime[\s\S]*?(?=\nFROM |\n#|$)/,
  );
  if (!stage) return;
  assert.doesNotMatch(
    stage[0],
    /--mount=type=secret,id=gh_token(?![_a-zA-Z0-9])/,
    "penstock-agent-runtime must not reuse gh_token (PAPERCLIP_BOARD_TOKEN): it cannot read Blockcast/penstock-llm-proxy-core, and GitHub answers 404 not 403 — see BLO-32824",
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
