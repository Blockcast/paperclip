#!/usr/bin/env node
// Backfill `pull_request` work products so the evidence-gate truth probe can see
// PRs opened before the webhook back-link shipped, or while the webhook was down.
//
// These rows are REFERENCES, not webhook-trusted: the server stamps sourceTrust
// from the calling actor, so the probe still confirms `merged` against GitHub
// (see server/src/services/evidence-truth.ts). That is deliberate — a backfilled
// row must not be able to assert "merged" on its own.
//
// Idempotent on (repo, number). Dry-run by default; pass --apply to write.
//
//   PAPERCLIP_API_URL=... PAPERCLIP_API_KEY=... PAPERCLIP_COMPANY_ID=... \
//     node scripts/ops/backfill-pr-work-products.mjs [--apply]
//
// Requires `gh` authenticated for every repo named in the scanned comments.
// Requires Node >= 22.18: this script imports a .ts module and relies on
// built-in type stripping. On Node 20 it throws ERR_UNKNOWN_FILE_EXTENSION.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// The real thing, not a copy. Node strips the types on import (>=22.18, and
// CI pins 24), and this module has no imports of its own, so a plain .mjs ops
// script can hold the webhook's own link rule without a build step or a
// dependency. An earlier revision inlined a merged copy of the two patterns
// below and silently dropped three of upstream's defenses; see the block over
// `namesIssue`.
import {
  extractHouseReferenceLabeledIdentifiers,
  extractOwningLabeledIdentifiers,
} from "../../server/src/services/paperclip-identifiers.ts";

const API = process.env.PAPERCLIP_API_URL;
const KEY = process.env.PAPERCLIP_API_KEY;
const CID = process.env.PAPERCLIP_COMPANY_ID;
const APPLY = process.argv.includes("--apply");
// Imported by the test for `namesIssue`; only the direct run touches the API.
// The native idiom, not a filename suffix: a wrapper, symlink, or bundled entry
// point would leave the suffix check false, and the else-branch below skips the
// env check, the loop AND the summary — so "the backfill never ran" would exit 0
// with no output, on a script whose result feeds the rollout baseline.
const RUN = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (RUN && (!API || !KEY || !CID)) {
  console.error("set PAPERCLIP_API_URL, PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID");
  process.exit(2);
}

const headers = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const j = async (path, init) => {
  const r = await fetch(`${API}/api${path}`, { ...init, headers });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};

const PR_RE = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\b/g;
const LIMIT = 1000; // ISSUE_LIST_MAX_LIMIT — anything lower halves the headroom and doubles the re-runs

/**
 * Does this PR claim this issue? Mirrors the webhook's link rule: the
 * identifier appears in the PR title, the head branch, or on a labeled owning
 * reference line in the body. Same grammar as the webhook, **unioned rather
 * than ranked** — `resolveOwningPaperclipIdentifiers` is first-tier-wins, so a
 * PR titled BLO-A with `Refs: BLO-B` in the body owns A only, while this
 * answers true for both. Deliberate: a work product asks "is this PR an
 * artifact of this issue", not "which single issue owns this wake", and every
 * tier here is a labeled ownership claim rather than the bare-prose class that
 * was the actual hazard.
 *
 * The body arm DELEGATES to the two upstream extractors rather than copying
 * their patterns, and that is load-bearing. They are two grammars, not one:
 * the closing verbs (`Fixes`/`Closes`/`Resolves`/`Refs`) take an OPTIONAL
 * colon because "Closes BLO-1" is unambiguous, while the house labels
 * (`Issue`/`Paperclip task`/…) REQUIRE one because `Issue` is an ordinary
 * noun that also starts ordinary sentences — "Issue filed a related bug, see
 * BLO-1" claims nothing. Merging them under one optional-colon alternation,
 * as an earlier revision did, links off prose. Delegating also inherits
 * `visibleMarkdownLines` (fenced code and HTML comments declare nothing a
 * reader can see) and the trailing-label split (`Refs: BLO-1; Related:
 * BLO-2` owns only BLO-1) — three defenses the copy silently lacked. Each
 * one made the matcher see MORE, so each ADDED wrong links.
 *
 * The body is NOT scanned as free text. The script's operating condition is
 * issues that currently read `no-linked-pull-request`, so a row it creates is
 * typically the issue's ONLY `pull_request` work product — and the probe
 * aggregates with `every`. One spurious sibling link therefore either denies
 * evidence the issue earned, or (if that wrong PR is merged and Ally-clean)
 * grants both truth shapes vacuously over a single wrong element. Same-fleet
 * siblings quoting each other's identifiers is the normal case here, not an
 * edge.
 *
 * Title and branch stay a bounded case-insensitive match so BLO-123 does not
 * match BLO-1234; they carry no prose to confuse.
 */
export function namesIssue(pr, identifier) {
  if (!identifier) return false;
  const re = new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  if (re.test(`${pr.title ?? ""}\n${pr.headRefName ?? ""}`)) return true;
  const body = pr.body ?? "";
  const want = identifier.toUpperCase();
  return [
    ...extractOwningLabeledIdentifiers(body),
    ...extractHouseReferenceLabeledIdentifiers(body),
  ].some((found) => found.toUpperCase() === want);
}

