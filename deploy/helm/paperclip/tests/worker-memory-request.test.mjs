import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

// PEN-2957: the shared `resources` block in values.blockcast.yaml renders on
// the worker StatefulSet AND the API Deployment (there is no `api.resources`).
// The memory request is a reliability setting, not a capacity one: Burstable
// pods are ranked for eviction by usage-above-request, and the worker is the
// heartbeat scheduler + plugin-worker host for every claude_local agent. Each
// tier is checked against its own rendered document so a future
// `api.resources` split keeps both invariants.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function renderTemplate(template) {
  return execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      "deploy/helm/paperclip",
      "--namespace",
      "paperclip",
      "-f",
      "deploy/helm/paperclip/values.blockcast.yaml",
      "--show-only",
      template,
      "--set",
      "api.enabled=true",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

const UNIT_BYTES = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, K: 1e3, M: 1e6, G: 1e9 };

function quantityBytes(q) {
  const m = q.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|K|M|G)?$/);
  assert.ok(m, `unparseable memory quantity: ${q}`);
  return Number(m[1]) * (m[2] ? UNIT_BYTES[m[2]] : 1);
}

// The `paperclip` container's block: `resources:` -> limits -> requests, as
// `toYaml .Values.resources` renders it (keys sorted).
function mainContainerMemory(rendered) {
  const container = rendered.slice(rendered.indexOf("\n        - name: paperclip\n"));
  const m = container.match(
    /\n\s+resources:\n\s+limits:\n(?:\s+cpu: [^\n]+\n)?\s+memory: (\S+)\n\s+requests:\n(?:\s+cpu: [^\n]+\n)?\s+memory: (\S+)\n/,
  );
  assert.ok(m, "paperclip container must render memory limits and requests");
  const heap = container.match(/--max-old-space-size=(\d+)/);
  assert.ok(heap, "paperclip container must pin --max-old-space-size in NODE_OPTIONS");
  return {
    limit: quantityBytes(m[1]),
    request: quantityBytes(m[2]),
    requestRaw: m[2],
    heapCeiling: Number(heap[1]) * UNIT_BYTES.Mi,
  };
}

function assertMemoryInvariants(tier, mem) {
  // A request below the V8 old-space ceiling means the pod runs above its
  // request at design load, which is exactly what sorts it to the front of
  // the kubelet's eviction queue (PEN-2957).
  assert.ok(
    mem.request >= mem.heapCeiling,
    `${tier}: memory request ${mem.requestRaw} is below the --max-old-space-size heap ceiling`,
  );
  // Strictly below the limit keeps the pod Burstable, which is the QoS class
  // the eviction-ranking rationale applies to; equal would make it Guaranteed
  // and change the semantics of every number in the values comment.
  assert.ok(
    mem.request < mem.limit,
    `${tier}: memory request ${mem.requestRaw} must stay below the limit (Burstable)`,
  );
}

test("worker StatefulSet requests 7Gi, above the V8 heap ceiling and below the limit (PEN-2957)", () => {
  const mem = mainContainerMemory(renderTemplate("templates/statefulset.yaml"));
  assert.equal(mem.requestRaw, "7Gi");
  assertMemoryInvariants("worker", mem);
});

test("API Deployment memory request covers its heap ceiling and stays Burstable", () => {
  const mem = mainContainerMemory(renderTemplate("templates/deployment-api.yaml"));
  assertMemoryInvariants("api", mem);
});
