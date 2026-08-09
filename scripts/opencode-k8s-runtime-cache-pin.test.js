import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const opencodeRefMatch = dockerfile.match(/^ARG OPENCODE_K8S_REF=([0-9a-f]{40})$/m);

test("Dockerfile pins opencode_k8s and retains finite-timeout, security, and execution regressions", () => {
  assert.equal(opencodeRefMatch?.[1], "ed0331690432d3c37cd7ed190ca1066c840b30c3");
  assert.match(dockerfile, /add anthropic\/claude-opus-5/);
  assert.match(dockerfile, /BLO-22922, start completion grace only after/);
  assert.match(dockerfile, /preserve successful finite-timeout runs/);
  assert.match(
    dockerfile,
    /npm test -- src\/server\/env-guard-plugin\.test\.ts src\/server\/execute\.test\.ts/,
  );
  assert.match(dockerfile, /mount a per-agent\s*\n# \/runtime-cache emptyDir/);
  assert.match(dockerfile, /kkroo\/paperclip-adapter-opencode-k8s#29/);
  assert.match(dockerfile, /reserve the runtime-cache env keys/);
  assert.match(dockerfile, /kkroo\/paperclip-adapter-opencode-k8s#30/);
  assert.doesNotMatch(dockerfile, /OPENCODE_K8S_REF=861227d3d0726b43bf7e4a5421d076e3ab8de0af/);
  assert.doesNotMatch(dockerfile, /OPENCODE_K8S_REF=cac7d0b53fa420beb756919561004f1b5b709fa2/);
  assert.doesNotMatch(dockerfile, /OPENCODE_K8S_REF=42d2d995a2f966e134f1b62a637497f9fe98c101/);
  assert.doesNotMatch(dockerfile, /OPENCODE_K8S_REF=8f4272675db81e95bf393679a912d9037df3d9ab/);
});
