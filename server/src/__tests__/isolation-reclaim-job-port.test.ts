import type * as k8s from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

import {
  RECLAIM_PORT_LOG_TIMEOUT_MS,
  RECLAIM_PORT_REQUEST_TIMEOUT_MS,
  createInClusterIsolationReclaimJobPort,
  createIsolationReclaimJobPort,
} from "../services/isolation-reclaim-job-port.js";

const NAMESPACE = "paperclip";

/** The four shapes the client has reported a status in across versions. */
const STATUS_SHAPES: Array<[string, (status: number) => unknown]> = [
  ["error.code", (status) => Object.assign(new Error("boom"), { code: status })],
  ["error.statusCode", (status) => Object.assign(new Error("boom"), { statusCode: status })],
  [
    "error.response.statusCode",
    (status) => Object.assign(new Error("boom"), { response: { statusCode: status } }),
  ],
  [
    "error.response.status",
    (status) => Object.assign(new Error("boom"), { response: { status } }),
  ],
];

interface Recorded {
  method: string;
  args: unknown[];
}

function fakeClients(handlers: {
  createNamespacedJob?: (...args: unknown[]) => unknown;
  readNamespacedJob?: (...args: unknown[]) => unknown;
  listNamespacedPod?: (...args: unknown[]) => unknown;
  readNamespacedPodLog?: (...args: unknown[]) => unknown;
}): {
  clients: { batchApi: k8s.BatchV1Api; coreApi: k8s.CoreV1Api };
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const wrap =
    (method: string, handler?: (...args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      if (!handler) throw new Error(`${method} was not expected`);
      return handler(...args);
    };
  const clients = {
    batchApi: {
      createNamespacedJob: wrap("createNamespacedJob", handlers.createNamespacedJob),
      readNamespacedJob: wrap("readNamespacedJob", handlers.readNamespacedJob),
    } as unknown as k8s.BatchV1Api,
    coreApi: {
      listNamespacedPod: wrap("listNamespacedPod", handlers.listNamespacedPod),
      readNamespacedPodLog: wrap("readNamespacedPodLog", handlers.readNamespacedPodLog),
    } as unknown as k8s.CoreV1Api,
  };
  return { clients, calls };
}

describe("createIsolationReclaimJobPort — createJob", () => {
  it("reports a successful create", async () => {
    const { clients, calls } = fakeClients({ createNamespacedJob: () => ({}) });
    const port = createIsolationReclaimJobPort(clients);

    const job = { metadata: { name: "pc-reclaim-inv-x" } } as k8s.V1Job;
    await expect(port.createJob(NAMESPACE, job)).resolves.toBe("created");
    expect((calls[0]!.args[0] as { namespace: string; body: unknown }).namespace).toBe(NAMESPACE);
    expect((calls[0]!.args[0] as { body: unknown }).body).toBe(job);
  });

  it.each(STATUS_SHAPES)("turns a 409 reported via %s into a value", async (_label, make) => {
    const { clients } = fakeClients({
      createNamespacedJob: () => {
        throw make(409);
      },
    });
    const port = createIsolationReclaimJobPort(clients);

    // A value, not a throw: the runner verifies the existing Job's mounted
    // claim before adopting it, and that check only exists because of this.
    await expect(port.createJob(NAMESPACE, {} as k8s.V1Job)).resolves.toBe("already_exists");
  });

  it("rethrows every other status, including 5xx", async () => {
    for (const status of [400, 403, 404, 500, 503]) {
      const { clients } = fakeClients({
        createNamespacedJob: () => {
          throw Object.assign(new Error(`status ${status}`), { code: status });
        },
      });
      const port = createIsolationReclaimJobPort(clients);
      // Swallowing an apiserver failure into a tidy value converts an unknown
      // into a confident wrong answer one layer up.
      await expect(port.createJob(NAMESPACE, {} as k8s.V1Job)).rejects.toThrow(`status ${status}`);
    }
  });
});

describe("createIsolationReclaimJobPort — readJob", () => {
  it("returns the Job", async () => {
    const job = { metadata: { name: "pc-reclaim-exe-x" } } as k8s.V1Job;
    const { clients, calls } = fakeClients({ readNamespacedJob: () => job });
    const port = createIsolationReclaimJobPort(clients);

    await expect(port.readJob(NAMESPACE, "pc-reclaim-exe-x")).resolves.toBe(job);
    expect(calls[0]!.args[0]).toMatchObject({ name: "pc-reclaim-exe-x", namespace: NAMESPACE });
  });

  it.each(STATUS_SHAPES)("turns a 404 reported via %s into null", async (_label, make) => {
    const { clients } = fakeClients({
      readNamespacedJob: () => {
        throw make(404);
      },
    });
    const port = createIsolationReclaimJobPort(clients);

    await expect(port.readJob(NAMESPACE, "gone")).resolves.toBeNull();
  });

  it("rethrows every other status", async () => {
    for (const status of [403, 409, 500, 503]) {
      const { clients } = fakeClients({
        readNamespacedJob: () => {
          throw Object.assign(new Error(`status ${status}`), { statusCode: status });
        },
      });
      const port = createIsolationReclaimJobPort(clients);
      await expect(port.readJob(NAMESPACE, "x")).rejects.toThrow(`status ${status}`);
    }
  });
});

describe("createIsolationReclaimJobPort — listJobPods", () => {
  it("selects on the unprefixed job-name label", async () => {
    const { clients, calls } = fakeClients({ listNamespacedPod: () => ({ items: [] }) });
    const port = createIsolationReclaimJobPort(clients);

    await port.listJobPods(NAMESPACE, "pc-reclaim-inv-abc");

    // A literal, not built from the module's own constant: a selector derived
    // from the value under test cannot constrain it.
    expect(calls[0]!.args[0]).toMatchObject({
      namespace: NAMESPACE,
      labelSelector: "job-name=pc-reclaim-inv-abc",
    });
  });

  it("returns the pods", async () => {
    const pods = [{ metadata: { name: "p1" } }] as k8s.V1Pod[];
    const { clients } = fakeClients({ listNamespacedPod: () => ({ items: pods }) });
    const port = createIsolationReclaimJobPort(clients);

    await expect(port.listJobPods(NAMESPACE, "j")).resolves.toEqual(pods);
  });

  it("treats an empty or absent item list as a VALUE, not an error", async () => {
    // The runner distinguishes "terminal with no pod" (evicted, GC'd) from
    // "the Job is gone"; collapsing them reports a pod_absent as a missing Job.
    for (const body of [{ items: [] }, {}]) {
      const { clients } = fakeClients({ listNamespacedPod: () => body });
      const port = createIsolationReclaimJobPort(clients);
      await expect(port.listJobPods(NAMESPACE, "j")).resolves.toEqual([]);
    }
  });

  it("does not swallow a 404 into an empty list", async () => {
    const { clients } = fakeClients({
      listNamespacedPod: () => {
        throw Object.assign(new Error("gone"), { code: 404 });
      },
    });
    const port = createIsolationReclaimJobPort(clients);

    // An empty list would read as "the Job is terminal with no pod", which is a
    // different fact and routes the runner to a different failure kind.
    await expect(port.listJobPods(NAMESPACE, "j")).rejects.toThrow("gone");
  });
});

describe("createIsolationReclaimJobPort — readPodLog", () => {
  it("reads the WHOLE log: no limitBytes, no tailLines", async () => {
    const { clients, calls } = fakeClients({ readNamespacedPodLog: () => "line\n" });
    const port = createIsolationReclaimJobPort(clients);

    await port.readPodLog(NAMESPACE, "pod-1", "reclaim");

    const args = calls[0]!.args[0] as Record<string, unknown>;
    expect(args).toMatchObject({ name: "pod-1", namespace: NAMESPACE, container: "reclaim" });
    // `limitBytes` truncates from the START, and the report is the LAST line,
    // so setting it drops the marker entirely and the parse says `absent`.
    expect(args.limitBytes).toBeUndefined();
    // `tailLines` keeps the end but can clip the marker line, which parses as
    // `malformed` and sends the reader after a format bug that is a log length.
    expect(args.tailLines).toBeUndefined();
  });

  it("returns the log text", async () => {
    const { clients } = fakeClients({ readNamespacedPodLog: () => "@@PCRECLAIM@@ {}\n" });
    const port = createIsolationReclaimJobPort(clients);

    await expect(port.readPodLog(NAMESPACE, "p", "reclaim")).resolves.toBe("@@PCRECLAIM@@ {}\n");
  });

  it("THROWS on a non-string body rather than coercing it to empty", async () => {
    for (const body of [undefined, null, { stream: true }]) {
      const { clients } = fakeClients({ readNamespacedPodLog: () => body });
      const port = createIsolationReclaimJobPort(clients);
      // Coercing to "" would reach the runner as `report_absent` — "go and look
      // at the pod" — for what is really the client changing shape, and the pod
      // would have nothing to say. Throwing reaches it as `log_unreadable`,
      // which names `pods/log`. (Ally, #3201.)
      await expect(port.readPodLog(NAMESPACE, "p", "reclaim")).rejects.toThrow(
        "log return type has changed",
      );
    }
  });

  it("returns an EMPTY string unchanged — a log with nothing in it is not a shape change", async () => {
    const { clients } = fakeClients({ readNamespacedPodLog: () => "" });
    const port = createIsolationReclaimJobPort(clients);

    // The guard is on the TYPE, not on emptiness: a pod that genuinely wrote
    // nothing yet is `report_absent`, which is the correct reading there.
    await expect(port.readPodLog(NAMESPACE, "p", "reclaim")).resolves.toBe("");
  });

  it("does not swallow a read failure", async () => {
    const { clients } = fakeClients({
      readNamespacedPodLog: () => {
        throw new Error("container not found");
      },
    });
    const port = createIsolationReclaimJobPort(clients);

    // The runner has its own `log_unreadable` kind for this; returning "" here
    // would reach it as `report_absent` and name the wrong thing to look at.
    await expect(port.readPodLog(NAMESPACE, "p", "reclaim")).rejects.toThrow("container not found");
  });
});

describe("reclaim port timeouts", () => {
  it("gives the log read a longer deadline than the rest", () => {
    // It is the one call whose size scales with how much the executor did.
    expect(RECLAIM_PORT_LOG_TIMEOUT_MS).toBeGreaterThan(RECLAIM_PORT_REQUEST_TIMEOUT_MS);
  });

  it("puts a deadline on every call", async () => {
    const { clients, calls } = fakeClients({
      createNamespacedJob: () => ({}),
      readNamespacedJob: () => ({}),
      listNamespacedPod: () => ({ items: [] }),
      readNamespacedPodLog: () => "",
    });
    const port = createIsolationReclaimJobPort(clients);

    await port.createJob(NAMESPACE, {} as k8s.V1Job);
    await port.readJob(NAMESPACE, "j");
    await port.listJobPods(NAMESPACE, "j");
    await port.readPodLog(NAMESPACE, "p", "reclaim");

    expect(calls).toHaveLength(4);
    for (const call of calls) {
      const options = call.args[1] as { promiseMiddleware?: unknown[] } | undefined;
      // A call with no deadline hangs a sweep tick behind an unresponsive
      // apiserver for as long as the socket stays open.
      expect(options?.promiseMiddleware, call.method).toHaveLength(1);
    }
  });
});

describe("createInClusterIsolationReclaimJobPort", () => {
  it("refuses outside a pod rather than falling back to a local kubeconfig", async () => {
    const saved = process.env.KUBERNETES_SERVICE_HOST;
    delete process.env.KUBERNETES_SERVICE_HOST;
    try {
      const made = createInClusterIsolationReclaimJobPort();
      // There is no safe default: a fallback would point a sweep that launches
      // recursive unlinks at whatever cluster a developer's kubeconfig names.
      expect(made.ok).toBe(false);
      if (!made.ok) expect(made.reason).toContain("kubernetes pod");
    } finally {
      if (saved === undefined) delete process.env.KUBERNETES_SERVICE_HOST;
      else process.env.KUBERNETES_SERVICE_HOST = saved;
    }
  });

  it("RETURNS rather than throws when the in-cluster config is attempted", () => {
    const saved = process.env.KUBERNETES_SERVICE_HOST;
    process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
    try {
      // Deliberately asserts only that it returns a verdict, not WHICH one.
      // Whether `loadFromCluster` succeeds depends on whether a service-account
      // token happens to be mounted where the suite runs — it is on an agent
      // pod, it is not on a laptop — so pinning the verdict would make this
      // test pass or fail on the host rather than on the code. The contract
      // that matters is the same either way: the caller gets a value to branch
      // on, never an exception that fails server startup over an optional
      // subsystem.
      const made = createInClusterIsolationReclaimJobPort();
      expect(typeof made.ok).toBe("boolean");
      if (made.ok) expect(typeof made.port.createJob).toBe("function");
      else expect(typeof made.reason).toBe("string");
    } finally {
      if (saved === undefined) delete process.env.KUBERNETES_SERVICE_HOST;
      else process.env.KUBERNETES_SERVICE_HOST = saved;
    }
  });
});
