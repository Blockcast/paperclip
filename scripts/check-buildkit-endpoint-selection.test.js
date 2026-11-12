// PEN-6371. Pins the BuildKit endpoint selection in docker.yml's
// `build-and-push` job to a liveness signal strong enough to be worth having.
//
// The defect: the step chose its endpoint on `nc -z`, a TCP connect. On
// 2026-11-09 run 42629411195 that connect returned 0 against
// buildkit-amd64-1 and the very next step died with `frontend grpc server
// closed unexpectedly` -- on commit 220d2ae1f441, which run 42612377459 had
// built clean on buildkit-amd64-0 two hours earlier. The daemon was
// listening and could not serve a solve, so the ClusterIP fallback the step
// exists to provide could not engage. `PREFERRED_ORDINAL` pins
// workflow_dispatch to ordinal 1 and push to ordinal 0, so the production
// deploy lane is the only lane that reaches the less-exercised builder, and
// a dispatch lost that way waits for the next 07:23Z slot.
//
// Executable rather than render-level, for the reason recorded on
// check-docker-retire-in-flight-lock.test.js: #1636's review showed two
// presence-only assertions passing against mutated code. The step's real
// shell is extracted between markers and run against REAL TCP endpoints --
// one that serves, one that accepts and immediately closes, which is the
// shape that defeated the old probe -- so the green and the red are both
// produced by socket behaviour rather than asserted. The seam that does the
// discriminating is additionally mutation-tested, so deleting the solve
// makes this file fail by name instead of degrading to a clean verdict.
//
// The shell stays INLINE in docker.yml rather than moving to
// .github/scripts/. `build-and-push` checks out `inputs.target_sha`, which
// on a rollback is an older commit whose tree would not contain a new
// script, while the workflow body always comes from the dispatched ref.
import assert from "node:assert/strict";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workflow = readFileSync(path.join(repoRoot, ".github/workflows/docker.yml"), "utf8");

const PREFERRED_0 = "buildkit-amd64-0.buildkit-amd64-headless.ci.svc.cluster.local";
const PREFERRED_1 = "buildkit-amd64-1.buildkit-amd64-headless.ci.svc.cluster.local";
const FALLBACK = "buildkit-amd64.ci.svc.cluster.local";

// ---------------------------------------------------------------- extraction

// Extracted between explicit markers rather than by matching the probe's text,
// so rewording a message cannot silently reduce this file to testing nothing:
// a missing marker throws here instead.
function extractStep() {
  const beginMarker = "# BEGIN SELECT_BUILDKIT_ENDPOINT";
  const endMarker = "# END SELECT_BUILDKIT_ENDPOINT";
  const start = workflow.indexOf(beginMarker);
  assert.notEqual(start, -1, `could not locate ${beginMarker} in docker.yml`);
  const end = workflow.indexOf(endMarker, start);
  assert.notEqual(end, -1, `could not locate ${endMarker} in docker.yml`);
  const body = workflow
    .slice(start + beginMarker.length, end)
    .split("\n")
    .map((line) => (line.startsWith(" ".repeat(10)) ? line.slice(10) : line))
    .join("\n");
  return `set -euo pipefail\n${body}\n`;
}

const STEP = extractStep();

// ------------------------------------------------------------- real endpoints

// `serving` answers a request byte. `listening` accepts the connection and
// destroys it without answering -- a daemon that holds its listener while the
// thing behind it is gone. That second one is the whole row: it is
// indistinguishable from healthy at the TCP layer.
const servers = [];

