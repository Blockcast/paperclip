import { describe, it, expect } from "vitest";
import type * as k8s from "@kubernetes/client-node";
import { buildJobManifest, type JobBuildInput } from "./job-manifest.js";

// PEN-4990 / PEN-3183 §7.2 trigger 3, the MOUNT half, on the opencode agent Job.
//
// The sibling of job-manifest.github-credential-container-set.test.ts in the
// claude_k8s adapter, and it exists because that one does not cover this
// builder. `opencode_k8s` is a registered external-lifecycle adapter type
// (packages/shared/src/validators/agent.ts) with its own `buildJobManifest`,
// its own container list, and the same Secret propagation — so "which
// containers receive the github.com credential in an agent Job" is only half
// answered by asserting it for claude_k8s.
//
// One real difference from the claude_k8s builder, worth knowing before
// reading a failure here: this adapter has NO publish broker
// (`enableGitHubPublishBroker` is not a thing it reads), so there is one
// arrangement rather than two, and the credential is the agent container's.
//
// ───────────────────────────────────────────────────────────────────────────
// ⚠ THIS TEST IS DIRECTION-BLIND, DELIBERATELY. READ THE DIFF BEFORE READING
//   A RED AS A SECURITY FINDING.
//
// §7.2 makes direction the whole distinction: a change that REMOVES a
// credential route from uid 1000 is not trigger 3 even though it rearranges
// containers — §7.4's refusal is the worked example. This file pins an exact
// map, so it reds on a removal exactly as loudly as on an addition and cannot
// tell them apart. A red means "the declared credential-container map moved",
// never "a credential route widened".
// ───────────────────────────────────────────────────────────────────────────

const TOKEN_MOUNT = "/etc/paperclip/secrets/github-token";
// A second credential-shaped volume whose Secret is NOT on the agent
// inheritance allowlist. Unlike the claude_k8s sibling — which filters at
// capture time and so never sees one — this builder filters at build time
// (`isAgentInheritableSecretVolume` inside the propagation loop), so feeding it
// one here asserts that filter still holds: it must appear in no container.
const UNLISTED_TOKEN_MOUNT = "/etc/paperclip/secrets/github-second-token";

// Restated rather than imported from the production predicate: a predicate that
// stops matching fails OPEN, and a test sharing it would go green in exactly
// that case.
const CREDENTIAL_MOUNT_RE = /^\/etc\/paperclip\/secrets\/github-[a-z0-9-]*token$/;
// The Secret names behind those mounts. Checked IN ADDITION to the path,
// because the two failure modes are different: mounting the same Secret
// somewhere new defeats a path-only check, and mounting a renamed Secret at
// the credential path defeats a name-only one.
//
// FAILS CLOSED, and that is the whole design. An earlier draft anchored this
// on a `token` SUFFIX, which meant a credential Secret renamed to
// `paperclip-github-pat` was invisible to both the Secret-name half and the
// `secretRefs` bucket — and `secretRefs` has no path to fall back on, because
// a `secretKeyRef` names no path at all. So the family is credential-bearing
// BY DEFAULT and the exceptions are enumerated: a new `paperclip-github-*`
// Secret is treated as a credential until someone says otherwise. A false
// positive is a red a human reads; a false negative is silence, which is the
// failure this whole file exists to prevent. Raised by review on #3103.
//
// The exclusions are control-plane credentials that never reach an agent and
// are covered by a DIFFERENT control — the server-only inheritance allowlist,
// backstopped by `findServerOnlyEnvVarsInPodSpec`. Folding them in here would
// merge two controls into one assertion and make a red ambiguous. This set is
// part of the declared surface: adding to it is a decision, not a cleanup.
//
// An entry must name a Secret that ACTUALLY EXISTS, and the reason it is out
// of scope must be the different control above — not merely that it looks
// administrative. An exclusion for a name nothing uses excludes nothing today
// and pre-approves a hole tomorrow: whoever later creates a Secret under that
// exact name gets silence from this file instead of a red. Both entries here
// are live `secretKeyRef` targets in the StatefulSet; a third was dropped on
// #3103 for failing exactly this test.
const NON_CREDENTIAL_GITHUB_SECRETS = new Set([
  "paperclip-github-app-creds",
  "paperclip-github-webhook-secret",
]);

