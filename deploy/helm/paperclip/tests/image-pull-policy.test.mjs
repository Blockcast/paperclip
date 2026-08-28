// Regression guard for BLO-29306.
//
// Both paperclip tiers used to render `imagePullPolicy: Always` on top of a
// digest-pinned image ref. A digest cannot be republished, so `Always` could
// never pick up new content there — it only forced every pod start to
// re-resolve the manifest against harbor.blockcast.net, whose stateful backend
// runs on the same `workload=paperclip` node pool as paperclip itself. That
// made paperclip's recovery path depend on a component that fails with it:
// node churn degrades Harbor, and degraded Harbor then blocks paperclip from
// restarting (BLO-29180, BLO-23736, BLO-15520).
//
// Without this test the next chart edit silently reintroduces the coupling, so
// the assertions below pin BOTH directions of the invariant:
//
//   digest pinned  -> policy must not be Always (no pointless registry hop)
//   no digest      -> policy must be Always     (mutable tags must re-resolve)
//
// The second half is what keeps the fix from regressing BLO-21660 / BLO-28304:
// `IfNotPresent` is only safe *because* the pin exists, and the documented
// manual `helm upgrade` path passes no digest.

import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

// A real, syntactically valid manifest digest. Shape is asserted by
// .github/workflows/docker.yml before it reaches helm, so the test uses the
// same shape the deploy job guarantees.
const DIGEST =
  "sha256:e809f6e5e0e97325490793a376985e957c315c9082c691d26f7d650dd5d9705a";

// Every rendered container and initContainer across both tiers. The worker
// StatefulSet carries two image refs (the `seed` initContainer and the worker
// container itself), so a fix applied to only one of them would pass a
// single-site assertion and still leave a cold-pull path.
const TIERS = [
  { name: "api Deployment", showOnly: "templates/deployment-api.yaml", refs: 1 },
  { name: "worker StatefulSet", showOnly: "templates/statefulset.yaml", refs: 2 },
];

function render({ showOnly, blockcastValues = true, extraArgs = [] }) {
  return execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      "deploy/helm/paperclip",
      "--namespace",
      "paperclip",
      ...(blockcastValues
        ? ["-f", "deploy/helm/paperclip/values.blockcast.yaml"]
        : []),
      "--show-only",
      showOnly,
      "--set",
      "api.enabled=true",
      ...extraArgs,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

function pullPolicies(rendered) {
  return [...rendered.matchAll(/^\s*imagePullPolicy:\s*(\S+)\s*$/gm)].map(
    (match) => match[1],
  );
}

for (const tier of TIERS) {
  test(`${tier.name}: digest-pinned render never declares Always (BLO-29306)`, () => {
    // Mirrors what every CI deploy path in docker.yml actually does:
    // `--set image.tag=... --set-string image.digest=sha256:...`.
    const rendered = render({
      showOnly: tier.showOnly,
      extraArgs: ["--set-string", `image.digest=${DIGEST}`],
    });

    // Guard the guard: if the render stopped being digest-pinned, an
    // IfNotPresent assertion below would be asserting something unsafe rather
    // than something correct.
    assert.match(
      rendered,
      new RegExp(`image:\\s*\\S+@${DIGEST}`),
      "expected the rendered image ref to be digest-pinned",
    );

    const policies = pullPolicies(rendered);
    assert.equal(
      policies.length,
      tier.refs,
      `expected ${tier.refs} imagePullPolicy site(s), found ${policies.length}`,
    );
    for (const policy of policies) {
      assert.equal(
        policy,
        "IfNotPresent",
        "a digest-pinned ref must not re-resolve the manifest on every pod " +
          "start — that is the Harbor coupling BLO-29306 removed",
      );
    }
    assert.doesNotMatch(rendered, /imagePullPolicy:\s*Always/);
  });

  test(`${tier.name}: tag-only render still declares Always (BLO-21660)`, () => {
    // The documented manual path (`helm upgrade -f values.blockcast.yaml`)
    // passes no digest, leaving the mutable `sha-` tag in play. A republished
    // tag must still be re-resolved, so this branch must NOT be IfNotPresent.
    const rendered = render({ showOnly: tier.showOnly });

    assert.doesNotMatch(
      rendered,
      /image:\s*\S+@sha256:/,
      "expected a tag-based ref when no digest is supplied",
    );

    const policies = pullPolicies(rendered);
    assert.equal(policies.length, tier.refs);
    for (const policy of policies) {
      assert.equal(
        policy,
        "Always",
        "a floating tag can be republished, so it must re-resolve on start",
      );
    }
  });
}

test("upstream chart defaults are unchanged (floating tag keeps its own policy)", () => {
  // AC-3: the change is scoped to digest-pinned images only. values.yaml ships
  // `tag: latest` with an explicit `pullPolicy: IfNotPresent`; an explicit
  // value must keep winning over the derivation, or this commit would have
  // silently changed behaviour for tag-based installs it was never about.
  const rendered = render({
    showOnly: "templates/deployment-api.yaml",
    blockcastValues: false,
    // api.enabled requires an RWX claim; values.blockcast.yaml supplies one and
    // the upstream defaults do not. Irrelevant to the pull policy, but the
    // template refuses to render without it.
    extraArgs: ["--set", "persistence.existingClaim=paperclip-data"],
  });

  assert.doesNotMatch(rendered, /image:\s*\S+@sha256:/);
  for (const policy of pullPolicies(rendered)) {
    assert.equal(policy, "IfNotPresent");
  }
});

test("an explicit pullPolicy overrides the digest-derived default", () => {
  // Escape hatch for a forced re-pull (e.g. chasing a suspected corrupt local
  // layer) without editing templates.
  const rendered = render({
    showOnly: "templates/deployment-api.yaml",
    extraArgs: [
      "--set-string",
      `image.digest=${DIGEST}`,
      "--set",
      "image.pullPolicy=Always",
    ],
  });

  for (const policy of pullPolicies(rendered)) {
    assert.equal(policy, "Always");
  }
});