function startServer(onConnection) {
  const server = net.createServer(onConnection);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

const servingPort = await startServer((socket) => {
  socket.on("data", () => socket.write("\x01"));
  socket.on("error", () => {});
});

const listeningOnlyPort = await startServer((socket) => socket.destroy());

// A port nothing is bound to, for the arm where the pod is simply gone.
const deadPort = await (async () => {
  const probe = net.createServer();
  const port = await new Promise((resolve) => {
    probe.listen(0, "127.0.0.1", () => resolve(probe.address().port));
  });
  await new Promise((resolve) => probe.close(resolve));
  return port;
})();

after(() => {
  for (const server of servers) server.close();
});

// ------------------------------------------------------------------ the fakes

// `nc` and `docker` are reimplemented against real sockets rather than
// stubbed to a verdict. `nc` is `nc -z` semantics: connect, report, close.
// `docker buildx build` is what buildx does that `nc` does not -- it issues a
// request and needs an answer -- and it reports the failure in the words the
// 13:59Z run reported. Neither fake decides anything; the servers above do.
const NODE = process.execPath;

const NC_SOURCE = `#!${NODE}
const net = require("node:net");
const map = JSON.parse(process.env.PROBE_MAP || "{}");
const args = process.argv.slice(2).filter((a) => !a.startsWith("-") && a !== process.argv[process.argv.indexOf("-w") + 1]);
const host = args[0];
const port = map[host];
if (port === undefined) { process.exit(1); }
const socket = net.connect({ host: "127.0.0.1", port });
socket.setTimeout(5000);
socket.on("connect", () => { socket.destroy(); process.exit(0); });
socket.on("timeout", () => { socket.destroy(); process.exit(1); });
socket.on("error", () => process.exit(1));
`;

const DOCKER_SOURCE = `#!${NODE}
const net = require("node:net");
const fs = require("node:fs");
const map = JSON.parse(process.env.PROBE_MAP || "{}");
const ledger = process.env.PROBE_LEDGER;
const argv = process.argv.slice(2);
fs.appendFileSync(ledger, argv.join(" ") + "\\n");
const state = process.env.PROBE_BUILDERS;
function builders() { try { return JSON.parse(fs.readFileSync(state, "utf8")); } catch { return {}; } }
function save(v) { fs.writeFileSync(state, JSON.stringify(v)); }

if (argv[0] !== "buildx") process.exit(1);

if (argv[1] === "version") {
  // The guard's only question: is the plugin here? A CLI without it answers
  // this non-zero, which is what DOCKER_WITHOUT_BUILDX_SOURCE reproduces.
  process.stdout.write("github.com/docker/buildx v0.36.1\\n");
  process.exit(0);
}

if (argv[1] === "create") {
  // Real \`docker buildx create --driver remote\` records an endpoint; it does
  // not dial. Keeping that faithful is what makes \`build\` the only seam that
  // can observe the daemon.
  const name = argv[argv.indexOf("--name") + 1];
  const endpoint = argv[argv.length - 1];
  const all = builders();
  if (all[name]) process.exit(1);
  all[name] = endpoint;
  save(all);
  process.exit(0);
}

if (argv[1] === "rm") {
  const all = builders();
  delete all[argv[2]];
  save(all);
  process.exit(0);
}

if (argv[1] === "build") {
  const name = argv[argv.indexOf("--builder") + 1];
  const endpoint = builders()[name];
  if (!endpoint) process.exit(1);
  const host = endpoint.replace(/^tcp:\\/\\//, "").replace(/:1234$/, "");
  const port = map[host];
  if (port === undefined) process.exit(1);
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.setTimeout(5000);
  let answered = false;
  socket.on("connect", () => socket.write("solve"));
  socket.on("data", () => { answered = true; socket.destroy(); });
  socket.on("close", () => {
    if (answered) process.exit(0);
    process.stderr.write("ERROR: failed to build: failed to run Build function: frontend grpc server closed unexpectedly\\n");
    process.exit(1);
  });
  socket.on("timeout", () => socket.destroy());
  socket.on("error", () => {});
  process.exitCode = 1;
}
`;

// PEN-6579 item 2. A Docker CLI whose buildx plugin is absent: every buildx
// subcommand, `version` included, exits non-zero the way a real CLI does. It
// still writes the ledger, so a case can prove the step stopped AT the guard
// rather than going on to create a builder and score the absence as a red.
const DOCKER_WITHOUT_BUILDX_SOURCE = `#!${NODE}
const fs = require("node:fs");
fs.appendFileSync(process.env.PROBE_LEDGER, process.argv.slice(2).join(" ") + "\\n");
process.stderr.write("docker: 'buildx' is not a docker command.\\n");
process.exit(1);
`;

// A sealed PATH: only the utilities the step actually invokes. That is what
// lets the "no docker client" arm be a genuine absence rather than a stub
// that reports one.
const REAL_UTILITIES = ["timeout", "mktemp", "rm"];

function resolveBinary(name) {
  const resolved = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
  assert.ok(resolved, `test host lacks ${name}`);
  return resolved;
}

// Resolved absolutely: the sealed PATH below deliberately has no shell in it,
// and a spawn that cannot find its interpreter exits non-zero, which several
// cases here would otherwise read as the step's own refusal.
const BASH = resolveBinary("bash");

function makePath({ withDocker = true, withBuildx = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "buildkit-probe-path-"));
  for (const utility of REAL_UTILITIES) {
    symlinkSync(resolveBinary(utility), path.join(dir, utility));
  }
  writeFileSync(path.join(dir, "nc"), NC_SOURCE);
  chmodSync(path.join(dir, "nc"), 0o755);
  if (withDocker) {
    writeFileSync(path.join(dir, "docker"), withBuildx ? DOCKER_SOURCE : DOCKER_WITHOUT_BUILDX_SOURCE);
    chmodSync(path.join(dir, "docker"), 0o755);
  }
  return dir;
}