function isCredentialSecretName(name: string): boolean {
  return /^paperclip-github-[a-z0-9-]+$/.test(name) && !NON_CREDENTIAL_GITHUB_SECRETS.has(name);
}

const CREDENTIAL_ENV_POINTERS = ["PAPERCLIP_GITHUB_TOKEN_FILE"];
const CREDENTIAL_ENV_VALUES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "GH_SEAT_TOKEN_VALUE",
];

const selfPod = {
  namespace: "paperclip",
  image: "paperclipai/paperclip:latest",
  imagePullSecrets: [],
  nodeSelector: {},
  tolerations: [],
  inheritedEnv: { PAPERCLIP_GITHUB_TOKEN_FILE: `${TOKEN_MOUNT}/token` },
  inheritedEnvValueFrom: [],
  inheritedEnvFrom: [],
  pvcClaimName: "paperclip-data",
  dnsConfig: undefined,
  secretVolumes: [
    {
      volumeName: "github-token",
      secretName: "paperclip-github-mcp-token",
      mountPath: TOKEN_MOUNT,
      defaultMode: 0o444,
    },
    {
      volumeName: "github-second-token",
      secretName: "paperclip-github-second-token",
      mountPath: UNLISTED_TOKEN_MOUNT,
      defaultMode: 0o444,
    },
    // A non-GitHub Secret, so "holds any Secret" cannot pass for "holds the
    // credential".
    {
      volumeName: "authbot-key",
      secretName: "authbot-mcp-consumer-service-keys",
      mountPath: "/var/run/authbot",
      defaultMode: 0o444,
    },
  ],
} as unknown as JobBuildInput["selfPod"];

const ctx = {
  runId: "run123456",
  agent: { id: "agent-abc", name: "Test Agent", companyId: "co123", adapterType: "opencode_k8s", adapterConfig: null },
  runtime: { sessionId: null, sessionParams: {}, sessionDisplayId: null, taskKey: null },
  config: {},
  context: {
    taskId: null,
    issueId: null,
    paperclipWorkspace: null,
    issueIds: null,
    paperclipWorkspaces: null,
    paperclipRuntimeServiceIntents: null,
    paperclipRuntimeServices: null,
  },
  onLog: async () => {},
} as unknown as JobBuildInput["ctx"];

type Routes = Record<
  string,
  { mounts: string[]; pointers: string[]; values: string[]; secretRefs: string[] }
>;

/**
 * Routes that name the credential SECRET rather than a path or a variable name.
 *
 * Two of them here, and both were green in the first draft of this file:
 *
 *   env[].valueFrom.secretKeyRef  — the token under ANY variable name, which is
 *                                   why a name list cannot see it;
 *   envFrom[].secretRef           — every key of the Secret, under names nothing
 *                                   here ever observes.
 *
 * (Projected volumes are handled in the volume->Secret map, not here.)
 *
 * This is a LIVE path for agent Jobs, not a hypothetical: `k8s-client.ts`
 * captures the Deployment container's `valueFrom` entries and its allowlisted
 * `envFrom` sources — filtered by env NAME only, never by referenced Secret —
 * and `job-manifest.ts` emits both into the agent container. Raised by review
 * on #3103.
 */
function secretRefRoutes(container: k8s.V1Container): string[] {
  const routes: string[] = [];
  for (const entry of container.env ?? []) {
    const secret = entry.valueFrom?.secretKeyRef?.name;
    if (typeof secret === "string" && isCredentialSecretName(secret)) {
      routes.push(`${entry.name} -> ${secret}`);
    }
  }
  for (const source of container.envFrom ?? []) {
    const secret = source.secretRef?.name;
    if (typeof secret === "string" && isCredentialSecretName(secret)) {
      routes.push(`envFrom -> ${secret}`);
    }
  }
  return routes.sort();
}


