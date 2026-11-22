// BLO-58597: answers `initialize`, then closes its own stdin (fd 0) while
// staying alive. The host's `child.stdin.writable` still reads true, so the
// next host write fails asynchronously with EPIPE on the stdin socket.
const fs = require("node:fs");
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message && message.method === "initialize") {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true, supportedMethods: ["environmentExecute"] } })}\n`,
    );
    rl.close();
    process.stdin.destroy();
    fs.closeSync(0);
    setInterval(() => {}, 1_000);
  }
});
