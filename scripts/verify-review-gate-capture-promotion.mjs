#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const CONTAINER_NAME = "paperclip";
const DEFAULT_REVIEWER_LOGIN = "allyblockcast[bot]";
const ENV = Object.freeze({
  authorityEnabled: "PAPERCLIP_GITHUB_REVIEW_GATE_ENABLED",
  captureEnabled: "PAPERCLIP_GITHUB_REVIEW_GATE_CAPTURE_ENABLED",
  expectedAppId: "PAPERCLIP_GITHUB_REVIEW_GATE_EXPECTED_APP_ID",
  expectedInstallationId: "PAPERCLIP_GITHUB_REVIEW_GATE_EXPECTED_INSTALLATION_ID",
  repositories: "PAPERCLIP_GITHUB_REVIEW_GATE_REPOSITORIES",
  reviewerLogin: "PAPERCLIP_PR_REVIEWER_BOT_LOGIN",
  statusContext: "PAPERCLIP_PR_REVIEW_GATE_STATUS_CONTEXT",
});
const RESERVED_ENV_NAMES = new Set(Object.values(ENV));

function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function paperclipEnvironment(deployment, label) {
  const containers = deployment?.spec?.template?.spec?.containers;
  if (!Array.isArray(containers)) {
    throw new Error(`${label} has no pod-template containers`);
  }
  const matches = containers.filter((container) => container?.name === CONTAINER_NAME);
  if (matches.length !== 1) {
    throw new Error(`${label} must contain exactly one ${CONTAINER_NAME} container`);
  }
  const entries = matches[0].env ?? [];
  if (!Array.isArray(entries)) {
    throw new Error(`${label} ${CONTAINER_NAME} env must be an array`);
  }

  const values = new Map();
  for (const entry of entries) {
    if (!RESERVED_ENV_NAMES.has(entry?.name)) continue;
    if (values.has(entry.name)) {
      throw new Error(`${label} contains duplicate reserved env ${entry.name}`);
    }
    if (typeof entry.value !== "string" || entry.valueFrom !== undefined) {
      throw new Error(`${label} reserved env ${entry.name} must use a literal string value`);
    }
    values.set(entry.name, entry.value);
  }
  return values;
}

function booleanFlag(environment, name, label) {
  const value = environment.get(name);
  if (value === undefined) return false;
  if (value !== "true" && value !== "false") {
    throw new Error(`${label} env ${name} must be true or false`);
  }
  return value === "true";
}

function requiredValue(environment, name, label) {
  const value = environment.get(name)?.trim();
  if (!value) throw new Error(`${label} is missing required env ${name}`);
  return value;
}

function normalizeReviewerLogin(value) {
  return value.toLowerCase().replace(/^app\//, "").replace(/\[bot\]$/, "");
}

function captureContract(deployment, label) {
  const environment = paperclipEnvironment(deployment, label);
  if (!booleanFlag(environment, ENV.captureEnabled, label)) {
    throw new Error(`${label} does not have durable review-gate capture enabled`);
  }
  const repositories = [
    ...new Set(
      requiredValue(environment, ENV.repositories, label)
        .split(",")
        .map((repository) => repository.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort();
  if (repositories.length === 0) {
    throw new Error(`${label} has no review-gate capture repositories`);
  }
  return {
    expectedAppId: requiredValue(environment, ENV.expectedAppId, label),
    expectedInstallationId: requiredValue(environment, ENV.expectedInstallationId, label),
    repositories,
    reviewerLogin: normalizeReviewerLogin(
      environment.get(ENV.reviewerLogin)?.trim() || DEFAULT_REVIEWER_LOGIN,
    ),
    statusContext: requiredValue(environment, ENV.statusContext, label),
  };
}

function assertCompletedRollout(deployment) {
  const desired = deployment?.spec?.replicas ?? 1;
  if (!Number.isInteger(desired) || desired < 1) {
    throw new Error("live API Deployment must have at least one desired replica");
  }
  const generation = deployment?.metadata?.generation;
  const status = record(deployment?.status, "live API Deployment status");
  const complete = Number.isInteger(generation)
    && status.observedGeneration === generation
    && status.replicas === desired
    && status.updatedReplicas === desired
    && status.readyReplicas === desired
    && status.availableReplicas === desired
    && (status.unavailableReplicas ?? 0) === 0;
  if (!complete) {
    throw new Error("live API capture rollout is incomplete");
  }
}

export function authorityEnabled(deployment) {
  return booleanFlag(
    paperclipEnvironment(record(deployment, "target API Deployment"), "target API Deployment"),
    ENV.authorityEnabled,
    "target API Deployment",
  );
}

export function verifyCapturePromotion(targetDeployment, liveDeployment) {
  const target = record(targetDeployment, "target API Deployment");
  if (!authorityEnabled(target)) return { required: false };
  const live = record(liveDeployment, "live API Deployment");
  const liveEnvironment = paperclipEnvironment(live, "live API Deployment");
  if (booleanFlag(liveEnvironment, ENV.authorityEnabled, "live API Deployment")) {
    throw new Error("live API Deployment already has review-gate authority enabled");
  }
  const targetContract = captureContract(target, "target API Deployment");
  const liveContract = captureContract(live, "live API Deployment");
  if (JSON.stringify(liveContract) !== JSON.stringify(targetContract)) {
    throw new Error(
      `live capture contract does not match authority target: live=${JSON.stringify(liveContract)} target=${JSON.stringify(targetContract)}`,
    );
  }
  assertCompletedRollout(live);
  return { required: true, contract: targetContract };
}

function parseArgs(argv) {
  const args = { live: null, printAuthority: false, target: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") args.target = argv[++index] ?? null;
    else if (arg === "--live") args.live = argv[++index] ?? null;
    else if (arg === "--print-authority") args.printAuthority = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.target) throw new Error("--target is required");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = JSON.parse(await readFile(args.target, "utf8"));
  if (args.printAuthority) {
    process.stdout.write(`${authorityEnabled(target)}\n`);
    return;
  }
  if (!authorityEnabled(target)) {
    console.log("Review-gate authority disabled; live capture promotion proof not required");
    return;
  }
  if (!args.live) throw new Error("--live is required when review-gate authority is enabled");
  const live = JSON.parse(await readFile(args.live, "utf8"));
  const result = verifyCapturePromotion(target, live);
  console.log(`Verified completed live review-gate capture contract ${JSON.stringify(result.contract)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`Review-gate authority promotion refused: ${error.message}`);
    process.exitCode = 1;
  });
}
