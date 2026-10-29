import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

// PEN-4990 / PEN-3183 §7.2 trigger 3, the MOUNT half.
//
// The trigger reads: "Any change that widens read access to the token Secret,
// or mounts it into a new container." It has two halves and only one of them
// was asserted anywhere:
//
//   /etc/gitconfig system helper -> agent-egress-path.test.mjs (source) and
//                                   scripts/check-agent-image-git-config.mjs
//                                   (image). Covered, twice.
//   which containers get the token -> nothing. This file.
//
// `secret-mounts-outside-data-volume.test.mjs` looks like it covers this and
// does not: it asserts WHERE a secret volume may sit (BLO-40279 — nothing
// credential-bearing nested under the shared data volume), which is a different
// property from WHICH containers can open the github.com credential. Both of
// its assertions stay green while the token is added to a brand-new container,
// as long as the new mount is outside /paperclip.
//
// ───────────────────────────────────────────────────────────────────────────
// ⚠ THIS TEST IS DIRECTION-BLIND, DELIBERATELY. READ THE DIFF BEFORE READING
//   A RED AS A SECURITY FINDING.
//
// §7.2 is explicit that direction is what distinguishes the trigger from a
// legitimate rearrangement: a change that REMOVES a credential route from
// uid 1000 is not trigger 3 even though it moves containers around — §7.4's
// refusal is the worked example. This file pins an exact set, so it reds on a
// removal exactly as loudly as on an addition, and it cannot tell them apart.
//
// That is accepted rather than fixed: the gate's job is to stop a widening
// landing UNNOTICED, and a human reads the diff either way. A red here means
// "the declared credential-container set moved" — not "a credential route
// widened". Decide which by reading the direction, then update the declared
// set below in the same commit if the move was intended.
//
// The same limitation is written up for the /etc/gitconfig half at
// agent-egress-path.test.mjs; this is the third assertion of the same shape,
// and it is not an oversight in any of them.
// ───────────────────────────────────────────────────────────────────────────
//
// Scope note: the GitHub App private key (`paperclip-github-app-creds`, reached
// via GITHUB_APP_PRIVATE_KEY) is also a github.com credential, and is
// deliberately NOT matched here. It is a control-plane credential that never
// reaches an agent, and the control that keeps it there is a different one —
// the server-only inheritance allowlist, backstopped by
// `findServerOnlyEnvVarsInPodSpec` in the k8s adapters. Folding it in here
// would merge two controls into one assertion and make a red ambiguous.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const chartDir = "deploy/helm/paperclip";

/**
 * The whole chart, not one template.
 *
 * `--show-only` takes a list of templates the author already thought of, and
 * the trigger this file watches is "mounts it into a NEW container" — which
 * includes a new container in a new workload file. Rendering everything and
 * walking the result is the only form of this assertion that covers a template
 * nobody remembered to add to a list.
 */
