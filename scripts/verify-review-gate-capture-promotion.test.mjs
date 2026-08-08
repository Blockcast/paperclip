import assert from "node:assert/strict";
import { test } from "node:test";

import {
  authorityEnabled,
  verifyCapturePromotion,
} from "./verify-review-gate-capture-promotion.mjs";

function deployment({ authority = true, overrides = {}, status = true } = {}) {
  const env = [
    { name: "PAPERCLIP_GITHUB_REVIEW_GATE_CAPTURE_ENABLED", value: "true" },
    { name: "PAPERCLIP_GITHUB_REVIEW_GATE_REPOSITORIES", value: "Blockcast/penstock-llm-proxy-core" },
    { name: "PAPERCLIP_GITHUB_REVIEW_GATE_EXPECTED_APP_ID", value: "3966421" },
    { name: "PAPERCLIP_GITHUB_REVIEW_GATE_EXPECTED_INSTALLATION_ID", value: "138085375" },
    { name: "PAPERCLIP_PR_REVIEW_GATE_STATUS_CONTEXT", value: "review/ally-complete" },
  ];
  if (authority) env.push({ name: "PAPERCLIP_GITHUB_REVIEW_GATE_ENABLED", value: "true" });
  for (const [name, value] of Object.entries(overrides)) {
    const entry = env.find((candidate) => candidate.name === name);
    if (entry) entry.value = value;
    else env.push({ name, value });
  }
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { generation: 7, name: "paperclip-api", namespace: "paperclip" },
    spec: {
      replicas: 2,
      template: { spec: { containers: [{ name: "sidecar", env: [] }, { name: "paperclip", env }] } },
    },
    status: status
      ? { observedGeneration: 7, replicas: 2, updatedReplicas: 2, readyReplicas: 2, availableReplicas: 2 }
      : { observedGeneration: 6, replicas: 2, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 },
  };
}

test("skips promotion proof when target authority is disabled", () => {
  const target = deployment({ authority: false });
  assert.equal(authorityEnabled(target), false);
  assert.deepEqual(verifyCapturePromotion(target, null), { required: false });
});

test("accepts an exact completed live capture contract", () => {
  const result = verifyCapturePromotion(deployment(), deployment({ authority: false }));
  assert.equal(result.required, true);
  assert.deepEqual(result.contract.repositories, ["blockcast/penstock-llm-proxy-core"]);
});

test("rejects an authoritative live rollout as capture-only proof", () => {
  assert.throws(
    () => verifyCapturePromotion(deployment(), deployment()),
    /already has review-gate authority enabled/,
  );
});

test("rejects a completed rollout for a different repository", () => {
  const live = deployment({
    authority: false,
    overrides: { PAPERCLIP_GITHUB_REVIEW_GATE_REPOSITORIES: "Blockcast/other" },
  });
  assert.throws(() => verifyCapturePromotion(deployment(), live), /capture contract does not match/);
});

test("rejects reviewer, status-context, and pinned-identity mismatches", () => {
  for (const [name, value] of [
    ["PAPERCLIP_PR_REVIEWER_BOT_LOGIN", "other-reviewer[bot]"],
    ["PAPERCLIP_PR_REVIEW_GATE_STATUS_CONTEXT", "review/other"],
    ["PAPERCLIP_GITHUB_REVIEW_GATE_EXPECTED_APP_ID", "1"],
    ["PAPERCLIP_GITHUB_REVIEW_GATE_EXPECTED_INSTALLATION_ID", "2"],
  ]) {
    const live = deployment({ authority: false, overrides: { [name]: value } });
    assert.throws(() => verifyCapturePromotion(deployment(), live), /capture contract does not match/);
  }
});

test("normalizes equivalent repository and reviewer representations", () => {
  const target = deployment({
    overrides: {
      PAPERCLIP_GITHUB_REVIEW_GATE_REPOSITORIES:
        "Blockcast/penstock-llm-proxy-core,blockcast/PENSTOCK-LLM-PROXY-CORE",
      PAPERCLIP_PR_REVIEWER_BOT_LOGIN: "app/allyblockcast",
    },
  });
  assert.equal(verifyCapturePromotion(target, deployment({ authority: false })).required, true);
});

test("rejects duplicate reserved env entries on the named paperclip container", () => {
  const live = deployment({ authority: false });
  live.spec.template.spec.containers[1].env.push({
    name: "PAPERCLIP_GITHUB_REVIEW_GATE_REPOSITORIES",
    value: "Blockcast/other",
  });
  assert.throws(() => verifyCapturePromotion(deployment(), live), /duplicate reserved env/);
});

test("rejects whitespace-padded booleans exactly as the runtime does", () => {
  const live = deployment({
    authority: false,
    overrides: { PAPERCLIP_GITHUB_REVIEW_GATE_CAPTURE_ENABLED: " true " },
  });
  assert.throws(() => verifyCapturePromotion(deployment(), live), /must be true or false/);
  const target = deployment({
    overrides: { PAPERCLIP_GITHUB_REVIEW_GATE_ENABLED: " true " },
  });
  assert.throws(() => authorityEnabled(target), /must be true or false/);
});

test("ignores sidecar env but requires exactly one named paperclip container", () => {
  const live = deployment({ authority: false });
  live.spec.template.spec.containers[0].env.push({
    name: "PAPERCLIP_GITHUB_REVIEW_GATE_REPOSITORIES",
    value: "Blockcast/other",
  });
  assert.equal(verifyCapturePromotion(deployment(), live).required, true);
  live.spec.template.spec.containers.push({ name: "paperclip", env: [] });
  assert.throws(() => verifyCapturePromotion(deployment(), live), /exactly one paperclip container/);
});

test("rejects a matching contract until the live rollout is complete", () => {
  assert.throws(
    () => verifyCapturePromotion(deployment(), deployment({ authority: false, status: false })),
    /rollout is incomplete/,
  );
});