function coversCredentialPath(mountPath: string, credentialPaths: string[]): boolean {
  const normalized = mountPath.replace(/\/+$/, "") || "/";
  return credentialPaths.some(
    (credential) => credential === normalized || credential.startsWith(`${normalized}/`),
  );
}

/**
 * Container -> the github.com credential routes it receives.
 *
 * Read off the ASSEMBLED pod spec over every container list, so a container
 * added later is covered automatically rather than silently bypassing this.
 */
function credentialRoutes(selfPodOverride: JobBuildInput["selfPod"] = selfPod): Routes {
  const spec = buildJobManifest({ ctx, selfPod: selfPodOverride }).job.spec!.template!.spec! as k8s.V1PodSpec;

  // volumeMount name -> the Secret names it exposes. A `projected` volume is
  // included: its sources carry the same Secret under a different key, so a
  // projected credential mounted at a non-credential path would be invisible
  // to both the path matcher and a `.secret.secretName`-only lookup.
  const secretByVolume = new Map<string, string[]>();
  for (const volume of spec.volumes ?? []) {
    const names = [
      volume.secret?.secretName,
      ...(volume.projected?.sources ?? []).map((source) => source.secret?.name),
    ].filter((name): name is string => typeof name === "string");
    if (names.length > 0) secretByVolume.set(volume.name, names);
  }
  const volumeExposesCredential = (name: string): boolean =>
    (secretByVolume.get(name) ?? []).some((secret) => isCredentialSecretName(secret));
  const lists: ReadonlyArray<readonly [string, k8s.V1Container[]]> = [
    ["initContainers", spec.initContainers ?? []],
    ["containers", spec.containers ?? []],
    // Not rendered by this builder today. Listed so the three copies of this
    // walker (chart + both adapters) keep the same shape rather than drifting.
    ["ephemeralContainers", (spec.ephemeralContainers ?? []) as unknown as k8s.V1Container[]],
  ];

  const credentialPaths: string[] = [];
  for (const [, containers] of lists) {
    for (const container of containers) {
      for (const mount of container.volumeMounts ?? []) {
        const normalized = mount.mountPath.replace(/\/+$/, "") || "/";
        if (CREDENTIAL_MOUNT_RE.test(normalized) || volumeExposesCredential(mount.name)) {
          credentialPaths.push(normalized);
        }
      }
    }
  }

  const routes: Routes = {};
  for (const [kind, containers] of lists) {
    for (const container of containers) {
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
      routes[`${kind}/${container.name}`] = {
        mounts: [...new Set(mounts)].sort(),
        pointers: pointers.sort(),
        values: values.sort(),
        secretRefs,
      };
    }
  }
  return routes;
}

