import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const opencodeRefMatch = dockerfile.match(/^ARG OPENCODE_K8S_REF=([0-9a-f]{40})$/m);

test("Dockerfile pins opencode_k8s and runs its security and execution regressions", () => {
  assert.equal(opencodeRefMatch?.[1], "2075ae1ba249e97c49a77386c81a9d88b22c481d");
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
  // 2075ae1ba249e97c49a77386c81a9d88b22c481d retains the lifecycle recovery and
  // timeout fixes, adds optional Caveman/Penstock and Ponytail launchers, and
  // constrains server-pod credential inheritance. This pin must never regress
  // to a pre-fix commit that reports exitCode:0 runs as timed_out.
  assert.doesNotMatch(dockerfile, /OPENCODE_K8S_REF=83197d46b0784c941801165464d48aca1b979909/);
  // BLO-33204: 87a865de was #62's branch head and is content-identical to the
  // 2075ae1b squash above (same tree, cd60d847...), so re-pinning to it would
  // look harmless in review. It is ORPHANED — reachable from no ref — and
  // `git clone` fetches only ref-reachable objects, so the vendor stage dies
  // with `fatal: unable to read tree` on any build that misses its cache. The
  // identical content is exactly why this needs an explicit assertion rather
  // than trusting a reviewer to spot it.
  assert.doesNotMatch(dockerfile, /OPENCODE_K8S_REF=87a865ded22d3ac4655b1c3fa1ad47473f23e7d8/);
});

test("the server-side Dockerfile pin assertion stays in sync with the Dockerfile", () => {
  // BLO-33204: the pin is asserted in TWO suites. On the first re-pin attempt this
  // one was updated and server/src/__tests__/docker-opencode-runtime-pin.test.ts was
  // not, so the two suites asserted opposite things about the same line and CI went
  // red after the fix was otherwise complete. Compare them directly rather than
  // relying on whoever moves the pin next to remember there is a second copy.
  const serverPinTest = readFileSync(
    new URL("../server/src/__tests__/docker-opencode-runtime-pin.test.ts", import.meta.url),
    "utf8",
  );
  const mirrored = serverPinTest.match(/ARG OPENCODE_K8S_REF=([0-9a-f]{40})/);
  assert.ok(mirrored, "server pin test no longer asserts an ARG OPENCODE_K8S_REF pin");
  assert.equal(
    mirrored[1],
    opencodeRefMatch?.[1],
    "server pin test expects a different OPENCODE_K8S_REF than the Dockerfile pins",
  );
});
