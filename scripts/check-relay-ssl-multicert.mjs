#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const DEFAULT_FILE = "/opt/trafficserver/etc/trafficserver/ssl_multicert.config";
const DEFAULT_GATEWAY_LINE_RE = /\bgateway\b/i;

export function meaningfulLines(contents) {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export function validateSslMulticert(contents, options = {}) {
  const lines = meaningfulLines(contents);
  const expectedLine = options.expectedLine?.trim();
  const gatewayLineRe = options.gatewayLineRe ?? DEFAULT_GATEWAY_LINE_RE;
  const errors = [];

  if (lines.length !== 1) {
    errors.push(`expected exactly one non-comment line, found ${lines.length}`);
  }

  if (expectedLine) {
    if (lines[0] !== expectedLine) {
      errors.push("single line does not match RELAY_SSL_MULTICERT_EXPECTED_LINE");
    }
  } else if (lines[0]) {
    if (!gatewayLineRe.test(lines[0])) {
      errors.push("single line does not look like the gateway certificate line");
    }
    if (!/\bssl_cert_name\b/.test(lines[0]) || !/\bssl_key_name\b/.test(lines[0])) {
      errors.push("single line must declare ssl_cert_name and ssl_key_name");
    }
  }

  return { ok: errors.length === 0, lines, errors };
}

function parseArgs(argv) {
  const args = {
    namespaces: (process.env.RELAY_SSL_MULTICERT_NAMESPACES ?? "staging-traffic-control,production-traffic-control")
      .split(",")
      .map((namespace) => namespace.trim())
      .filter(Boolean),
    selector: process.env.RELAY_SSL_MULTICERT_SELECTOR ?? "app=relay-ats",
    container: process.env.RELAY_SSL_MULTICERT_CONTAINER ?? "",
    file: process.env.RELAY_SSL_MULTICERT_FILE ?? DEFAULT_FILE,
    expectedLine: process.env.RELAY_SSL_MULTICERT_EXPECTED_LINE ?? "",
    kubectl: process.env.KUBECTL ?? "kubectl",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--namespace" && next) {
      args.namespaces = [next];
      i += 1;
    } else if (arg === "--namespaces" && next) {
      args.namespaces = next.split(",").map((namespace) => namespace.trim()).filter(Boolean);
      i += 1;
    } else if (arg === "--selector" && next) {
      args.selector = next;
      i += 1;
    } else if (arg === "--container" && next) {
      args.container = next;
      i += 1;
    } else if (arg === "--file" && next) {
      args.file = next;
      i += 1;
    } else if (arg === "--expected-line" && next) {
      args.expectedLine = next;
      i += 1;
    } else if (arg === "--kubectl" && next) {
      args.kubectl = next;
      i += 1;
    } else if (arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown or incomplete argument: ${arg}`);
    }
  }

  if (args.namespaces.length === 0) throw new Error("at least one namespace is required");
  if (!args.selector) throw new Error("--selector is required");
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/check-relay-ssl-multicert.mjs [options]\n\nChecks every selected relay pod's ${DEFAULT_FILE} via kubectl exec.\n\nOptions:\n  --namespaces <csv>     Namespace list (default: RELAY_SSL_MULTICERT_NAMESPACES)\n  --namespace <name>     Single namespace\n  --selector <selector>  Relay pod selector (default: app=relay-ats)\n  --container <name>     Optional container name for kubectl exec\n  --file <path>          File to read inside each pod\n  --expected-line <line> Exact gateway-only line to require\n  --kubectl <path>       kubectl executable path\n`);
}

function kubectl(args, options) {
  return execFileSync(options.kubectl, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// A pod being replaced still reports status.phase=Running until it is gone,
// so the field selector alone lets the walk exec into a container that has
// already stopped: `container not found` -> a thrown kubectl error -> exit 1,
// i.e. a rollout read as a config regression (BLO-49205). Skip pods that are
// terminating, or whose target container is not running; they are logged,
// never exec'd. A namespace left with no eligible pod is UNOBSERVABLE.
export function eligiblePods(items, container) {
  const pods = [];
  const skipped = [];
  for (const item of items) {
    const name = item.metadata?.name;
    if (!name) continue;
    if (item.metadata.deletionTimestamp) {
      skipped.push(`${name}: terminating (deletionTimestamp=${item.metadata.deletionTimestamp})`);
      continue;
    }
    if (container) {
      const status = (item.status?.containerStatuses ?? []).find((c) => c.name === container);
      if (!status?.state?.running) {
        skipped.push(`${name}: container ${container} not running`);
        continue;
      }
    }
    pods.push(name);
  }
  return { pods, skipped };
}

function listPods(namespace, options, exec) {
  const output = exec(
    ["-n", namespace, "get", "pods", "-l", options.selector, "--field-selector", "status.phase=Running", "-o", "json"],
    options,
  );
  return eligiblePods(JSON.parse(output).items ?? [], options.container);
}

function readPodFile(namespace, pod, options, exec) {
  const args = ["-n", namespace, "exec", pod];
  if (options.container) args.push("-c", options.container);
  args.push("--", "cat", options.file);
  return exec(args, options);
}

// Two ways to be red, and they route to DIFFERENT lanes (BLO-43371).
//
//   1 NONCONFORMING  relay pods were read and the file shape is wrong.
//                    A config regression. Delivery-path / Traffic Ops lane.
//   2 UNOBSERVABLE   a namespace has no running relay pods, so the invariant
//                    could not be evaluated there at all. Usually capacity or
//                    scheduling. Platform/SRE lane.
//
// Both still fail closed — "no pods" has never been read as "nothing wrong"
// here and still is not. This only makes the two tellable apart without
// reading the log, because on 2026-10-10 an 8h case of (2) was triaged by two
// people as if it might be (1).
export const EXIT_NONCONFORMING = 1;
export const EXIT_UNOBSERVABLE = 2;

export function exitCodeFor(result) {
  // NONCONFORMING wins a tie deliberately: an unobservable namespace must
  // never mask a real regression in a sibling namespace that WAS readable.
  // The quieter failure losing is the safe direction.
  if (result.failures.length > 0) return EXIT_NONCONFORMING;
  if (result.unobservable.length > 0) return EXIT_UNOBSERVABLE;
  return 0;
}

// `exec` is injected so the namespace-walk is testable without a cluster;
// it defaults to the real kubectl. Same shape as the fetch= injection the
// master-gate reducer uses.
export function run(options, exec = kubectl) {
  const failures = [];
  const unobservable = [];
  const checked = [];
  const skipped = [];

  for (const namespace of options.namespaces) {
    const listed = listPods(namespace, options, exec);
    const pods = listed.pods;
    for (const reason of listed.skipped) skipped.push(`${namespace}/${reason}`);
    if (pods.length === 0) {
      unobservable.push(`${namespace}: no running relay pods matched selector ${options.selector}`);
      continue;
    }

    for (const pod of pods) {
      const contents = readPodFile(namespace, pod, options, exec);
      const result = validateSslMulticert(contents, { expectedLine: options.expectedLine });
      checked.push(`${namespace}/${pod}`);
      if (!result.ok) {
        failures.push(`${namespace}/${pod}: ${result.errors.join("; ")} (lines=${JSON.stringify(result.lines)})`);
      }
    }
  }

  return { ok: failures.length === 0 && unobservable.length === 0, checked, skipped, failures, unobservable };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = run(options);

  for (const pod of result.skipped) console.log(`SKIP ${pod}`);
  for (const pod of result.checked) console.log(`PASS ${pod}`);
  if (!result.ok) {
    for (const failure of result.failures) console.error(`FAIL ${failure}`);
    for (const gap of result.unobservable) console.error(`UNOBSERVABLE ${gap}`);
    process.exitCode = exitCodeFor(result);
    return;
  }

  console.log(`relay ssl_multicert gateway-only guard passed for ${result.checked.length} pod(s)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    // KNOWN RESIDUAL: a thrown kubectl error (API unreachable, namespace
    // missing, exec denied) is an UNOBSERVABLE condition but exits 1 here,
    // because this catch also covers parseArgs usage errors, which are not.
    // Splitting them needs a second try block and buys nothing today: the
    // workflow treats any non-zero as red either way, and the message on
    // stderr already names the cause. Revisit if a transport failure is ever
    // mistaken for a regression. (It was, BLO-49205: a pod mid-replacement;
    // eligiblePods now skips those. A pod that starts terminating between the
    // list and the exec can still land here — a narrower window, same exit.)
    process.exitCode = EXIT_NONCONFORMING;
  }
}
