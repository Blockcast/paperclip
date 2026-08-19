// A registry that fails the first burst of requests and then works.
//
// Used only by .github/workflows/pnpm-setup-retry-proof.yml to prove that
// ./.github/actions/setup-pnpm recovers on its second attempt (BLO-28813).
//
// "First burst" rather than "first N seconds" so the result does not depend on
// how fast the runner is: every request within BURST_MS of the first one is
// rejected, which covers attempt one (it fails in seconds, since the wrapper
// sets npm_config_fetch_retries=0), and the wrapper's 10-25s jittered backoff
// guarantees attempt two lands outside the window.
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const BURST_MS = 8_000;
const UPSTREAM = "https://registry.npmjs.org";
const logPath = process.env.PROXY_LOG ?? "/tmp/flaky-registry.jsonl";

let firstRequestAt = null;
let rejected = 0;
let served = 0;

const server = createServer((req, res) => {
  const now = Date.now();
  firstRequestAt ??= now;
  const inBurst = now - firstRequestAt < BURST_MS;

  appendFileSync(
    logPath,
    `${JSON.stringify({ at: now, url: req.url, rejected: inBurst })}\n`,
  );

  if (inBurst) {
    rejected += 1;
    // 503 rather than a hang: the point is to fail attempt one deterministically,
    // not to burn its 120s deadline.
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("flaky-registry: rejecting first burst\n");
    return;
  }

  served += 1;
  // Redirect rather than pipe: npm and pnpm follow redirects, and this keeps the
  // proxy from having to rewrite tarball URLs in registry metadata.
  res.writeHead(302, { location: `${UPSTREAM}${req.url}` });
  res.end();
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  writeFileSync(process.env.PROXY_PORT_FILE ?? "/tmp/flaky-registry.port", String(port));
  console.log(`flaky registry listening on 127.0.0.1:${port}, burst window ${BURST_MS}ms`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`flaky registry: rejected=${rejected} served=${served}`);
    process.exit(0);
  });
}
