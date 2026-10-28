import { describe, it, expect } from "vitest";
import type * as k8s from "@kubernetes/client-node";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildJobManifest } from "./job-manifest.js";
import type { SelfPodInfo } from "./k8s-client.js";

// PEN-4933 / PEN-3183 D1: the boundary test.
//
// The row's acceptance asks for a test that fails if the boundary is REMOVED —
// specifically if the token Secret becomes readable by uid 1000 again. That is
// what the first two cases assert, and they assert it on the rendered manifest
// rather than on the predicate that decides it: a predicate that stops matching
// (a Secret renamed, a mount path moved) fails open silently, and the thing
// worth pinning is the outcome, not the implementation that produces it.
//
// The third case is the positive control. Without it, a change that disabled
// the broker entirely — or that broke `isGitHubCredentialSecretVolume` so that
// nothing ever matched — would leave the first two cases green while asserting
// nothing, because there would be no credential mount for them to look for.

const TOKEN_MOUNT = "/etc/paperclip/secrets/github-token";
const MERGE_TOKEN_MOUNT = "/etc/paperclip/secrets/github-merge-token";

const baseSelfPod: SelfPodInfo = {
  namespace: "paperclip",
  image: "paperclipai/paperclip:latest",
  imagePullSecrets: [],
  dnsConfig: undefined,
  nodeSelector: {},
  tolerations: [],
  pvcClaimName: "paperclip-data",
  secretVolumes: [
    { volumeName: "github-token", secretName: "paperclip-github-token", mountPath: TOKEN_MOUNT, defaultMode: 0o444 },
    {
      volumeName: "github-merge-token",
      secretName: "paperclip-github-merge-token",
      mountPath: MERGE_TOKEN_MOUNT,
      defaultMode: 0o444,
    },
    // A non-GitHub Secret, to pin that the diversion is scoped rather than
    // "every inherited Secret moves to the sidecar".
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

function makeCtx(adapterConfig: Record<string, unknown>): AdapterExecutionContext {
  return {
    runId: "run-abc12345",
    agent: { id: "agent-abc", companyId: "co1", name: "Test Agent", adapterType: "claude_k8s", adapterConfig },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { serviceAccountName: "test-sa", ...adapterConfig },
    context: {},
    onLog: async () => {},
  } as unknown as AdapterExecutionContext;
}

function render(enabled: boolean): k8s.V1PodSpec {
  const { job } = buildJobManifest({
    ctx: makeCtx(enabled ? { enableGitHubPublishBroker: true } : {}),
    selfPod: baseSelfPod,
  });
  return job.spec!.template!.spec!;
}

const agentContainer = (spec: k8s.V1PodSpec) => spec.containers[0]!;
const brokerContainer = (spec: k8s.V1PodSpec) =>
  spec.initContainers?.find((c) => c.name === "github-publish-broker");

/** Paths a container can open, i.e. every mount path it declares. */
const mountPaths = (c: k8s.V1Container | undefined) => (c?.volumeMounts ?? []).map((m) => m.mountPath);

describe("GitHub publish broker boundary (PEN-4933 / PEN-3183 D1)", () => {
  it("removes every GitHub credential mount from the agent container", () => {
    const spec = render(true);
    const agent = mountPaths(agentContainer(spec));
    for (const credential of [TOKEN_MOUNT, MERGE_TOKEN_MOUNT]) {
      // Not merely "the exact path is absent": a mount of any ANCESTOR would
      // put the token back inside the agent's namespace just as effectively.
      for (const path of agent) {
        expect(credential === path || credential.startsWith(`${path}/`)).toBe(false);
      }
    }
    // Scoped, not blanket: the unrelated Secret is still the agent's.
    expect(agent).toContain("/var/run/authbot");
  });

  it("mounts the credential into the broker, at a uid that is not the agent's", () => {
    const spec = render(true);
    const broker = brokerContainer(spec);
    expect(mountPaths(broker)).toEqual(expect.arrayContaining([TOKEN_MOUNT, MERGE_TOKEN_MOUNT]));
    expect(broker?.securityContext?.runAsUser).toBe(1001);
    expect(broker?.securityContext?.runAsUser).not.toBe(agentContainer(spec).securityContext?.runAsUser);
    // §8 is explicit that none of these may be relaxed to make a guard work.
    // The broker needs no privilege at all, so they stay as the agent's.
    expect(broker?.securityContext?.allowPrivilegeEscalation).toBe(false);
    expect(broker?.securityContext?.runAsNonRoot).toBe(true);
    expect(broker?.securityContext?.capabilities?.drop).toEqual(["ALL"]);
    // A native sidecar: starts first, lives for the Job.
    expect(broker?.restartPolicy).toBe("Always");
  });

  it("gives the agent a socket to ask over, and nothing that resembles a token", () => {
    const spec = render(true);
    const agent = agentContainer(spec);
    expect(mountPaths(agent)).toContain("/var/run/paperclip-github-broker");
    expect(agent.env?.find((e) => e.name === "PAPERCLIP_GITHUB_BROKER_SOCKET")?.value).toBe(
      "/var/run/paperclip-github-broker/broker.sock",
    );
    // The agent still resolves PAPERCLIP_GITHUB_TOKEN_FILE — it is inherited
    // from the Deployment and the wrappers read it. What has changed is that
    // the path no longer exists in this container. Asserted because the obvious
    // "fix" for the resulting error message is to put the mount back.
    //
    // Present as a `secretKeyRef`, not a literal: the name matches the
    // sensitive-env pattern, so the builder routes it to the Job's env Secret.
    // That is unrelated to this change and is checked only so the assertion
    // below is known to be reading a variable that exists.
    expect(agent.env?.find((e) => e.name === "PAPERCLIP_GITHUB_TOKEN_FILE")?.valueFrom?.secretKeyRef).toBeTruthy();
    const tokenFile = `${TOKEN_MOUNT}/token`;
    for (const path of mountPaths(agent)) {
      expect(tokenFile.startsWith(`${path}/`)).toBe(false);
    }
  });

  it("shares /tmp with the broker, ahead of the nested prompt mount", () => {
    const spec = render(true);
    const mounts = agentContainer(spec).volumeMounts ?? [];
    const tmp = mounts.findIndex((m) => m.mountPath === "/tmp");
    const prompt = mounts.findIndex((m) => m.mountPath === "/tmp/prompt");
    expect(tmp).toBeGreaterThanOrEqual(0);
    // Parent before child. Kubernetes admits the other order and the child is
    // then unreachable from inside the container (BLO-40401).
    expect(tmp).toBeLessThan(prompt);
    expect(mountPaths(brokerContainer(spec))).toContain("/tmp");
  });

  it("POSITIVE CONTROL: with the broker off, the agent still holds the credential", () => {
    const spec = render(false);
    expect(brokerContainer(spec)).toBeUndefined();
    // This is the accepted residual of PEN-3183 §7, and it is asserted so that
    // the cases above cannot pass vacuously: if this one ever reports that the
    // agent has no credential mount, the predicate stopped matching and the
    // "removed from the agent" assertions above are testing nothing.
    expect(mountPaths(agentContainer(spec))).toEqual(expect.arrayContaining([TOKEN_MOUNT, MERGE_TOKEN_MOUNT]));
    expect(agentContainer(spec).env?.find((e) => e.name === "PAPERCLIP_GITHUB_BROKER_SOCKET")).toBeUndefined();
  });
});