function renderChart(valuesFile) {
  const args = ["template", "paperclip", chartDir, "--namespace", "paperclip"];
  if (valuesFile) args.push("-f", `${chartDir}/${valuesFile}`);
  return execFileSync("helm", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Rendered YAML -> one JSON object per document. */
function documents(rendered) {
  // `-I=0` puts each document on a single line, so splitting on newlines is a
  // document split rather than a guess about YAML structure.
  const json = execFileSync("yq", ["eval", "-o=json", "-I=0", "."], {
    cwd: repoRoot,
    input: rendered,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return json
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
    .filter((doc) => doc !== null && typeof doc === "object");
}

/**
 * Every PodSpec in a document, wherever it is nested.
 *
 * Found structurally — any object carrying a `containers` array is a PodSpec —
 * rather than by looking under `spec.template.spec`. A CronJob nests its pod
 * template one level deeper (`spec.jobTemplate.spec.template.spec`), and this
 * chart renders no CronJob today; a path-based walker would therefore pass
 * silently on the day one is added with the credential mounted into it.
 */
function podSpecsIn(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) podSpecsIn(item, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node.containers)) out.push(node);
  for (const value of Object.values(node)) podSpecsIn(value, out);
  return out;
}

// The mount path the credential's consumers resolve. Kept as a literal here
// rather than imported from the adapter's `isGitHubCredentialSecretVolume`,
// on purpose: a predicate that stops matching fails OPEN, and a test that
// shares it would go green in exactly that case. Two statements of the same
// path disagree loudly; one statement cannot.
const CREDENTIAL_MOUNT_RE = /^\/etc\/paperclip\/secrets\/github-[a-z0-9-]*token$/;

// The Secret names behind those mounts. Checked IN ADDITION to the path,
// because the two failure modes are different: mounting the same Secret
// somewhere new defeats a path-only check, and mounting a renamed Secret at
// the credential path defeats a name-only one.
const CREDENTIAL_SECRET_RE = /^paperclip-github-[a-z0-9-]*token$/;

// Env routes BY NAME. `PAPERCLIP_GITHUB_TOKEN_FILE` is a POINTER, not a
// credential — under the PEN-4933 broker the agent keeps it with no mount
// behind it, which is intended. The remaining four carry a credential VALUE;
// §7.4 decided they stay refused rather than routed.
//
// ⚠ Matching env routes by NAME alone is not enough, and a name list is the
// wrong shape for the cheapest widening: a `secretKeyRef` to the credential
// Secret works under ANY variable name, so a container could hold the token as
// `MY_TOKEN` and be invisible to this list. The `secretRefs` bucket below
// closes that by matching the referenced SECRET instead of the variable name.
// Raised by review on #3103; the first draft of this file gave a green for all
// three of the routes that bucket now covers.
const CREDENTIAL_ENV_POINTERS = ["PAPERCLIP_GITHUB_TOKEN_FILE"];
const CREDENTIAL_ENV_VALUES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "GH_SEAT_TOKEN_VALUE",
];

/** Does `mountPath` sit at, or above, a path the credential is mounted at? */
function coversCredentialPath(mountPath, credentialPaths) {
  const normalized = mountPath.replace(/\/+$/, "") || "/";
  return credentialPaths.some(
    (credential) => credential === normalized || credential.startsWith(`${normalized}/`),
  );
}

/**
 * Routes that name the credential SECRET rather than a path or a variable name.
 *
 * Two of them live here:
 *
 *   env[].valueFrom.secretKeyRef  — the token under any variable name at all,
 *                                   which is why a name list cannot see it;
 *   envFrom[].secretRef           — every key of the Secret, under names
 *                                   nothing here ever observes.
 *
 * The third of the same family, a `projected` volume carrying the Secret to any
 * path, is handled in `secretByVolume` instead, because it reaches a container
 * through a mount rather than through the environment. All three were green in
 * the first draft of this file.
 *
 * Reported as `NAME -> secret` / `envFrom -> secret` so a failure says which
 * binding appeared rather than only that the count changed.
 */
function secretRefRoutes(container) {
  const routes = [];
  for (const entry of container.env ?? []) {
    const secret = entry?.valueFrom?.secretKeyRef?.name;
    if (typeof secret === "string" && CREDENTIAL_SECRET_RE.test(secret)) {
      routes.push(`${entry.name} -> ${secret}`);
    }
  }
  for (const source of container.envFrom ?? []) {
    const secret = source?.secretRef?.name;
    if (typeof secret === "string" && CREDENTIAL_SECRET_RE.test(secret)) {
      routes.push(`envFrom -> ${secret}`);
    }
  }
  return routes.sort();
}

/**
 * Container -> the github.com credential routes it receives, across the whole
 * rendered chart, keyed so a human can read the answer off a failure message.
 */
function credentialRoutes(rendered) {
  return routesFromDocuments(documents(rendered));
}

/** The walker proper, split out so it can be driven from a synthetic manifest. */
function routesFromDocuments(docs) {
  const routes = {};

  for (const doc of docs) {
    const workload = `${doc.kind}/${doc.metadata?.name ?? "<unnamed>"}`;
    for (const podSpec of podSpecsIn(doc)) {
      // volumeMount name -> the Secret names it exposes, for the secretName
      // half of the check. A `projected` volume is included: its sources carry
      // the same Secret under a different key, so a projected credential
      // mounted at a non-credential path would otherwise be invisible to both
      // the path matcher and a `.secret.secretName`-only lookup.
      const secretByVolume = new Map();
      for (const volume of podSpec.volumes ?? []) {
        const names = [
          volume?.secret?.secretName,
          ...(volume?.projected?.sources ?? []).map((source) => source?.secret?.name),
        ].filter((name) => typeof name === "string");
        if (names.length > 0) secretByVolume.set(volume.name, names);
      }
      const volumeExposesCredential = (name) =>
        (secretByVolume.get(name) ?? []).some((secret) => CREDENTIAL_SECRET_RE.test(secret));
      // Every path in THIS pod at which a credential is mounted. Collected per
      // pod so the ancestor check below has something concrete to compare
      // against, rather than assuming the literal path is the one in use.
      const credentialPaths = [];
      for (const kind of ["initContainers", "containers", "ephemeralContainers"]) {
        for (const container of podSpec[kind] ?? []) {
          for (const mount of container.volumeMounts ?? []) {
            const normalized = mount.mountPath.replace(/\/+$/, "") || "/";
            if (CREDENTIAL_MOUNT_RE.test(normalized) || volumeExposesCredential(mount.name)) {
              credentialPaths.push(normalized);
            }
          }
        }
      }

      for (const kind of ["initContainers", "containers", "ephemeralContainers"]) {
        for (const container of podSpec[kind] ?? []) {
          const mounts = (container.volumeMounts ?? [])
            .filter(
              (mount) =>
                coversCredentialPath(mount.mountPath, credentialPaths) ||
                volumeExposesCredential(mount.name),
            )
            .map((mount) => mount.mountPath.replace(/\/+$/, "") || "/");
          const declared = (container.env ?? []).map((entry) => entry.name);
          const pointers = CREDENTIAL_ENV_POINTERS.filter((name) => declared.includes(name));
          const values = CREDENTIAL_ENV_VALUES.filter((name) => declared.includes(name));
          const secretRefs = secretRefRoutes(container);
          if (
            mounts.length === 0 &&
            pointers.length === 0 &&
            values.length === 0 &&
            secretRefs.length === 0
          )
            continue;
          routes[`${workload} :: ${kind}/${container.name}`] = {
            mounts: [...new Set(mounts)].sort(),
            pointers: pointers.sort(),
            values: values.sort(),
            secretRefs,
          };
        }
      }
    }
  }
  return routes;
}

const TOKEN = "/etc/paperclip/secrets/github-token";
const MERGE_TOKEN = "/etc/paperclip/secrets/github-merge-token";

/**
 * The declared set, as deployed. Measured off the render on 2026-10-29, not
 * copied from intent.
 *
 * `seed` is the one worth a second look by anyone editing this: the init
 * container can OPEN the credential and is given no pointer to it. That is the
 * shape this file exists to make visible — a container holding a credential it
 * has no declared use for. It is recorded, not endorsed; narrowing it is a
 * removal, which per the direction warning above reds this test and is fine.
 */
const EXPECTED_BLOCKCAST_ROUTES = {
  "Deployment/paperclip-api :: containers/paperclip": {
    mounts: [MERGE_TOKEN, TOKEN],
    pointers: ["PAPERCLIP_GITHUB_TOKEN_FILE"],
    values: [],
    secretRefs: [],
  },
  "StatefulSet/paperclip :: initContainers/seed": {
    mounts: [MERGE_TOKEN, TOKEN],
    pointers: [],
    values: [],
    secretRefs: [],
  },
  "StatefulSet/paperclip :: containers/paperclip": {
    mounts: [MERGE_TOKEN, TOKEN],
    pointers: ["PAPERCLIP_GITHUB_TOKEN_FILE"],
    values: [],
    secretRefs: [],
  },
};

test("values.blockcast.yaml: exactly these containers receive a github.com credential (PEN-3183 §7.2 trigger 3)", () => {
  const routes = credentialRoutes(renderChart("values.blockcast.yaml"));

  // Anti-vacuity before the comparison, so a walker that stopped finding
  // anything fails here with a legible message instead of reducing the
  // deepEqual below to `{} === {}` on the day someone deletes the mounts.
  assert.ok(
    Object.keys(routes).length > 0,
    "found no credential-bearing container at all; the walker or the matchers have stopped matching",
  );

  assert.deepEqual(
    routes,
    EXPECTED_BLOCKCAST_ROUTES,
    "the set of containers holding a github.com credential changed; read the DIRECTION of the diff " +
      "(see the header) — an addition is PEN-3183 §7.2 trigger 3 and ends the residual acceptance early, " +
      "a removal is not a trigger and only needs the declared set updated here",
  );
});

test("default values: this chart ships no github.com credential to any container", () => {
  // The credential mounts live in values.blockcast.yaml, so every other
  // deployment of this chart has none. Moving them into the chart's defaults
  // would hand the credential to every installation at once — a widening, and
  // the broadest form of trigger 3 available.
  //
  // Not vacuous despite asserting an absence: the test above proves the same
  // walker finds three containers when they are there.
  assert.deepEqual(credentialRoutes(renderChart(null)), {});
});

test("the matchers would fire on the shapes this test exists to reject", () => {
  // A green assertion proves nothing unless it goes red on the bad input.
  assert.ok(CREDENTIAL_MOUNT_RE.test(TOKEN));
  assert.ok(CREDENTIAL_MOUNT_RE.test(MERGE_TOKEN));
  assert.ok(CREDENTIAL_SECRET_RE.test("paperclip-github-mcp-token"));
  assert.ok(CREDENTIAL_SECRET_RE.test("paperclip-github-merge-token"));

  // The broker's socket and private dirs carry "github" in the name and are
  // NOT credentials. Matching them would make every brokered pod look like a
  // widening and train the next reader to ignore this test.
  assert.ok(!CREDENTIAL_MOUNT_RE.test("/var/run/paperclip-github-broker"));
  assert.ok(!CREDENTIAL_MOUNT_RE.test("/var/lib/paperclip-github-broker"));
  assert.ok(!CREDENTIAL_SECRET_RE.test("paperclip-github-app-creds"));

  // A parent mount reaches the credential underneath it; that is a widening
  // the exact-path check alone would miss.
  assert.ok(coversCredentialPath("/etc/paperclip/secrets", [TOKEN]));
  assert.ok(coversCredentialPath("/etc", [TOKEN]));
  assert.ok(coversCredentialPath(TOKEN, [TOKEN]));
  assert.ok(!coversCredentialPath("/etc/paperclip/secrets-other", [TOKEN]));
  assert.ok(!coversCredentialPath("/var/run/authbot", [TOKEN]));
});

test("podSpecsIn finds a pod template nested the way a CronJob nests one", () => {
  const cronJob = {
    kind: "CronJob",
    spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: "c" }] } } } } },
  };
  assert.deepEqual(
    podSpecsIn(cronJob).map((spec) => spec.containers[0].name),
    ["c"],
  );
});

