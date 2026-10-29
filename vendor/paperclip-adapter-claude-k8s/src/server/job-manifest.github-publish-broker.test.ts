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

/**
 * A run with per-run isolation, so `narrowWritableSurface` holds.
 *
 * Not incidental to the fixture — it is the configuration the broker is only
 * ever rendered under. A `runtime.isolation` of `null` falls through to the
 * broad whole-PVC rw mount, and the builder now refuses to render the broker
 * there at all (see the broad-scope case at the bottom of this file). Every
 * assertion in this file would otherwise be describing the shape of a
 * boundary under the one data-mount scope where it does not hold.
 */
const NARROW_ISOLATION = { isolationMode: "shared", isolationKey: "agent-shared:agent-abc" };

function makeCtx(adapterConfig: Record<string, unknown>, isolation: unknown = NARROW_ISOLATION): AdapterExecutionContext {
  return {
    runId: "run-abc12345",
    agent: { id: "agent-abc", companyId: "co1", name: "Test Agent", adapterType: "claude_k8s", adapterConfig },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null, isolation },
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

  it("mounts the pre-push hook the broker executes read-only", () => {
    // The broker runs the PEN-3156 hook with the push credential in its
    // environment. If the agent can rewrite that file, the boundary buys
    // nothing: uid 1000 chooses the code uid 1001 runs with the token. Pinned
    // on the BROKER's mount list, because that is the one that decides it.
    const broker = brokerContainer(render(true));
    const hooks = (broker?.volumeMounts ?? []).find((m) =>
      m.mountPath.endsWith(".local/share/paperclip-git-hooks"),
    );
    expect(hooks).toBeDefined();
    expect(hooks?.readOnly).toBe(true);
  });

  it("keeps the broker's own scratch out of the agent's mount namespace", () => {
    // `gh` reads aliases and extensions out of GH_CONFIG_DIR, and the broker
    // makes one per invocation under here. It must NOT be the shared /tmp: a
    // 0700 mkdtemp inside a parent the agent can write can be renamed away and
    // replaced, and `gh` would then execute an alias of the agent's choosing
    // beside the credential. An emptyDir has no sticky bit.
    const spec = render(true);
    const privateDir = "/var/lib/paperclip-github-broker";
    expect(mountPaths(brokerContainer(spec))).toContain(privateDir);
    for (const mounted of mountPaths(agentContainer(spec))) {
      expect(privateDir === mounted || privateDir.startsWith(`${mounted}/`)).toBe(false);
    }
  });

  it("keeps the broker's scratch clear of the shared socket dir even after /var/run resolves", () => {
    // `/var/run` is a symlink to `/run` on the runtime image, so two mount
    // paths that differ only by that prefix are ONE directory in the
    // container — and the socket dir is mounted by the agent. The builder's
    // shadowing backstop compares literal strings and would admit the pair.
    // Normalise the way the kernel does, then require them to be disjoint.
    const resolve = (p: string) => p.replace(/^\/var\/run\//, "/run/");
    const broker = mountPaths(brokerContainer(render(true))).map(resolve);
    const agent = mountPaths(agentContainer(render(true))).map(resolve);
    const scratch = resolve("/var/lib/paperclip-github-broker");
    expect(broker).toContain(scratch);
    for (const mounted of agent) {
      expect(scratch === mounted || scratch.startsWith(`${mounted}/`)).toBe(false);
    }
  });

  it("REFUSES to render the broker when the data volume would be mounted broad rw", () => {
    // The negative half of the read-only-hook case above. Under the broad
    // fallback the whole PVC is mounted rw, so the hook the credential holder
    // runs sits in a directory uid 1000 owns — and §7.2 already names
    // `data-mount-scope: broad:*` as a trigger that ENDS the residual
    // acceptance. Refusing to build is the only outcome that neither ships a
    // boundary that does not hold nor silently leaves the token where it was.
    expect(() =>
      buildJobManifest({
        ctx: makeCtx({ enableGitHubPublishBroker: true }, null),
        selfPod: baseSelfPod,
      }),
    ).toThrow(/broad read-write \(reason: isolation_disabled\)/);
  });

  it("leaves a broad-scope run alone when the broker was not asked for", () => {
    // The refusal above is scoped to the flag. A broad-scope Job with no
    // broker is the status quo this change must not break, and without this
    // case the refusal could widen to every broad run and still look correct.
    const { job } = buildJobManifest({ ctx: makeCtx({}, null), selfPod: baseSelfPod });
    const spec = job.spec!.template!.spec!;
    expect(job.metadata?.annotations?.["paperclip.io/data-mount-scope"]).toBe("broad:isolation_disabled");
    expect(brokerContainer(spec)).toBeUndefined();
    expect(mountPaths(agentContainer(spec))).toEqual(expect.arrayContaining([TOKEN_MOUNT]));
  });

  // PEN-5017, found by Ally reviewing #3112. The server-side pin keeps an issue
  // override from flipping `enableGitHubPublishBroker` off — but `image` is read
  // off the SAME merged config, and the broker execs
  // `paperclip-github-token-env` and the runtime JS out of that image with the
  // push credential in its environment. So an override of a sibling key chose
  // the code that runs at uid 1001 holding the token, with the gate still
  // pinned exactly as intended. The broker now renders from
  // `ctx.agent.adapterConfig` — the agent row before any merge.
  describe("broker image provenance", () => {
    const divergentCtx = (agentScope: Record<string, unknown>, merged: Record<string, unknown>) =>
      ({
        runId: "run-abc12345",
        agent: {
          id: "agent-abc",
          companyId: "co1",
          name: "Test Agent",
          adapterType: "claude_k8s",
          adapterConfig: { enableGitHubPublishBroker: true, ...agentScope },
        },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null, isolation: NARROW_ISOLATION },
        config: { serviceAccountName: "test-sa", enableGitHubPublishBroker: true, ...merged },
        context: {},
        onLog: async () => {},
      }) as unknown as AdapterExecutionContext;

    const renderDivergent = (agentScope: Record<string, unknown>, merged: Record<string, unknown>) =>
      buildJobManifest({ ctx: divergentCtx(agentScope, merged), selfPod: baseSelfPod })
        .job.spec!.template!.spec!;

    it("runs the broker on the agent-scope image, not an overridden one", () => {
      const spec = renderDivergent(
        { image: "registry.example/operator-agent:pinned" },
        { image: "registry.example/attacker:evil" },
      );

      expect(brokerContainer(spec)?.image).toBe("registry.example/operator-agent:pinned");
      // The agent container may still take the override — once brokered it
      // holds no credential, so what it runs is its own business. Asserted so
      // that a future fix cannot quietly pin BOTH and call this case green.
      expect(agentContainer(spec).image).toBe("registry.example/attacker:evil");
    });

    it("falls back to the self-pod image when agent scope names none, never to the override", () => {
      const spec = renderDivergent({}, { image: "registry.example/attacker:evil" });

      expect(brokerContainer(spec)?.image).toBe(baseSelfPod.image);
      expect(brokerContainer(spec)?.image).not.toBe("registry.example/attacker:evil");
    });

    it("POSITIVE CONTROL: with no override the broker still tracks the agent image", () => {
      // Without this, pinning the broker to a constant would pass both cases
      // above while silently breaking every real deployment — the broker must
      // run the agent's image, it just must learn it from agent scope.
      const spec = renderDivergent(
        { image: "registry.example/operator-agent:pinned" },
        { image: "registry.example/operator-agent:pinned" },
      );

      expect(brokerContainer(spec)?.image).toBe("registry.example/operator-agent:pinned");
      expect(brokerContainer(spec)?.image).toBe(agentContainer(spec).image);
    });
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
