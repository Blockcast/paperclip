import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

// BLO-40279. Secret volumes used to mount at /paperclip/.secrets/<name>, i.e.
// beneath persistence.mountPath. A CephFS re-mount of /paperclip then stacked a
// fresh mount over the old one in three long-running pods and hid every secret
// mount underneath it — without restarting anything, so nothing noticed. The
// `git`/`gh` wrapper exited 1 on every call for ~16 hours and 32 worktree
// validations across 16 issues were recorded as "not a git checkout".
//
// Worse than the outage: the uncovered path is a mode-2775 directory on the
// volume the whole fleet shares, so PAPERCLIP_GITHUB_TOKEN_FILE kept resolving —
// to somewhere any agent uid can write a token of its choosing.
//
// This asserts the structural property that makes both impossible: nothing
// carrying credentials may be nested under the shared data volume. It is the
// guard, not the fix — the fix is the mountPath in values.blockcast.yaml, and
// without this test the next person to add a secret volume reintroduces it.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function renderTemplate(template) {
  return execFileSync(
    "helm",
    [
      "template", "paperclip", "deploy/helm/paperclip",
      "--namespace", "paperclip",
      "-f", "deploy/helm/paperclip/values.blockcast.yaml",
      "--show-only", template,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

/** mountPath values that sit strictly below `root` (so `root` itself passes). */
function nestedUnder(mountPaths, root) {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return mountPaths.filter((mount) => mount.startsWith(prefix));
}

function mountPathsIn(rendered) {
  // `- mountPath:` as well as `mountPath:`. extraVolumeMounts render via toYaml,
  // so the credential mounts — the ones this test is about — are the list-item
  // spelling. A regex without the optional dash matches only the chart's own
  // inline mounts and silently passes; that is how the first draft of this file
  // survived its own mutation test.
  return [...rendered.matchAll(/^\s*(?:-\s+)?mountPath:\s*"?([^"\s]+)"?\s*$/gm)].map((match) => match[1]);
}

const DATA_VOLUME = "/paperclip";
// Where BLO-40279 moved the credential mounts to. Used as the list-item-spelling
// anti-vacuity anchor below, so renaming the leaf (github-token) stays free
// while losing the mounts entirely goes red.
const SECRET_MOUNT_ROOT = "/etc/paperclip/secrets";

// Both workloads render the same `.Values.env.extra` block and the same
// `extraVolumeMounts`, so both carry the credential pointers and both can lose
// the mounts behind them. Checking only the StatefulSet would leave the exact
// BLO-40279 shape — a `*_FILE` pointer with no mount under it — reachable in the
// API pod with every assertion in this file still green.
const WORKLOADS = ["templates/statefulset.yaml", "templates/deployment-api.yaml"];

for (const template of WORKLOADS) {
  test(`${template}: no volume mounts under the shared data volume (BLO-40279)`, () => {
    const rendered = renderTemplate(template);
    const mounts = mountPathsIn(rendered);

    // Anti-vacuity, two halves — both spellings must be seen, because the two
    // render differently and only one of them is what this test polices.
    // `/paperclip` is an inline `mountPath:`, so it stays matched even if the
    // optional `- ` is dropped from the regex above; asserting it alone leaves
    // these two tests green through exactly the regression the comment at
    // mountPathsIn() warns about. The credential mounts are the list-item
    // spelling, so anchoring on the secrets root fails closed if that half of
    // the regex ever stops matching — which is the half that matters here.
    assert.ok(mounts.includes(DATA_VOLUME), `expected a ${DATA_VOLUME} mount in ${template}; found ${mounts.join(", ")}`);
    assert.ok(
      mounts.some((mount) => mount.startsWith(`${SECRET_MOUNT_ROOT}/`)),
      `expected a list-item-spelled mount under ${SECRET_MOUNT_ROOT} in ${template}; found ${mounts.join(", ")}`,
    );

    assert.deepEqual(
      nestedUnder(mounts, DATA_VOLUME),
      [],
      `mounts nested under ${DATA_VOLUME} are hidden by a CephFS re-mount and land on a fleet-writable path`,
    );
  });

  test(`${template}: every *_FILE env pointer resolves under a mount this chart actually declares (BLO-40279)`, () => {
    const rendered = renderTemplate(template);
    const pointers = [...rendered.matchAll(/name:\s*(\w*_FILE)\s*\n\s*value:\s*"?([^"\s]+)"?/g)];
    // Every *_FILE name, however its value is supplied. The pointer regex above
    // only matches a literal `value:` on the following line, so counting it
    // alone lets a third pointer added with `valueFrom:` slip past at
    // length === 2 — silently, which is the one thing the exact count exists to
    // prevent. Counting the names separately is what makes the tripwire real.
    const declared = [...rendered.matchAll(/name:\s*(\w*_FILE)\s*$/gm)];

    // Anti-vacuity: a regex that stops matching would pass this file silently.
    // Two today — PAPERCLIP_GITHUB_TOKEN_FILE and
    // PAPERCLIP_GBRAIN_AUTHBOT_SERVICE_KEY_FILE. Scoping this to the first one
    // is what let the second go unexamined until review. Exact, not >=: a third
    // pointer should fail here once and be looked at, which is the examination
    // that did not happen for the second. Adding one? Confirm its path is
    // mount-covered below, then bump this to 3.
    assert.equal(
      declared.length,
      2,
      `expected exactly 2 *_FILE env pointers in the rendered ${template}; found ${declared.length} (${declared.map(([, name]) => name).join(", ")})`,
    );
    // A non-literal pointer is not mount-checkable by the loop below, so it must
    // not pass as if it had been. Fail here and decide deliberately.
    assert.equal(
      pointers.length,
      declared.length,
      `${declared.length - pointers.length} *_FILE pointer(s) in ${template} are not literal-valued, so the mount-coverage check below cannot see them`,
    );

    const mounts = mountPathsIn(rendered);
    for (const [, name, value] of pointers) {
      assert.equal(
        nestedUnder([value], DATA_VOLUME).length,
        0,
        `${name} resolves to ${value}, under the fleet-shared data volume`,
      );

      // The stronger half, and the one this PR's premise demands: "not under
      // /paperclip" alone passes a typo like /etc/paperclip/secret/github-token
      // (singular) that no volume backs. BLO-40279 *was* the variable continuing
      // to resolve after its mount went away, so what is worth locking is that
      // the path is covered by a mount the chart declares — not merely that it
      // sits somewhere else.
      assert.ok(
        mounts.some((mount) => value.startsWith(`${mount}/`)),
        `${name} resolves to ${value}, which no declared mountPath covers; mounts: ${mounts.join(", ")}`,
      );
    }
  });
}

test("nestedUnder would fail on the shape this test exists to reject", () => {
  // A green assertion proves nothing unless it would go red on the bad input.
  assert.deepEqual(nestedUnder(["/paperclip/.secrets/github-token"], DATA_VOLUME), [
    "/paperclip/.secrets/github-token",
  ]);
  assert.deepEqual(nestedUnder(["/paperclip"], DATA_VOLUME), []);
  assert.deepEqual(nestedUnder(["/paperclip-other/x"], DATA_VOLUME), []);
});