describe("which opencode agent-Job containers receive a github.com credential (PEN-4990 / PEN-3183 §7.2 trigger 3)", () => {
  it("exactly the agent container, and only the allowlisted Secret", () => {
    const routes = credentialRoutes();
    // Anti-vacuity: a matcher that stopped matching would reduce this to `{}`
    // and pass silently.
    expect(Object.keys(routes).length).toBeGreaterThan(0);
    expect(routes).toEqual({
      "containers/opencode": {
        // The unlisted Secret is absent, which is the inheritance allowlist
        // doing its job. Were it to appear here, this adapter would be handing
        // agents a credential the claude_k8s one refuses them.
        mounts: [TOKEN_MOUNT],
        pointers: ["PAPERCLIP_GITHUB_TOKEN_FILE"],
        values: [],
        secretRefs: [],
      },
    });
  });

  it("the prompt init container never receives the credential", () => {
    expect(Object.keys(credentialRoutes())).not.toContain("initContainers/write-prompt");
  });

  it("sees a credential bound by secretKeyRef under an allowlisted env name", () => {
    // Raised by review on #3103, and the reason the `secretRefs` bucket exists.
    // The first draft left `inheritedEnvValueFrom` / `inheritedEnvFrom` empty in
    // the fixture, so this path was never exercised and a credential arriving
    // by `secretKeyRef` scored as no route at all.
    //
    // Both halves are asserted, because this adapter differs from the
    // claude_k8s one in a way worth pinning: it RE-APPLIES
    // `isAgentInheritableEnvName` at BUILD time (job-manifest.ts, the
    // `inheritedEnvValueFrom` loop), where claude_k8s trusts the capture-time
    // filter and emits what it is given.
    //
    //   `MY_TOKEN`      — not allowlisted, dropped here. Recorded as current
    //                     behaviour, NOT relied on as the boundary: it is an
    //                     env-NAME filter and says nothing about which Secret
    //                     is referenced.
    //   `ANTHROPIC_GH`  — matches the `ANTHROPIC_` allowed prefix, so it passes
    //                     the name filter while referencing the credential
    //                     Secret. This is the route that actually reaches the
    //                     agent container, and the one the bucket must see.
    //
    // Asserting only the dropped half would be vacuous — it would pass with the
    // detector deleted.
    const routes = credentialRoutes({
      ...selfPod,
      inheritedEnvValueFrom: [
        {
          name: "MY_TOKEN",
          valueFrom: { secretKeyRef: { name: "paperclip-github-mcp-token", key: "token" } },
        },
        {
          name: "ANTHROPIC_GH",
          valueFrom: { secretKeyRef: { name: "paperclip-github-mcp-token", key: "token" } },
        },
        // Negative control: a non-GitHub Secret by the same route, under an
        // allowlisted prefix, must not register — or "any secretKeyRef" would
        // be passing for "the credential".
        {
          name: "ANTHROPIC_AUTHBOT",
          valueFrom: { secretKeyRef: { name: "authbot-mcp-consumer-service-keys", key: "k" } },
        },
      ],
    } as unknown as JobBuildInput["selfPod"]);

    expect(routes["containers/opencode"]?.secretRefs).toEqual([
      "ANTHROPIC_GH -> paperclip-github-mcp-token",
    ]);
  });

  it("the matchers would fire on the shapes this test exists to reject", () => {
    expect(CREDENTIAL_MOUNT_RE.test(TOKEN_MOUNT)).toBe(true);
    expect(isCredentialSecretName("paperclip-github-mcp-token")).toBe(true);
    // Fails CLOSED on a rename: the family counts by default, so a credential
    // Secret that stops being spelled "...token" is still seen. The
    // suffix-anchored first draft missed this, and `secretRefs` has no path to
    // fall back on. Raised by review on #3103.
    expect(isCredentialSecretName("paperclip-github-pat")).toBe(true);
    // The enumerated exceptions: control-plane credentials covered by a
    // different control (see the header). Both are live `secretKeyRef`
    // targets in the StatefulSet, so without the exception the exact-equality
    // expectations would red on them.
    expect(isCredentialSecretName("paperclip-github-app-creds")).toBe(false);
    expect(isCredentialSecretName("paperclip-github-webhook-secret")).toBe(false);
    // `paperclip-github-app-key` WAS a third exception and is deliberately no
    // longer one: no Secret by that name exists in the chart, the server, or
    // either adapter, so it excluded nothing and pre-approved a hole. The one
    // place the name appears outside these files is `inherit-allowlist.test.ts`,
    // which uses it as the example of a server-only Secret that must NOT reach
    // an agent — the opposite of the only stated intent for it. It is a
    // credential by default now. Raised by review on #3103.
    expect(isCredentialSecretName("paperclip-github-app-key")).toBe(true);
    expect(isCredentialSecretName("gbrain-authbot-service-key")).toBe(false);
    expect(CREDENTIAL_MOUNT_RE.test("/var/run/paperclip-github-broker")).toBe(false);
    expect(coversCredentialPath("/etc/paperclip/secrets", [TOKEN_MOUNT])).toBe(true);
    expect(coversCredentialPath("/var/run/authbot", [TOKEN_MOUNT])).toBe(false);
  });
});
