#!/usr/bin/env node
// Detects producer-contract clauses that merged into `.planning/ally-agent/AGENTS.md`
// but never reached Ally's live managed instructions bundle (BLO-43668).
//
// Nothing syncs the repo file into the bundle, so a merged clause is inert until
// someone hand-writes it there. This does NOT require the two documents to match —
// the bundle is ~10x larger and legitimately diverges. It checks only the clauses
// the repo file explicitly declares as bound for the producer, via lines of the form
//
//     <!-- bundle-anchor: <literal text> -->
//
// Each anchor must appear verbatim somewhere in the live bundle. Pick a stable
// identifier (a function name, a block tag), never a prose sentence: prose gets
// reworded on the way into the bundle and would false-flag a clause that landed.
//
// Usage: check-ally-bundle-anchors.mjs [--repo <file>] [--bundle <file>]
// Without --bundle, the bundle is fetched via GET /api/agents/:id/instructions-bundle/file
// using PAPERCLIP_API_URL / PAPERCLIP_API_KEY. Exit 0 clean, 1 divergent, 2 cannot judge.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ALLY_AGENT_ID = "e0a5011d-5c94-4801-be52-64c14f98ac26";
const ANCHOR = /^<!-- bundle-anchor: (.+?) -->$/gm;

export function parseAnchors(repoText) {
  return [...repoText.matchAll(ANCHOR)].map((m) => m[1]);
}

// Returns { anchors, missing }. Throws when there is nothing to judge, because a
// detector with zero anchors (or an empty bundle) would report "clean" forever.
export function checkAnchors(repoText, bundleText) {
  const anchors = parseAnchors(repoText);
  if (anchors.length === 0) throw new Error("no bundle-anchor lines in repo file");
  if (!bundleText || !bundleText.trim()) throw new Error("live bundle is empty");
  return { anchors, missing: anchors.filter((a) => !bundleText.includes(a)) };
}

async function fetchBundle() {
  const { PAPERCLIP_API_URL: url, PAPERCLIP_API_KEY: key } = process.env;
  if (!url || !key) throw new Error("--bundle not given and PAPERCLIP_API_URL/KEY unset");
  const res = await fetch(
    `${url}/api/agents/${ALLY_AGENT_ID}/instructions-bundle/file?path=AGENTS.md`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`bundle fetch HTTP ${res.status}`);
  return (await res.json()).content;
}

async function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const here = dirname(fileURLToPath(import.meta.url));
  const repoText = readFileSync(arg("--repo") ?? join(here, "../.planning/ally-agent/AGENTS.md"), "utf8");
  const bundlePath = arg("--bundle");
  const bundleText = bundlePath ? readFileSync(bundlePath, "utf8") : await fetchBundle();
  const { anchors, missing } = checkAnchors(repoText, bundleText);
  for (const a of missing) console.log(`DIVERGENT\t${a}\tin repo contract, absent from Ally's live bundle`);
  console.log(`${missing.length ? "DIVERGENT" : "CLEAN"}\t${anchors.length - missing.length}/${anchors.length} anchors present`);
  return missing.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.log(`CANNOT-JUDGE\t${err.message}`);
      process.exit(2);
    },
  );
}
