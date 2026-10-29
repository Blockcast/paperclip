import { describe, it, expect } from "vitest";
import type * as k8s from "@kubernetes/client-node";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildJobManifest } from "./job-manifest.js";
import type { SelfPodInfo } from "./k8s-client.js";

// PEN-4990 / PEN-3183 §7.2 trigger 3, the MOUNT half, on the agent Job.
//
// The trigger reads: "Any change that widens read access to the token Secret,
// or mounts it into a new container." Its /etc/gitconfig half is asserted
// twice over (agent-egress-path.test.mjs for the source,
// scripts/check-agent-image-git-config.mjs for the image). Which containers
// receive the token was asserted nowhere.
//
// `job-manifest.github-publish-broker.test.ts` is the closest thing and is a
// different assertion: it checks the two containers it already knows about —
// the agent must not hold the credential, the broker must — and says nothing
// about the SET. A third container added tomorrow with the Secret mounted into
// it leaves every case in that file green. This file pins the set.
//
// ───────────────────────────────────────────────────────────────────────────
// ⚠ THIS TEST IS DIRECTION-BLIND, DELIBERATELY. READ THE DIFF BEFORE READING
//   A RED AS A SECURITY FINDING.
//
// §7.2 makes direction the whole distinction: a change that REMOVES a
// credential route from uid 1000 is not trigger 3 even though it rearranges
// containers — §7.4's refusal is the worked example, and reading it as a
// trigger would invert the test. This file pins an exact map, so it reds on a
// removal exactly as loudly as on an addition and cannot tell them apart.
//
// Accepted, not overlooked: the gate's job is to stop a widening landing
// UNNOTICED, and a human reads the diff either way. A red means "the declared
// credential-container map moved", never "a credential route widened".
// ───────────────────────────────────────────────────────────────────────────

const TOKEN_MOUNT = "/etc/paperclip/secrets/github-token";
// A SECOND credential-shaped volume, deliberately synthetic.
//
// In production exactly one GitHub Secret reaches an agent Job:
// `AGENT_SECRET_VOLUME_ALLOWLIST` admits only `paperclip-github-mcp-token`,
// and the filter runs at CAPTURE time (k8s-client.ts), so nothing else is ever
// in `selfPod.secretVolumes` to begin with. This fixture feeds a second one
// anyway, past that filter, so the assertions below are about "every
// credential volume lands in exactly these containers" rather than about one
// hard-coded path. Named `-second-` rather than `-merge-` on purpose: the real
// seat token was removed from that allowlist by BLO-24056, and a fixture using
// its name would read as a claim that it still reaches agents. It does not.
const SECOND_TOKEN_MOUNT = "/etc/paperclip/secrets/github-second-token";

// Restated here rather than imported from `isGitHubCredentialSecretVolume`.
// That predicate is what DECIDES the diversion; a test that shared it would go
// green on the day it stopped matching, which is its fail-open direction. Two
// independent statements of the same path disagree loudly.
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
const NON_CREDENTIAL_GITHUB_SECRETS = new Set([
  "paperclip-github-app-creds",
  "paperclip-github-app-key",
  "paperclip-github-webhook-secret",
]);

function isCredentialSecretName(name: string): boolean {
  return /^paperclip-github-[a-z0-9-]+$/.test(name) && !NON_CREDENTIAL_GITHUB_SECRETS.has(name);
}

// A POINTER, not a credential: under the broker the agent keeps it with no
// mount behind it, deliberately (PEN-4933). Reported separately from the
// mounts so a red says which route moved.
//
// ⚠ Matching env routes by NAME is not sufficient on its own, and a name list
// is the wrong shape for the cheapest widening: a `secretKeyRef` binds the
// credential Secret under ANY variable name. `secretRefs` below matches the
// referenced SECRET instead, which is what closes that.
const CREDENTIAL_ENV_POINTERS = ["PAPERCLIP_GITHUB_TOKEN_FILE"];
// Credential VALUES. §7.4 decided these stay refused rather than routed through
// the broker; none is bound in this fixture, so they appear in no expectation
// below. Listed so that binding one to any container shows up as a route here
// instead of passing unexamined.
const CREDENTIAL_ENV_VALUES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "GH_SEAT_TOKEN_VALUE",
];

