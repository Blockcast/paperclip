import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EXIT_NONCONFORMING,
  EXIT_UNOBSERVABLE,
  exitCodeFor,
  meaningfulLines,
  run,
  validateSslMulticert,
} from "./check-relay-ssl-multicert.mjs";

const gatewayLine = "dest_domain=*.gateway.blockcast.network ssl_cert_name=/opt/trafficserver/etc/trafficserver/gateway.crt ssl_key_name=/opt/trafficserver/etc/trafficserver/gateway.key";

test("meaningfulLines ignores blank lines and comments", () => {
  assert.deepEqual(meaningfulLines(`\n# managed by t3c\n\n${gatewayLine}\n`), [gatewayLine]);
});

test("gateway-only ssl_multicert content passes", () => {
  const result = validateSslMulticert(`# managed by t3c\n${gatewayLine}\n`);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("extra non-gateway ssl_multicert line fails", () => {
  const result = validateSslMulticert(`${gatewayLine}\nssl_cert_name=/opt/trafficserver/etc/trafficserver/ds.crt ssl_key_name=/opt/trafficserver/etc/trafficserver/ds.key\n`);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /expected exactly one non-comment line/);
});

test("single line without a key declaration fails", () => {
  const result = validateSslMulticert("dest_domain=*.gateway.blockcast.network ssl_cert_name=/opt/trafficserver/etc/trafficserver/gateway.crt\n");
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /ssl_cert_name and ssl_key_name/);
});

test("exact expected gateway line can be enforced", () => {
  assert.equal(validateSslMulticert(`${gatewayLine}\n`, { expectedLine: gatewayLine }).ok, true);
  const result = validateSslMulticert(`${gatewayLine} extra=true\n`, { expectedLine: gatewayLine });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /does not match/);
});

// BLO-43371: a capacity incident and a config regression must not be the same
// red. On 2026-10-10 this guard was red for 9 consecutive hourly runs because
// the staging relay was unschedulable; the only way to learn that rather than
// "the gateway cert line regressed in production" was to open the job log.

const OPTIONS = {
  namespaces: ["staging-x", "production-x"],
  selector: "app.kubernetes.io/name=relay",
  container: "",
  file: "/opt/trafficserver/etc/trafficserver/ssl_multicert.config",
  expectedLine: "",
  kubectl: "kubectl",
};

// `pods` maps namespace -> pod names; `files` maps "ns/pod" -> file contents.
function fakeKubectl(pods, files = {}) {
  return (args) => {
    const namespace = args[args.indexOf("-n") + 1];
    if (args.includes("get")) return (pods[namespace] ?? []).join("\n") + "\n";
    const pod = args[args.indexOf("exec") + 1];
    const contents = files[`${namespace}/${pod}`];
    if (contents === undefined) throw new Error(`no fixture for ${namespace}/${pod}`);
    return contents;
  };
}

test("a namespace with no relay pods is UNOBSERVABLE, not a config failure", () => {
  const result = run(
    OPTIONS,
    fakeKubectl(
      { "staging-x": [], "production-x": ["relay-1"] },
      { "production-x/relay-1": `# managed by t3c\n${gatewayLine}\n` },
    ),
  );

  assert.equal(result.ok, false, "still fails closed");
  assert.deepEqual(result.failures, [], "no pods is not a conformance failure");
  assert.equal(result.unobservable.length, 1);
  assert.match(result.unobservable[0], /^staging-x: no running relay pods/);
  assert.deepEqual(result.checked, ["production-x/relay-1"], "the readable namespace still passed");
  assert.equal(exitCodeFor(result), EXIT_UNOBSERVABLE);
});

test("relay pods present but non-conforming is NONCONFORMING", () => {
  const result = run(
    OPTIONS,
    fakeKubectl(
      { "staging-x": ["relay-1"], "production-x": ["relay-2"] },
      {
        "staging-x/relay-1": `${gatewayLine}\nssl_cert_name=/tmp/ds.crt ssl_key_name=/tmp/ds.key\n`,
        "production-x/relay-2": `${gatewayLine}\n`,
      },
    ),
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.unobservable, []);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /expected exactly one non-comment line/);
  assert.equal(exitCodeFor(result), EXIT_NONCONFORMING);
});

test("a regression outranks an unobservable sibling namespace", () => {
  // The safe direction: an unreadable namespace must never mask a real
  // regression in one that WAS readable.
  const result = run(
    OPTIONS,
    fakeKubectl(
      { "staging-x": [], "production-x": ["relay-2"] },
      { "production-x/relay-2": `${gatewayLine}\nssl_cert_name=/tmp/ds.crt ssl_key_name=/tmp/ds.key\n` },
    ),
  );

  assert.equal(result.failures.length, 1);
  assert.equal(result.unobservable.length, 1);
  assert.equal(exitCodeFor(result), EXIT_NONCONFORMING);
});

test("every namespace readable and conforming exits 0", () => {
  const result = run(
    OPTIONS,
    fakeKubectl(
      { "staging-x": ["relay-1"], "production-x": ["relay-2"] },
      {
        "staging-x/relay-1": `# managed by t3c\n${gatewayLine}\n`,
        "production-x/relay-2": `${gatewayLine}\n`,
      },
    ),
  );

  assert.equal(result.ok, true);
  assert.equal(exitCodeFor(result), 0);
});

test("the two exit codes are distinct and both non-zero", () => {
  // Guards the point of the change: collapsing them back to one value, or
  // letting either become 0, is the defect this test exists to catch.
  assert.notEqual(EXIT_NONCONFORMING, EXIT_UNOBSERVABLE);
  assert.ok(EXIT_NONCONFORMING > 0 && EXIT_UNOBSERVABLE > 0);
});