// ------------------------------------------------------------------ the runner

// Defaults to the shape that broke production: a dispatch build, pinned to
// ordinal 1, whose preferred ordinal accepts TCP and cannot serve a solve. A
// case that forgets a field inherits the defect rather than a benign baseline.
// Asynchronous on purpose. The endpoints above are served by THIS process, so
// a blocking spawnSync would hold the event loop for the whole step and no
// socket could ever answer -- every endpoint would read as sick and the RED
// case below would pass without testing anything.
async function runStep({
  ordinal = "1",
  preferred = listeningOnlyPort,
  sibling = null,
  fallback = servingPort,
  withDocker = true,
  withBuildx = true,
  shell = STEP,
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "buildkit-probe-"));
  const output = path.join(root, "github_output");
  const ledger = path.join(root, "ledger");
  const builders = path.join(root, "builders.json");
  writeFileSync(output, "");
  writeFileSync(ledger, "");
  writeFileSync(builders, "{}");

  // The sibling ordinal is UNMAPPED unless a case asks for it, and the fake
  // `nc` reports an unmapped host as refusing connections. That is deliberate:
  // every case written before PEN-6579 added the sibling arm keeps exercising
  // the ClusterIP arm it was written for, so its assertions still mean what
  // they said.
  const map = { [FALLBACK]: fallback };
  map[ordinal === "1" ? PREFERRED_1 : PREFERRED_0] = preferred;
  if (sibling !== null) map[ordinal === "1" ? PREFERRED_0 : PREFERRED_1] = sibling;

  const result = await new Promise((resolve, reject) => {
    const child = spawn(BASH, ["-c", shell], {
      env: {
        PATH: makePath({ withDocker, withBuildx }),
        PREFERRED_ORDINAL: ordinal,
        GITHUB_OUTPUT: output,
        PROBE_MAP: JSON.stringify(map),
        PROBE_LEDGER: ledger,
        PROBE_BUILDERS: builders,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

  const outputs = readFileSync(output, "utf8");
  const endpoint = outputs.match(/^endpoint=(.*)$/m)?.[1] ?? null;
  return {
    ...result,
    endpoint,
    host: endpoint?.replace(/^tcp:\/\//, "").replace(/:1234$/, "") ?? null,
    ledger: readFileSync(ledger, "utf8"),
  };
}

// -------------------------------------------------------------- the two values
// Done-when 3: the gate must be shown returning BOTH values against real
// endpoints. These two cases differ only in which real socket the preferred
// ordinal points at.

test("GREEN: a preferred ordinal that can complete a solve is kept", async () => {
  const result = await runStep({ preferred: servingPort });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.host, PREFERRED_1);
  assert.doesNotMatch(result.stdout, /::warning::Preferred BuildKit/);
});

test("RED: a preferred ordinal that accepts TCP but cannot complete a solve falls back", async () => {
  // The 2026-11-09 shape. The endpoint is listening -- test 'the old probe'
  // below proves a TCP connect to this very socket succeeds -- and it cannot
  // serve. The step must demote to the ClusterIP.
  const result = await runStep({ preferred: listeningOnlyPort });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.host, FALLBACK);
  assert.match(result.stdout, /accepts connections but cannot complete a solve/);
});

test("the probe's red comes from a solve, not from a second connect", async () => {
  // A connect-shaped probe wearing a new message would pass both cases above.
  // The ledger is what the fake client was actually asked to do.
  const result = await runStep({ preferred: listeningOnlyPort });

  assert.match(result.ledger, /buildx create --name \S+ --driver remote tcp:\/\/buildkit-amd64-1\S*:1234/);
  assert.match(result.ledger, /buildx build --builder \S+ --output type=cacheonly \//);
  // And it cleans up after itself; a leaked builder makes the next probe's
  // create collide and reports a healthy daemon as sick.
  assert.match(result.ledger, /buildx rm /);
});

test("CONTROL: the probe this replaces cannot tell those two endpoints apart", async () => {
  // This is why the row exists, measured rather than asserted: `nc -z`
  // succeeds against the sick socket exactly as it does against the healthy
  // one, so no rewording of the old probe could have engaged the fallback.
  const connect = (port) =>
    new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.setTimeout(5000);
      socket.on("connect", () => { socket.destroy(); resolve(true); });
      socket.on("timeout", () => { socket.destroy(); resolve(false); });
      socket.on("error", () => resolve(false));
    });

  assert.equal(await connect(servingPort), true);
  assert.equal(await connect(listeningOnlyPort), true, "the sick endpoint must be TCP-indistinguishable, or this file tests nothing");
  assert.equal(await connect(deadPort), false, "negative control: a connect check must still be able to report a red");
});

// ------------------------------------------------------------------- mutation

test("MUTATION: deleting the solve from the preferred arm makes the sick endpoint pass", async () => {
  // Proves the RED case above is load-bearing rather than incidentally green.
  const anchor = "elif ! probe_solve \"${preferred}\" 90; then";
  assert.ok(STEP.includes(anchor), "mutation anchor not found -- this test is vacuous");
  const mutated = STEP.replace(anchor, "elif false; then");

  const result = await runStep({ preferred: listeningOnlyPort, shell: mutated });
  assert.equal(result.status, 0);
  assert.equal(result.host, PREFERRED_1, "gutting the solve must reinstate the defect, or the RED case is not testing the solve");
});

// ----------------------------------------------------------- preserved behaviour

test("a preferred ordinal that refuses connections still falls back", async () => {
  const result = await runStep({ preferred: deadPort });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.host, FALLBACK);
  assert.match(result.stdout, /does not accept connections/);
});

test("an unreachable fallback still fails the step", async () => {
  // Pre-existing behaviour, deliberately unchanged: there is no endpoint
  // beyond the ClusterIP, so an unreachable one is terminal.
  const result = await runStep({ preferred: deadPort, fallback: deadPort });
  assert.notEqual(result.status, 0);
});

test("an unserviceable fallback warns instead of failing the step", async () => {
  // Deliberate asymmetry. The ClusterIP balances over whichever pods the
  // Service reports Ready, so a failed solve there has nowhere to demote to,
  // and buildx's own error on the real build says more than this step could.
  const result = await runStep({ preferred: deadPort, fallback: listeningOnlyPort });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.host, FALLBACK);
  assert.match(result.stdout, /did not complete a probe solve; continuing/);
});

