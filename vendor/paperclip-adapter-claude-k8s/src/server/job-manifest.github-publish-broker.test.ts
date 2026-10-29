import { describe, it, expect } from "vitest";
import type * as k8s from "@kubernetes/client-node";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildJobManifest, findPrivilegedContainersBesideBroker } from "./job-manifest.js";
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

function render(enabled: boolean, extraConfig: Record<string, unknown> = {}): k8s.V1PodSpec {
  const { job } = buildJobManifest({
    ctx: makeCtx(enabled ? { enableGitHubPublishBroker: true, ...extraConfig } : extraConfig),
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

  it("gives the agent a socket to ask over, and no path to the token file", () => {
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
    // MOUNTS ONLY. This case is named for the token FILE on purpose: it says
    // nothing about a credential delivered as an environment variable, which
    // is a separate delivery route with its own cases below. The previous name
    // ("nothing that resembles a token") claimed the whole surface while
    // checking one leg of it, and that gap is how the env route survived.
    expect(agent.env?.some((e) => e.name === "GH_TOKEN")).toBe(false);
  });

  // PEN-4933 follow-up. The mount diversion is not the whole credential
  // surface: `GH_SEAT_TOKEN_VALUE` is a supported volume-free delivery route
  // (BLO-18927) that heartbeat expands into GH_TOKEN/GITHUB_TOKEN on the agent
  // container. With one present the mount assertions above all still pass and
  // `/usr/bin/git push` still authenticates via /etc/gitconfig's system helper,
  // so the boundary fails in the direction that looks fine.
  describe("an env-delivered credential is refused rather than rendered", () => {
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN", "GH_SEAT_TOKEN_VALUE"]) {
      it(`refuses to render the broker while the agent container carries ${name}`, () => {
        expect(() => render(true, { env: { [name]: "ghs_examplevalue" } })).toThrow(
          /would still carry a GitHub push credential in its environment/,
        );
      });
    }

    it("names the offending variable, so the error is actionable", () => {
      expect(() => render(true, { env: { GH_SEAT_TOKEN_VALUE: "ghs_examplevalue" } })).toThrow(
        /GH_SEAT_TOKEN_VALUE/,
      );
    });

    // The refusal is scoped to the credential names, not to "any env var".
    it("renders normally for an unrelated env var", () => {
      expect(() => render(true, { env: { SOME_FEATURE_FLAG: "1" } })).not.toThrow();
    });

    // POSITIVE CONTROL, and the one that pins WHY this refusal exists: with the
    // broker off, the same seat token renders happily onto the agent container.
    // That is today's fleet, and it is the state §7.1 describes.
    it("POSITIVE CONTROL: with the broker off, the seat credential renders onto the agent", () => {
      const spec = render(false, { env: { GH_TOKEN: "ghs_examplevalue" } });
      expect(agentContainer(spec).env?.some((e) => e.name === "GH_TOKEN")).toBe(true);
    });
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


  // PEN-5026 / PEN-3183 §7.6. The cases above all ask "what is inside the
  // boundary". These ask the question that defeats it from outside: what ELSE
  // is in the pod. A privileged container never needs the credential volume
  // mounted — privileged is `setns` into another container's mount namespace,
  // and it is mounting the node filesystem where the kubelet already wrote the
  // Secret. So the boundary is a property of the POD, and these pin it there.
  describe("nothing privileged beside the broker (PEN-5026)", () => {
    const dockerAndBroker = { enableGitHubPublishBroker: true, enableDocker: true };

    it("REFUSES to render a brokered pod that also carries the privileged DinD sidecar", () => {
      // The whole finding, as one assertion. Before this, the combination
      // rendered silently: publishing worked either way, so nothing — no
      // metric, no log line, no failed dispatch — distinguished "brokered and
      // isolated" from "brokered with privileged root beside it". That is what
      // made a D1 soak containing such an agent evidence of nothing.
      expect(() => buildJobManifest({ ctx: makeCtx(dockerAndBroker), selfPod: baseSelfPod })).toThrow(
        /also carry privilege outside the broker \(dind: privileged: true/,
      );
    });

    it("names the remedy and the release condition in the refusal", () => {
      // A refusal with no exit is how a capability gets quietly deleted. The
      // operator is told which switch to turn off; §7.6's release condition —
      // an unprivileged container runtime — is named so that the next person
      // who needs docker beside a broker builds that rather than deleting this.
      let message = "";
      try {
        buildJobManifest({ ctx: makeCtx(dockerAndBroker), selfPod: baseSelfPod });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/turn off `enableDocker` on this agent, or leave the broker disabled/);
      expect(message).toMatch(/unprivileged container runtime/);
      // The socket matters as much as the sidecar: the agent is handed it and
      // can start further privileged containers with arbitrary host mounts.
      expect(message).toMatch(/docker socket/);
    });

    it("leaves a docker-enabled run alone when the broker was not asked for", () => {
      // Scoping control, the same shape as the broad-mount one above. Without
      // it the refusal could widen to every docker-enabled pod — which is the
      // whole fleet's toolchain — and still look correct here.
      const { job } = buildJobManifest({ ctx: makeCtx({ enableDocker: true }), selfPod: baseSelfPod });
      const spec = job.spec!.template!.spec!;
      expect(brokerContainer(spec)).toBeUndefined();
      expect(spec.initContainers?.find((c) => c.name === "dind")?.securityContext?.privileged).toBe(true);
    });

    it("POSITIVE CONTROL: an ordinary brokered pod is clean, so the check can pass", () => {
      // Without this, a check that refused unconditionally — or one wired to a
      // predicate that always matched — would pass every case above while
      // making the broker unrenderable in every configuration. The assertion
      // is on the helper, not just on "it didn't throw", so a future change
      // that stops CALLING the helper still leaves this reading the real thing.
      const spec = render(true);
      expect(brokerContainer(spec)).toBeDefined();
      expect(findPrivilegedContainersBesideBroker(spec)).toEqual([]);
    });

    it("exempts the broker itself, and nothing else, by name", () => {
      // The broker is skipped because it IS the boundary. Pinned against the
      // constant drifting away from the container's rendered name, which would
      // either exempt the wrong container or exempt none and refuse every
      // brokered pod.
      const spec = render(true);
      const broker = brokerContainer(spec)!;
      expect(findPrivilegedContainersBesideBroker({ containers: [broker] })).toEqual([]);
      expect(findPrivilegedContainersBesideBroker({ containers: [{ ...broker, name: "not-the-broker" }] })).toEqual([]);
    });

    it("trips on a container that merely omits allowPrivilegeEscalation", () => {
      // Fail-closed on UNSET, because Kubernetes defaults the field to true.
      // Reading absent as false would make this backstop silently inert on
      // exactly the container nobody thought about — the only kind it exists
      // to catch.
      expect(findPrivilegedContainersBesideBroker({ containers: [{ name: "careless", image: "x" }] })).toEqual([
        "careless: allowPrivilegeEscalation is unset (Kubernetes defaults it to true)",
      ]);
    });

    it("trips on an escape-capable capability, not on the seed container's DAC_OVERRIDE", () => {
      // The capability list is about crossing OUT of a container. SYS_ADMIN is
      // `mount` and `setns`. DAC_OVERRIDE bypasses file permissions inside the
      // holder's own mount namespace and reaches nothing else — and it is
      // load-bearing for the seed init container, so a list that included it
      // would make the broker unrenderable wherever the narrow mount needs
      // seeding, which is everywhere the broker is legal.
      const base = { image: "x", securityContext: { allowPrivilegeEscalation: false } } as const;
      expect(
        findPrivilegedContainersBesideBroker({
          containers: [{ ...base, name: "mounter", securityContext: { allowPrivilegeEscalation: false, capabilities: { add: ["SYS_ADMIN"] } } }],
        }),
      ).toEqual(["mounter: capabilities.add includes SYS_ADMIN"]);
      expect(
        findPrivilegedContainersBesideBroker({
          containers: [{ ...base, name: "seeder", securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"], add: ["CHOWN", "DAC_OVERRIDE"] } } }],
        }),
      ).toEqual([]);
    });

    it("does not refuse a brokered pod merely because a container runs as uid 0", () => {
      // THE DISCRIMINATOR IS PRIVILEGE, NOT UID — pinned so that "tightening"
      // this to `runAsUser === 0` fails here rather than bricking the broker in
      // production. The container below is PEN-4932's `seed-writable-dirs`,
      // reproduced literally: it is uid 0 by necessity, because it creates the
      // subPath targets a narrow mount needs, and the narrow mount is itself a
      // precondition of the broker (see the broad-mount refusal). It is
      // unprivileged, every capability dropped but the two it uses, and it has
      // exited before the broker process exists.
      //
      // Written as a fixture rather than rendered, deliberately: this branch
      // stacks on #3112, whose base predates the seeder, so there is no
      // `seed-writable-dirs` in a manifest built HERE. The fixture is copied
      // from the real one on master and the combination is verified against
      // master by test-merge (see the PR body). When this lands the seeder is
      // in the pod for real, and this case is what stops the two meeting for
      // the first time in production.
      expect(
        findPrivilegedContainersBesideBroker({
          containers: [
            {
              name: "seed-writable-dirs",
              image: "busybox:1.36",
              securityContext: {
                capabilities: { drop: ["ALL"], add: ["CHOWN", "DAC_OVERRIDE"] },
                runAsNonRoot: false,
                runAsUser: 0,
                allowPrivilegeEscalation: false,
              },
            },
          ],
        }),
      ).toEqual([]);
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