test("the walker sees the three Secret-named routes that do not name a credential path", () => {
  // Raised by review on #3103. The first draft of this file matched mounts by
  // path or by `volumes[].secret.secretName`, and env routes by VARIABLE NAME.
  // All three shapes below were green under that draft, and each is a complete
  // route to the token: the kubelet resolves a `secretKeyRef` into the
  // container's environment regardless of what the variable is called, an
  // `envFrom` injects every key of the Secret under names nothing observes, and
  // a `projected` volume carries the same Secret to any path at all.
  //
  // Not hypothetical for agent Jobs: `k8s-client.ts` captures the Deployment's
  // `valueFrom` entries and allowlisted `envFrom` sources — filtered only by
  // env NAME — and `job-manifest.ts` emits them into the agent container.
  //
  // Driven from a synthetic manifest because this chart renders none of the
  // three today. Asserting their absence from the real render would pass with
  // the detector removed; this fails if the detector stops seeing them.
  const synthetic = {
    kind: "Deployment",
    metadata: { name: "synthetic" },
    spec: {
      template: {
        spec: {
          volumes: [
            {
              name: "projected-cred",
              projected: { sources: [{ secret: { name: "paperclip-github-mcp-token" } }] },
            },
          ],
          containers: [
            {
              name: "by-secret-key-ref",
              // Deliberately NOT one of CREDENTIAL_ENV_VALUES: the whole point
              // is that the variable may be called anything.
              env: [
                {
                  name: "MY_TOKEN",
                  valueFrom: { secretKeyRef: { name: "paperclip-github-mcp-token", key: "token" } },
                },
              ],
            },
            {
              name: "by-env-from",
              envFrom: [{ secretRef: { name: "paperclip-github-merge-token" } }],
            },
            {
              name: "by-projected-volume",
              // Mounted far away from /etc/paperclip/secrets, so only the
              // Secret-name half can see it.
              volumeMounts: [{ name: "projected-cred", mountPath: "/tmp/anywhere" }],
            },
            {
              // Negative control: a non-credential Secret by every route.
              name: "unrelated",
              env: [
                {
                  name: "OTHER",
                  valueFrom: { secretKeyRef: { name: "gbrain-authbot-service-key", key: "k" } },
                },
              ],
              envFrom: [{ secretRef: { name: "paperclip-github-app-creds" } }],
            },
          ],
        },
      },
    },
  };

  assert.deepEqual(routesFromDocuments([synthetic]), {
    "Deployment/synthetic :: containers/by-secret-key-ref": {
      mounts: [],
      pointers: [],
      values: [],
      secretRefs: ["MY_TOKEN -> paperclip-github-mcp-token"],
    },
    "Deployment/synthetic :: containers/by-env-from": {
      mounts: [],
      pointers: [],
      values: [],
      secretRefs: ["envFrom -> paperclip-github-merge-token"],
    },
    "Deployment/synthetic :: containers/by-projected-volume": {
      mounts: ["/tmp/anywhere"],
      pointers: [],
      values: [],
      secretRefs: [],
    },
    // `unrelated` is absent: the App creds are a control-plane credential kept
    // out of scope here on purpose (see the header), and the authbot key is
    // not a github.com credential at all.
  });
});
