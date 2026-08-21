import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression cover for the self-pod introspection cache.
 *
 * `getSelfPodInfo()` used to memoize into a single process-global slot, while
 * both the API-client helpers and `execute()` accept a per-request kubeconfig
 * path. The first execution to populate that slot therefore handed its
 * cluster's image, scheduling, PVC, env and Secret references to every later
 * execution running against a *different* cluster — the Job would be created
 * through cluster B's client but templated from cluster A's pod.
 */

/** Records which kubeconfig file each KubeConfig instance was loaded from. */
class FakeKubeConfig {
  loadedFrom = "";
  loadFromFile(p: string) {
    this.loadedFrom = p;
  }
  loadFromCluster() {
    this.loadedFrom = "<in-cluster>";
  }
  makeApiClient() {
    const loadedFrom = this.loadedFrom;
    return {
      readNamespacedPod: async () => podFixtures[loadedFrom],
    };
  }
}

/** Distinct pod spec per kubeconfig, so a cache mix-up is directly observable. */
const podFixtures: Record<string, unknown> = {};

vi.mock("@kubernetes/client-node", () => ({
  KubeConfig: FakeKubeConfig,
  CoreV1Api: class {},
  BatchV1Api: class {},
  AuthorizationV1Api: class {},
  Log: class {},
}));

function makePod(image: string, nodeSelectorValue: string) {
  return {
    spec: {
      containers: [
        {
          name: "paperclip",
          image,
          // PAPERCLIP_API_URL rather than an arbitrary name: since BLO-22514
          // getSelfPodInfo() allowlists inherited env, so a synthetic var would
          // be filtered out and this test would assert on `undefined` for a
          // reason unrelated to cache keying. This one is allowlisted and its
          // value is per-cluster, which is exactly what the assertion needs.
          env: [{ name: "PAPERCLIP_API_URL", value: `http://${nodeSelectorValue}.svc:3000` }],
          volumeMounts: [],
        },
      ],
      nodeSelector: { workload: nodeSelectorValue },
      volumes: [],
      imagePullSecrets: [],
      tolerations: [],
    },
  };
}

/**
 * Pod whose main container mounts two secret volumes: one projecting a single
 * key out of a multi-key Secret via `items:`, one projecting the whole Secret.
 * Mirrors the live paperclip-api spec.
 */
function makePodWithSecretVolumes() {
  return {
    spec: {
      containers: [
        {
          name: "paperclip",
          image: "registry/a:v1",
          env: [],
          volumeMounts: [
            { name: "gbrain-authbot-service-key", mountPath: "/var/run/authbot" },
            { name: "github-token", mountPath: "/paperclip/.secrets/github-token" },
            { name: "github-merge-token", mountPath: "/paperclip/.secrets/github-merge-token" },
          ],
        },
      ],
      nodeSelector: {},
      volumes: [
        {
          name: "gbrain-authbot-service-key",
          secret: {
            secretName: "authbot-mcp-consumer-service-keys",
            defaultMode: 292,
            items: [{ key: "gbrain-plugin-service-key", path: "gbrain-plugin-service-key" }],
          },
        },
        {
          name: "github-token",
          secret: { secretName: "paperclip-github-mcp-token", defaultMode: 292 },
        },
        // The server pod genuinely mounts the user seat; the fixture keeps it so
        // the allowlist is exercised against a realistic pod rather than one
        // curated to contain only inheritable volumes (BLO-24056).
        {
          name: "github-merge-token",
          secret: { secretName: "paperclip-github-merge-token", defaultMode: 292 },
        },
      ],
      imagePullSecrets: [],
      tolerations: [],
    },
  };
}

