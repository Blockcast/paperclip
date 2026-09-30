import { describe, it, expect, vi } from "vitest";
import type * as k8s from "@kubernetes/client-node";

// execute.ts reaches for the cluster at import time only through these
// factories, so a minimal stub is enough to load the module. The unit under
// test is pure, so nothing here is ever called.
vi.mock("./k8s-client.js", () => ({
  getLogApi: () => ({ log: vi.fn() }),
  getBatchApi: () => ({}),
  getCoreApi: () => ({}),
  getAuthzApi: () => ({}),
  getSelfPodInfo: vi.fn(),
  resetCache: vi.fn(),
}));

const { jobAdoptionVerdict } = await import("./execute.js");

const RUN_ID_LABEL = "paperclip.io/run-id";

const JOB_NAME = "ac-4eca1725-632f-45-f6fd03d0-4940-43-b1387d";
const RUN_ID = "f6fd03d0-4940-43ab-9c11-000000000000";
const JOB_UID = "6f1a9c2e-1f3b-4a7d-9e55-8c0d2b4f6a11";
/** A different server-assigned UID under the *same* deterministic name. */
const OTHER_UID = "0000aaaa-1111-2222-3333-444455556666";

/** The reservation identity the worker persisted when it launched the Job. */
const IDENTITY = { jobName: JOB_NAME, jobUid: JOB_UID };

function job(overrides: Partial<k8s.V1ObjectMeta> = {}): k8s.V1Job {
  return {
    metadata: {
      name: JOB_NAME,
      uid: JOB_UID,
      labels: { [RUN_ID_LABEL]: RUN_ID },
      ...overrides,
    },
  } as k8s.V1Job;
}

const EXPECTED = { jobName: JOB_NAME, runId: RUN_ID, identity: IDENTITY };

describe("jobAdoptionVerdict — the reattach case (BLO-27155)", () => {
  it("adopts the run's own live Job, returning the SAME uid rather than a new one", () => {
    // This is the whole point of the change: a worker restart re-executes the
    // run, the deterministic name collides with the Job that is still running,
    // and the correct outcome is to reattach to that exact object.
    expect(jobAdoptionVerdict(job(), EXPECTED)).toEqual({ adopt: true, jobUid: JOB_UID });
  });

  it("tolerates extra labels on the existing Job", () => {
    const withExtras = job({
      labels: {
        [RUN_ID_LABEL]: RUN_ID,
        "app.kubernetes.io/managed-by": "paperclip",
        "paperclip.io/adapter-type": "claude_k8s",
      },
    });
    expect(jobAdoptionVerdict(withExtras, EXPECTED)).toEqual({ adopt: true, jobUid: JOB_UID });
  });
});

