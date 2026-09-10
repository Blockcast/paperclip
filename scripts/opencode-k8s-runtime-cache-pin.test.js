import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const opencodeRefMatch = dockerfile.match(/^ARG OPENCODE_K8S_REF=([0-9a-f]{40})$/m);

test("Dockerfile pins opencode_k8s and runs its security and execution regressions", () => {
  assert.equal(opencodeRefMatch?.[1], "87a865ded22d3ac4655b1c3fa1ad47473f23e7d8");
  assert.match(dockerfile, /add anthropic\/claude-opus-5/);
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
  // 87a865ded22d3ac4655b1c3fa1ad47473f23e7d8 retains the lifecycle recovery and
  // timeout fixes, adds optional Caveman/Penstock and Ponytail launchers, and
  // constrains server-pod credential inheritance. This pin must never regress
  // to a pre-fix commit that reports exitCode:0 runs as timed_out.
  assert.doesNotMatch(dockerfile, /OPENCODE_K8S_REF=83197d46b0784c941801165464d48aca1b979909/);
});
