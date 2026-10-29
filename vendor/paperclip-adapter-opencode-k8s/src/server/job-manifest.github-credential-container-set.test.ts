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
const CREDENTIAL_SECRET_RE = /^paperclip-github-[a-z0-9-]*token$/;

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

type Routes = Record<string, { mounts: string[]; pointers: string[]; values: string[] }>;

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
function credentialRoutes(): Routes {
  const spec = buildJobManifest({ ctx, selfPod }).job.spec!.template!.spec! as k8s.V1PodSpec;

  const secretByVolume = new Map(
    (spec.volumes ?? [])
      .filter((volume) => volume.secret?.secretName)
      .map((volume) => [volume.name, volume.secret!.secretName!]),
  );
  const lists: ReadonlyArray<readonly [string, k8s.V1Container[]]> = [
    ["initContainers", spec.initContainers ?? []],
    ["containers", spec.containers ?? []],
  ];

  const credentialPaths: string[] = [];
  for (const [, containers] of lists) {
    for (const container of containers) {
      for (const mount of container.volumeMounts ?? []) {
        const normalized = mount.mountPath.replace(/\/+$/, "") || "/";
        if (
          CREDENTIAL_MOUNT_RE.test(normalized) ||
          CREDENTIAL_SECRET_RE.test(secretByVolume.get(mount.name) ?? "")
        ) {
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
            CREDENTIAL_SECRET_RE.test(secretByVolume.get(mount.name) ?? ""),
        )
        .map((mount) => mount.mountPath.replace(/\/+$/, "") || "/");
      const declared = (container.env ?? []).map((entry) => entry.name);
      const pointers = CREDENTIAL_ENV_POINTERS.filter((name) => declared.includes(name));
      const values = CREDENTIAL_ENV_VALUES.filter((name) => declared.includes(name));
      if (mounts.length === 0 && pointers.length === 0 && values.length === 0) continue;
      routes[`${kind}/${container.name}`] = {
        mounts: [...new Set(mounts)].sort(),
        pointers: pointers.sort(),
        values: values.sort(),
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
      },
    });
  });

  it("the prompt init container never receives the credential", () => {
    expect(Object.keys(credentialRoutes())).not.toContain("initContainers/write-prompt");
  });

  it("the matchers would fire on the shapes this test exists to reject", () => {
    expect(CREDENTIAL_MOUNT_RE.test(TOKEN_MOUNT)).toBe(true);
    expect(CREDENTIAL_SECRET_RE.test("paperclip-github-mcp-token")).toBe(true);
    expect(CREDENTIAL_MOUNT_RE.test("/var/run/paperclip-github-broker")).toBe(false);
    expect(coversCredentialPath("/etc/paperclip/secrets", [TOKEN_MOUNT])).toBe(true);
    expect(coversCredentialPath("/var/run/authbot", [TOKEN_MOUNT])).toBe(false);
  });
});