const baseSelfPod: SelfPodInfo = {
  namespace: "paperclip",
  image: "paperclipai/paperclip:latest",
  imagePullSecrets: [],
  dnsConfig: undefined,
  nodeSelector: {},
  tolerations: [],
  pvcClaimName: "paperclip-data",
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
      mountPath: SECOND_TOKEN_MOUNT,
      defaultMode: 0o444,
    },
    // A non-GitHub Secret, so "every container holding any Secret" cannot pass
    // for "every container holding the credential".
    {
      volumeName: "authbot-key",
      secretName: "gbrain-authbot-service-key",
      mountPath: "/var/run/authbot",
      defaultMode: 0o444,
    },
  ],
  inheritedEnv: { PAPERCLIP_GITHUB_TOKEN_FILE: `${TOKEN_MOUNT}/token` },
  inheritedEnvValueFrom: [],
  inheritedEnvFrom: [],
};

/**
 * Per-run isolation, so `narrowWritableSurface` holds.
 *
 * Not incidental: the builder REFUSES to render the broker under the broad
 * data-mount fallback, so every broker case below would be describing a
 * manifest that cannot exist if this were `null`.
 */
const NARROW_ISOLATION = { isolationMode: "shared", isolationKey: "agent-shared:agent-abc" };

function makeCtx(adapterConfig: Record<string, unknown>): AdapterExecutionContext {
  return {
    runId: "run-abc12345",
    agent: { id: "agent-abc", companyId: "co1", name: "Test Agent", adapterType: "claude_k8s", adapterConfig },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
      isolation: NARROW_ISOLATION,
    },
    config: { serviceAccountName: "test-sa", ...adapterConfig },
    context: {},
    onLog: async () => {},
  } as unknown as AdapterExecutionContext;
}

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


/** Does `mountPath` sit at, or above, a path the credential is mounted at? */
function coversCredentialPath(mountPath: string, credentialPaths: string[]): boolean {
  const normalized = mountPath.replace(/\/+$/, "") || "/";
  return credentialPaths.some(
    (credential) => credential === normalized || credential.startsWith(`${normalized}/`),
  );
}

/**
 * Container -> the github.com credential routes it receives.
 *
 * Read off the ASSEMBLED pod spec, over every container list, rather than off
 * the builder's locals — the same reason the sensitive-env and server-only
 * backstops in job-manifest.ts read the spec back: a container added later is
 * then covered automatically instead of silently bypassing this.
 */