describe("getSelfPodInfo cache keying", () => {
  const KC_A = "/tmp/kubeconfig-cluster-a";
  const KC_B = "/tmp/kubeconfig-cluster-b";

  beforeEach(async () => {
    process.env.HOSTNAME = "paperclip-abc123";
    process.env.PAPERCLIP_NAMESPACE = "paperclip";
    podFixtures[KC_A] = makePod("registry/a:v1", "cluster-a");
    podFixtures[KC_B] = makePod("registry/b:v2", "cluster-b");
    const { resetCache } = await import("./k8s-client.js");
    resetCache();
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_NAMESPACE;
  });

  it("does not leak one kubeconfig's pod spec into another's execution", async () => {
    const { getSelfPodInfo } = await import("./k8s-client.js");

    // Populate the cache from cluster A first — this is the call that used to
    // poison every subsequent lookup.
    const a = await getSelfPodInfo(KC_A);
    expect(a.image).toBe("registry/a:v1");

    const b = await getSelfPodInfo(KC_B);
    expect(b.image).toBe("registry/b:v2");
    expect(b.nodeSelector).toEqual({ workload: "cluster-b" });
    expect(b.inheritedEnv.PAPERCLIP_API_URL).toBe("http://cluster-b.svc:3000");
  });

  it("still caches per kubeconfig (second call does not re-hit the API)", async () => {
    const { getSelfPodInfo } = await import("./k8s-client.js");

    const first = await getSelfPodInfo(KC_A);
    // Remove the fixture: a cache hit returns the memoized object, whereas a
    // re-read would throw on the now-undefined pod.
    delete podFixtures[KC_A];
    const second = await getSelfPodInfo(KC_A);
    expect(second).toBe(first);
  });

  it("resetCache clears every kubeconfig entry", async () => {
    const { getSelfPodInfo, resetCache } = await import("./k8s-client.js");

    await getSelfPodInfo(KC_A);
    resetCache();
    podFixtures[KC_A] = makePod("registry/a:v99", "cluster-a");
    const refreshed = await getSelfPodInfo(KC_A);
    expect(refreshed.image).toBe("registry/a:v99");
  });
});

describe("getSelfPodInfo secret volume capture", () => {
  const KC = "/tmp/kubeconfig-secret-volumes";

  beforeEach(async () => {
    process.env.HOSTNAME = "paperclip-abc123";
    process.env.PAPERCLIP_NAMESPACE = "paperclip";
    podFixtures[KC] = makePodWithSecretVolumes();
    const { resetCache } = await import("./k8s-client.js");
    resetCache();
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_NAMESPACE;
  });

  it("carries the source volume's items selector through capture", async () => {
    // Dropping `items` here is what let a one-key projection re-expand into
    // every key of a multi-key Secret once the volume was replayed onto the
    // agent Job pod.
    const { getSelfPodInfo } = await import("./k8s-client.js");
    const info = await getSelfPodInfo(KC);

    const scoped = info.secretVolumes.find((v) => v.volumeName === "gbrain-authbot-service-key");
    expect(scoped?.items).toEqual([
      { key: "gbrain-plugin-service-key", path: "gbrain-plugin-service-key" },
    ]);
  });

  it("leaves items undefined for a volume that projects the whole Secret", async () => {
    const { getSelfPodInfo } = await import("./k8s-client.js");
    const info = await getSelfPodInfo(KC);

    // Uses the App token, not the user seat: the seat is no longer inheritable
    // (BLO-24056), so it can never appear in secretVolumes and would make this
    // assertion vacuously unreachable rather than testing whole-Secret capture.
    const whole = info.secretVolumes.find((v) => v.volumeName === "github-token");
    expect(whole).toBeDefined();
    expect(whole?.items).toBeUndefined();
  });

  it("copies the items array rather than aliasing the pod spec", async () => {
    // The captured info is memoized and handed to every later Job build, so a
    // caller mutating it must not reach back into the cached pod spec.
    const { getSelfPodInfo } = await import("./k8s-client.js");
    const info = await getSelfPodInfo(KC);

    const scoped = info.secretVolumes.find((v) => v.volumeName === "gbrain-authbot-service-key");
    const source = (podFixtures[KC] as { spec: { volumes: Array<{ name: string; secret?: { items?: unknown[] } }> } })
      .spec.volumes.find((v) => v.name === "gbrain-authbot-service-key");
    expect(scoped?.items).not.toBe(source?.secret?.items);
  });
});

/**
 * BLO-22514: getSelfPodInfo() is the single chokepoint for what the server pod
 * hands down to agent Job pods. job-manifest.ts replays its output in four
 * separate places, so filtering here — rather than at each replay site — is
 * what stops a new replay site from reintroducing the leak.
 */