/** The list route has returned both shapes; neither is worth guessing at 3am. */
const asIssues = (body) => (Array.isArray(body) ? body : (body?.issues ?? []));

/** GitHub PR state -> issueWorkProductStatusSchema (packages/shared/src/validators/work-product.ts). */
export function prStatus(pr) {
  if (pr.state === "MERGED") return "merged";
  // CLOSED before isDraft: a closed draft is abandoned, and `closed` is
  // terminal while `draft` reads as live in-flight work no one will revisit.
  if (pr.state === "CLOSED") return "closed";
  if (pr.isDraft) return "draft";
  return "ready_for_review";
}

let created = 0;
let wouldCreate = 0;
let skipped = 0;
let unrelated = 0;
let failed = 0;
let writeFailed = 0;

if (RUN) {
  for (const status of ["in_review", "blocked", "in_progress"]) {
    const issues = asIssues(await j(`/companies/${CID}/issues?status=${status}&limit=${LIMIT}`));
    // The list caps silently; saying so beats reporting partial coverage as total.
    // Only sound on a key with `company_scope:read`: the route filters the page
    // AFTER applying the cap (routes/issues.ts:8085-8088), so a scoped key turns a
    // truncated page into a short one and this guard never fires.
    if (issues.length >= LIMIT) console.warn(`WARNING: ${status} hit the ${LIMIT} cap — re-run after this pass`);

    for (const issue of issues) {
      const workProducts = await j(`/issues/${issue.id}/work-products`);
      const have = new Set(
        workProducts
          .filter((w) => w.type === "pull_request")
          .map((w) => `${w.metadata?.repoFullName}#${w.metadata?.prNumber}`.toLowerCase()),
      );

      const comments = await j(`/issues/${issue.id}/comments`);
      const refs = new Map();
      for (const c of comments) {
        for (const m of (c.body ?? "").matchAll(PR_RE)) {
          refs.set(`${m[1]}#${m[2]}`.toLowerCase(), { repo: m[1], number: Number(m[2]) });
        }
      }

      for (const [key, ref] of refs) {
        if (have.has(key)) {
          skipped += 1;
          continue;
        }
        let pr;
        try {
          pr = JSON.parse(
            execFileSync(
              "gh",
              ["pr", "view", String(ref.number), "-R", ref.repo, "--json", "title,body,headRefName,url,state,mergedAt,headRefOid,isDraft"],
              { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
            ),
          );
        } catch (err) {
          // A deleted PR, a repo this token cannot read, or a URL in prose that
          // was never a PR. Skip the row rather than abort the whole backfill.
          console.warn(`SKIP ${issue.identifier} <- ${key}: ${String(err).split("\n")[0]}`);
          failed += 1;
          continue;
        }

        // Same rule the webhook uses to link a PR: the PR must NAME this issue in
        // its title, its branch, or on a labeled owning-reference line in the body
        // — a bare prose mention is not ownership. Without this the backfill
        // invents evidence — a dry run over live data proposed
        // `actions/actions-runner-controller#4516` and `safishamsi/graphify#1570`,
        // upstream PRs merely cited in prose, and the truth probe would then read
        // review:ally-clean off the wrong artifact.
        if (!namesIssue(pr, issue.identifier)) {
          console.warn(`UNRELATED ${issue.identifier} <- ${key}: PR does not name the issue`);
          unrelated += 1;
          continue;
        }

        const body = {
          type: "pull_request",
          provider: "github",
          externalId: `${ref.repo}#${ref.number}`,
          title: pr.title,
          url: pr.url,
          status: prStatus(pr),
          metadata: {
            repoFullName: ref.repo,
            prNumber: ref.number,
            headSha: pr.headRefOid,
            merged: pr.state === "MERGED",
            mergedAt: pr.mergedAt ?? null,
            backfilledAt: new Date().toISOString(),
          },
        };

        if (!APPLY) {
          console.log(`DRY-RUN ${issue.identifier} <- ${key} (${body.status})`);
          wouldCreate += 1;
          continue;
        }
        // Log AFTER the write, and count a failure rather than aborting: the
        // script is idempotent on (repo, number), so finishing the pass and
        // printing the summary beats losing the counts for the rows that landed.
        try {
          await j(`/issues/${issue.id}/work-products`, { method: "POST", body: JSON.stringify(body) });
        } catch (err) {
          console.warn(`FAILED ${issue.identifier} <- ${key}: ${String(err).split("\n")[0]}`);
          writeFailed += 1;
          continue;
        }
        console.log(`CREATE ${issue.identifier} <- ${key} (${body.status})`);
        created += 1;
      }
    }
  }
}

if (RUN) {
  console.log(
    `done: created=${created} would-create=${wouldCreate} skipped=${skipped} unrelated=${unrelated} unreadable=${failed} write-failed=${writeFailed} apply=${APPLY}`,
  );
  // Still exit non-zero on a write failure: catching it buys the summary and the
  // remaining rows, it must not turn a partial backfill into a silent success.
  // Braces are load-bearing — this `if` used to be unbraced, which re-parented
  // the module-guard `else` below onto it and printed "no backfill performed"
  // under every clean run, directly beneath the counts the runbook sends the
  // operator to read.
  if (writeFailed > 0) process.exitCode = 1;
} else {
  console.error("not invoked as a script (argv[1] does not match this module); no backfill performed");
}