describe("jobAdoptionVerdict — fails closed (preserves BLO-17291 AC-3)", () => {
  /**
   * The load-bearing case. A same-named Job whose UID is not the launched UID
   * is some *other* object — an earlier attempt, or a sibling that reused the
   * name after a delete. Adopting it would attach this run to work it does not
   * own, which is exactly the exact-identity guarantee BLO-17291 established.
   */
  it("refuses a same-name Job whose UID is not this run's launched UID", () => {
    const verdict = jobAdoptionVerdict(job({ uid: OTHER_UID }), EXPECTED);
    expect(verdict.adopt).toBe(false);
    expect((verdict as { reason: string }).reason).toContain(OTHER_UID);
  });

  it.each([
    ["identity absent", undefined],
    ["identity null", null],
    ["jobUid missing", { jobName: JOB_NAME }],
    ["jobName missing", { jobUid: JOB_UID }],
    ["jobUid empty", { jobName: JOB_NAME, jobUid: "" }],
    ["jobName empty", { jobName: "", jobUid: JOB_UID }],
    ["both null", { jobName: null, jobUid: null }],
  ])("refuses when the run has no usable persisted identity (%s)", (_label, identity) => {
    // Without a persisted UID there is no way to tell "our own live Job" from
    // "a leftover under the same deterministic name", and those want opposite
    // handling — so the only safe answer is to refuse.
    const verdict = jobAdoptionVerdict(job(), { jobName: JOB_NAME, runId: RUN_ID, identity });
    expect(verdict.adopt).toBe(false);
    expect((verdict as { reason: string }).reason).toContain("no persisted external-runtime Job identity");
  });

  it("refuses when the reservation's Job name disagrees with the built name (BLO-28865)", () => {
    // An adapter-type change re-prefixes the Job name (agent-opencode-* -> ac-*)
    // while the reservation still holds the pre-change name. Adopting across
    // that gap would leak the old Job.
    const verdict = jobAdoptionVerdict(job(), {
      jobName: JOB_NAME,
      runId: RUN_ID,
      identity: { jobName: "agent-opencode-legacy-name", jobUid: JOB_UID },
    });
    expect(verdict.adopt).toBe(false);
    expect((verdict as { reason: string }).reason).toContain("agent-opencode-legacy-name");
  });

  it.each([
    ["read failed (null)", null],
    ["read failed (undefined)", undefined],
  ])("refuses a 409 it cannot corroborate by reading the Job (%s)", (_label, existing) => {
    // A 409 says the name is taken; only a successful read says by what. An
    // unreadable collision must stay fatal.
    const verdict = jobAdoptionVerdict(existing, EXPECTED);
    expect(verdict.adopt).toBe(false);
    expect((verdict as { reason: string }).reason).toContain("could not be read");
  });

  it("refuses an existing Job carrying no UID", () => {
    const verdict = jobAdoptionVerdict({ metadata: { name: JOB_NAME } } as k8s.V1Job, EXPECTED);
    expect(verdict.adopt).toBe(false);
  });

  it("refuses when the existing Job's name differs from the one being created", () => {
    const verdict = jobAdoptionVerdict(job({ name: "ac-someone-else" }), EXPECTED);
    expect(verdict.adopt).toBe(false);
    expect((verdict as { reason: string }).reason).toContain("ac-someone-else");
  });

  it("refuses a Job with no run-id provenance label", () => {
    // The concurrency guard already treats an unlabelled running Job as fatal
    // (k8s_orphan_task_unknown); adoption must not be a softer back door.
    const verdict = jobAdoptionVerdict(job({ labels: {} }), EXPECTED);
    expect(verdict.adopt).toBe(false);
    expect((verdict as { reason: string }).reason).toContain("<none>");
  });

  it("refuses a Job labelled for a different run even when the UID matches", () => {
    const other = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const verdict = jobAdoptionVerdict(job({ labels: { [RUN_ID_LABEL]: other } }), EXPECTED);
    expect(verdict.adopt).toBe(false);
    expect((verdict as { reason: string }).reason).toContain(other);
  });
});

describe("jobAdoptionVerdict — run-id label is compared post-sanitization", () => {
  /**
   * job-manifest.ts writes `sanitizeLabelValue(runId)`, not the raw runId, so a
   * naive raw comparison would refuse to adopt any run whose id is not already
   * label-safe. Ordinary UUIDs sanitize to themselves, which is why this is
   * easy to get wrong without noticing.
   */
  it("adopts when the label holds the sanitized form of a non-label-safe runId", () => {
    const rawRunId = "run:/with*illegal chars";
    const sanitized = "runwithillegalchars";
    const existing = job({ labels: { [RUN_ID_LABEL]: sanitized } });
    expect(jobAdoptionVerdict(existing, { jobName: JOB_NAME, runId: rawRunId, identity: IDENTITY }))
      .toEqual({ adopt: true, jobUid: JOB_UID });
  });

  it("refuses when the runId sanitizes to nothing at all", () => {
    const verdict = jobAdoptionVerdict(job({ labels: { [RUN_ID_LABEL]: "" } }), {
      jobName: JOB_NAME,
      runId: "***",
      identity: IDENTITY,
    });
    expect(verdict.adopt).toBe(false);
    expect((verdict as { reason: string }).reason).toContain("<unlabelable>");
  });

  it("adopts an ordinary UUID runId (sanitization is the identity function here)", () => {
    expect(jobAdoptionVerdict(job(), EXPECTED)).toEqual({ adopt: true, jobUid: JOB_UID });
  });
});