describe("getSelfPodInfo inheritance allowlist (BLO-22514)", () => {
  const KC = "/tmp/kubeconfig-allowlist";

  beforeEach(async () => {
    process.env.HOSTNAME = "paperclip-abc123";
    process.env.PAPERCLIP_NAMESPACE = "paperclip";
    const { resetCache } = await import("./k8s-client.js");
    resetCache();
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_NAMESPACE;
  });

  function podWithEnv(
    env: unknown[],
    opts: { volumes?: unknown[]; volumeMounts?: unknown[]; envFrom?: unknown[] } = {},
  ) {
    return {
      spec: {
        containers: [
          {
            name: "paperclip",
            image: "registry/paperclip:v1",
            env,
            envFrom: opts.envFrom ?? [],
            volumeMounts: opts.volumeMounts ?? [],
          },
        ],
        volumes: opts.volumes ?? [],
        nodeSelector: {},
        imagePullSecrets: [],
        tolerations: [],
      },
    };
  }

  it("drops server-only literals and keeps agent-needed ones", async () => {
    podFixtures[KC] = podWithEnv([
      { name: "PAPERCLIP_AGENT_JWT_SECRET", value: "master-signing-key" },
      { name: "DATABASE_URL", value: "postgres://user:pw@host/db" },
      { name: "GITHUB_APP_PRIVATE_KEY", value: "-----BEGIN RSA-----" },
      { name: "PAPERCLIP_API_URL", value: "http://paperclip-api.paperclip.svc:3000" },
      { name: "ANTHROPIC_BASE_URL", value: "https://api.penstock.run/anthropic" },
      { name: "PATH", value: "/usr/local/bin:/usr/bin" },
    ]);
    const { getSelfPodInfo } = await import("./k8s-client.js");
    const info = await getSelfPodInfo(KC);

    expect(info.inheritedEnv).not.toHaveProperty("PAPERCLIP_AGENT_JWT_SECRET");
    expect(info.inheritedEnv).not.toHaveProperty("DATABASE_URL");
    expect(info.inheritedEnv).not.toHaveProperty("GITHUB_APP_PRIVATE_KEY");

    expect(info.inheritedEnv.PAPERCLIP_API_URL).toBe("http://paperclip-api.paperclip.svc:3000");
    expect(info.inheritedEnv.ANTHROPIC_BASE_URL).toBe("https://api.penstock.run/anthropic");
    expect(info.inheritedEnv.PATH).toBe("/usr/local/bin:/usr/bin");
  });

  it("filters secretKeyRef entries on the same basis as literals", async () => {
    // The BLO-22506 analysis called secretKeyRef-sourced vars "fine" because
    // they do not surface through `GET Pod`. They are not: the kubelet resolves
    // them into the container environment, so the agent reads them either way.
    podFixtures[KC] = podWithEnv([
      {
        name: "PAPERCLIP_AGENT_JWT_SECRET",
        valueFrom: { secretKeyRef: { name: "paperclip-jwt", key: "secret" } },
      },
      {
        name: "ANTHROPIC_AUTH_TOKEN",
        valueFrom: { secretKeyRef: { name: "paperclip-penstock-org-key", key: "token" } },
      },
    ]);
    const { getSelfPodInfo } = await import("./k8s-client.js");
    const info = await getSelfPodInfo(KC);

    const names = info.inheritedEnvValueFrom.map((e) => e.name);
    expect(names).not.toContain("PAPERCLIP_AGENT_JWT_SECRET");
    expect(names).toContain("ANTHROPIC_AUTH_TOKEN");
  });

  it("keeps agent-facing secret volumes and drops the rest", async () => {
    podFixtures[KC] = podWithEnv([], {
      volumes: [
        { name: "github-token", secret: { secretName: "paperclip-github-mcp-token" } },
        // The user seat is mounted on the SERVER pod but must not propagate
        // into agent Jobs (BLO-24056) — it belongs on the dropped side now.
        { name: "github-merge-token", secret: { secretName: "paperclip-github-merge-token" } },
        { name: "db-creds", secret: { secretName: "paperclip-db-credentials" } },
      ],
      volumeMounts: [
        { name: "github-token", mountPath: "/paperclip/.secrets/github-token" },
        { name: "github-merge-token", mountPath: "/paperclip/.secrets/github-merge-token" },
        { name: "db-creds", mountPath: "/paperclip/.secrets/db" },
      ],
    });
    const { getSelfPodInfo } = await import("./k8s-client.js");
    const info = await getSelfPodInfo(KC);

    expect(info.secretVolumes.map((v) => v.secretName)).toEqual([
      "paperclip-github-mcp-token",
    ]);
    // Explicit rather than implied by the toEqual above: this is the whole
    // point of the change, and a future edit that re-widens the allowlist
    // should fail on a line that says so.
    expect(info.secretVolumes.map((v) => v.secretName)).not.toContain(
      "paperclip-github-merge-token",
    );
  });

  it("drops every envFrom source by default", async () => {
    // envFrom injects whole objects under names the allowlist never observes,
    // so it cannot be reconciled with per-name filtering.
    podFixtures[KC] = podWithEnv([], {
      envFrom: [{ secretRef: { name: "paperclip-server-secrets" } }],
    });
    const { getSelfPodInfo } = await import("./k8s-client.js");
    const info = await getSelfPodInfo(KC);

    expect(info.inheritedEnvFrom).toEqual([]);
  });
});