test("without a docker client the step keeps the preferred ordinal and says so", async () => {
  // "Cannot measure" must not read as "unhealthy": scoring it red would route
  // every build to the ClusterIP and dissolve the per-ordinal cache affinity
  // this step exists to maintain, silently. It degrades to the
  // pre-PEN-6371 behaviour, loudly.
  const result = await runStep({ preferred: listeningOnlyPort, withDocker: false });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.host, PREFERRED_1);
  assert.match(result.stdout, /::warning::docker buildx is unavailable/);
});

// ---------------------------------------------- PEN-6579 item 2: which binary

test("a docker CLI without the buildx plugin also keeps the preferred ordinal", async () => {
  // The case `command -v docker` could not see. The CLI is present, so the old
  // guard passed; the plugin is not, so `buildx create` failed, rc=1 came back
  // as "unhealthy", and EVERY build routed to the ClusterIP -- silently
  // dissolving the affinity the comment above promises to keep. "Cannot
  // measure" has to reach the same answer here as with no client at all.
  const result = await runStep({ preferred: listeningOnlyPort, withBuildx: false });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.host, PREFERRED_1);
  assert.match(result.stdout, /::warning::docker buildx is unavailable/);
  // Stopped AT the guard: no builder was ever created, so nothing could have
  // been scored unhealthy on the plugin's absence.
  assert.match(result.ledger, /buildx version/);
  assert.doesNotMatch(result.ledger, /buildx create/);
});

test("MUTATION: the old `command -v docker` guard sends that same CLI to the ClusterIP", async () => {
  // Proves the guard change is load-bearing rather than cosmetic: restore the
  // predicate item 2 replaced and the case above inverts.
  const anchor = 'if ! docker buildx version >/dev/null 2>&1; then';
  assert.ok(STEP.includes(anchor), "mutation anchor not found -- this test is vacuous");
  const mutated = STEP.replace(anchor, 'if ! command -v docker >/dev/null 2>&1; then');

  const result = await runStep({ preferred: listeningOnlyPort, withBuildx: false, shell: mutated });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.host, FALLBACK, "the old guard must reinstate the defect, or the case above tests nothing");
});