function credentialRoutes(
  adapterConfig: Record<string, unknown>,
  selfPod: SelfPodInfo = baseSelfPod,
): Routes {
  const { job } = buildJobManifest({ ctx: makeCtx(adapterConfig), selfPod });
  const spec = job.spec!.template!.spec! as k8s.V1PodSpec;

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

const BOTH_MOUNTS = [SECOND_TOKEN_MOUNT, TOKEN_MOUNT].sort();

describe("which agent-Job containers receive a github.com credential (PEN-4990 / PEN-3183 §7.2 trigger 3)", () => {
  // Both arrangements are legitimate and §7.2 says so explicitly: the broker
  // receiving a credential IS trigger 3 — a declared, reviewed instance of it,
  // not an exemption. So the expectation is per-arrangement, and an assertion
  // written against only the pre-broker shape (which would red the whole
  // rollout) is the mistake this parameterisation avoids.
  const CASES: ReadonlyArray<readonly [string, Record<string, unknown>, Routes]> = [
    [
      "broker OFF — the agent container holds the credential (today's fleet, §7.1)",
      {},
      {
        "containers/claude": {
          mounts: BOTH_MOUNTS,
          pointers: ["PAPERCLIP_GITHUB_TOKEN_FILE"],
          values: [],
          secretRefs: [],
        },
      },
    ],
    [
      "broker OFF + DinD — the sidecar changes nothing",
      { enableDocker: true },
      {
        "containers/claude": {
          mounts: BOTH_MOUNTS,
          pointers: ["PAPERCLIP_GITHUB_TOKEN_FILE"],
          values: [],
          secretRefs: [],
        },
      },
    ],
    [
      "broker ON — the credential moves to the sidecar; the agent keeps only the pointer",
      { enableGitHubPublishBroker: true },
      {
        "initContainers/github-publish-broker": {
          mounts: BOTH_MOUNTS,
          pointers: ["PAPERCLIP_GITHUB_TOKEN_FILE"],
          values: [],
          secretRefs: [],
        },
        // No `mounts`. The dangling pointer is deliberate (PEN-4933): the
        // wrappers read it, find no file, and fall through to the broker
        // socket. Pinned so that quietly restoring a mount behind it — the
        // exact widening §7.2 names — reds here.
        "containers/claude": { mounts: [], pointers: ["PAPERCLIP_GITHUB_TOKEN_FILE"], values: [], secretRefs: [] },
      },
    ],
    [
      "broker ON + DinD — the sidecar changes nothing",
      { enableGitHubPublishBroker: true, enableDocker: true },
      {
        "initContainers/github-publish-broker": {
          mounts: BOTH_MOUNTS,
          pointers: ["PAPERCLIP_GITHUB_TOKEN_FILE"],
          values: [],
          secretRefs: [],
        },
        "containers/claude": { mounts: [], pointers: ["PAPERCLIP_GITHUB_TOKEN_FILE"], values: [], secretRefs: [] },
      },
    ],
  ];

  for (const [name, adapterConfig, expected] of CASES) {
    it(name, () => {
      const routes = credentialRoutes(adapterConfig);
      // Anti-vacuity: a matcher that stopped matching would reduce a
      // mounts-bearing expectation to `{}` and pass silently.
      expect(Object.keys(routes).length).toBeGreaterThan(0);
      expect(routes).toEqual(expected);
    });
  }

  it("the prompt init container never receives the credential, in either arrangement", () => {
    // Stated as its own case because it is the one container that exists in
    // every arrangement and is easy to hand a mount to by widening a shared
    // volumeMounts list — it already keeps a second, independently built one.
    for (const config of [{}, { enableGitHubPublishBroker: true }]) {
      expect(Object.keys(credentialRoutes(config))).not.toContain("initContainers/write-prompt");
    }
  });

  it("sees a credential bound by secretKeyRef / envFrom, under a name no list contains", () => {
    // Raised by review on #3103, and the reason the `secretRefs` bucket exists.
    //
    // This is the LIVE capture path, not a synthetic shape: `k8s-client.ts`
    // keeps the Deployment container's `valueFrom` entries and its allowlisted
    // `envFrom` sources — filtered by env NAME only, never by which Secret they
    // reference — and this builder emits both into the agent container. The
    // first draft of this file set both to `[]` in the fixture, so the path was
    // never exercised and a credential arriving this way scored as no route at
    // all.
    //
    // `MY_TOKEN` is deliberately a name that appears in NO list in this file.
    // That is the whole point: a `secretKeyRef` binds the Secret whatever the
    // variable is called, so only matching the referenced Secret can see it.
    const routes = credentialRoutes(
      {},
      {
        ...baseSelfPod,
        inheritedEnvValueFrom: [
          {
            name: "MY_TOKEN",
            valueFrom: { secretKeyRef: { name: "paperclip-github-mcp-token", key: "token" } },
          },
          // Negative control: a non-GitHub Secret by the same route must not
          // register, or "any secretKeyRef" would be passing for "the
          // credential".
          {
            name: "AUTHBOT_KEY",
            valueFrom: { secretKeyRef: { name: "gbrain-authbot-service-key", key: "k" } },
          },
        ],
        inheritedEnvFrom: [{ secretRef: { name: "paperclip-github-second-token" } }],
      },
    );

    expect(routes["containers/claude"]?.secretRefs).toEqual([
      "MY_TOKEN -> paperclip-github-mcp-token",
      "envFrom -> paperclip-github-second-token",
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
    // different control (see the header).
    expect(isCredentialSecretName("paperclip-github-app-creds")).toBe(false);
    expect(isCredentialSecretName("paperclip-github-webhook-secret")).toBe(false);
    expect(isCredentialSecretName("gbrain-authbot-service-key")).toBe(false);
    // The broker's socket and private scratch carry "github" and are not
    // credentials; matching them would flag every brokered pod as a widening.
    expect(CREDENTIAL_MOUNT_RE.test("/var/run/paperclip-github-broker")).toBe(false);
    expect(CREDENTIAL_MOUNT_RE.test("/var/lib/paperclip-github-broker")).toBe(false);
    // A parent mount reaches the credential beneath it.
    expect(coversCredentialPath("/etc/paperclip/secrets", [TOKEN_MOUNT])).toBe(true);
    expect(coversCredentialPath("/etc", [TOKEN_MOUNT])).toBe(true);
    expect(coversCredentialPath("/var/run/authbot", [TOKEN_MOUNT])).toBe(false);
  });
});