// --------------------------------------------- PEN-6579 item 1: the sibling arm

test("a sick preferred ordinal demotes to the sibling ordinal, not the ClusterIP", async () => {
  // The ClusterIP balances over whichever pods the Service reports Ready, and
  // the pod just rejected can stay Ready for ~15 min (livenessProbe
  // periodSeconds 60 x failureThreshold 15), so demoting straight to it is a
  // coin flip that can re-select the daemon this step just measured as sick.
  const result = await runStep({ preferred: listeningOnlyPort, sibling: servingPort });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.host, PREFERRED_0, "ordinal 1 cannot serve and ordinal 0 can, so ordinal 0 is the endpoint");
  assert.match(result.stdout, /its cache is cold for this build class/);
});

test("the sibling is probed on a solve, not trusted", async () => {
  // Same shape as the defect in the preferred arm: a sibling can accept TCP
  // and be unable to serve. Taking it on a connect would move the 2026-11-09
  // failure one endpoint to the right rather than removing it.
  const result = await runStep({ preferred: listeningOnlyPort, sibling: listeningOnlyPort });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.host, FALLBACK);
  assert.match(result.stdout, /Neither ordinal can complete a solve/);
  assert.match(result.ledger, /buildx create --name \S+ --driver remote tcp:\/\/buildkit-amd64-0\S*:1234/);
});

test("MUTATION: dropping the sibling's solve makes a sick sibling get selected", async () => {
  const anchor = 'if probe_tcp "${sibling}" 5 && probe_solve "${sibling}" 90; then';
  assert.ok(STEP.includes(anchor), "mutation anchor not found -- this test is vacuous");
  const mutated = STEP.replace(anchor, 'if probe_tcp "${sibling}" 5; then');

  const result = await runStep({ preferred: listeningOnlyPort, sibling: listeningOnlyPort, shell: mutated });

  assert.equal(result.host, PREFERRED_0, "gutting the sibling solve must reinstate the defect, or the case above is not testing it");
});

test("the sibling arm honours whichever ordinal was preferred", async () => {
  // Symmetry. A push build prefers ordinal 0, so its sibling is ordinal 1.
  const result = await runStep({ ordinal: "0", preferred: listeningOnlyPort, sibling: servingPort });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.host, PREFERRED_1);
});

test("a healthy preferred ordinal never probes the sibling", async () => {
  // The added arm must cost nothing on the happy path: no extra dial, no extra
  // solve, and the same endpoint as before.
  const result = await runStep({ preferred: servingPort, sibling: servingPort });

  assert.equal(result.host, PREFERRED_1);
  assert.doesNotMatch(result.ledger, /buildkit-amd64-0/, "the sibling must not be touched while the preferred ordinal serves");
});

test("an ordinal outside the StatefulSet is refused before any probe", async () => {
  const result = await runStep({ ordinal: "2" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid BuildKit ordinal/);
  assert.equal(result.ledger, "", "a bad ordinal must not reach a builder");
});

// -------------------------------------------------------------- the wiring

test("either ordinal is reachable, and each selects its own builder", () => {
  // Asserted by execution rather than by matching the ${{ }} expression that
  // chooses the ordinal. scripts/__tests__/ci-cache-routing.test.mjs owns that
  // spelling, and #3617 (BLO-55269) is in flight to replace it with a
  // `buildkit_ordinal` dispatch input -- a second copy of the pin here would
  // have to be updated in lockstep for no added coverage. What this file needs
  // is that whatever chooses the ordinal, the step honours it.
  return Promise.all([runStep({ ordinal: "0", preferred: servingPort }), runStep({ ordinal: "1", preferred: servingPort })]).then(
    ([zero, one]) => {
      assert.equal(zero.host, PREFERRED_0);
      assert.equal(one.host, PREFERRED_1);
    },
  );
});

test("the selected endpoint is what buildx is configured with", () => {
  const step = workflow.slice(workflow.indexOf("- name: Select BuildKit endpoint"));
  const buildx = step.slice(step.indexOf("- name: Set up Docker Buildx"));
  assert.match(buildx.slice(0, buildx.indexOf("- name: Resolve stable runtime image")), /endpoint: \$\{\{ steps\.buildkit-endpoint\.outputs\.endpoint \}\}/);
  assert.match(step.slice(0, step.indexOf("- name: Set up Docker Buildx")), /id: buildkit-endpoint/);
});
