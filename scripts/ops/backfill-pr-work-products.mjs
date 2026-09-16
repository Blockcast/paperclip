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
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

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
const LIMIT = 500;

// The body arm accepts ONLY a labeled owning-reference line, mirroring
// OWNING_REFERENCE_LABEL_PATTERN / HOUSE_REFERENCE_LABEL_PATTERN in
// server/src/services/paperclip-identifiers.ts. A bare prose mention is
// deliberately NOT an owning reference (BLO-20886): `Related: BLO-1234` in
// someone else's PR body must not link that PR to this issue.
//
// Deliberately a copy rather than an import: this is a plain .mjs ops script
// and the real helpers are TypeScript source. The copy is narrower than the
// original (no fenced-code or HTML-comment stripping, no trailing-label
// splitting), which fails in the safe direction — it can miss a link, and a
// missed link leaves the issue exactly as the script found it. The original
// defect failed the other way.
const OWNING_LABEL_LINE =
  /^ {0,3}(?:[-*+]|\d{1,3}[.)])?[ \t]*(?:fix(?:e[sd])?|clos(?:e[sd]?)|resolv(?:e[sd]?)|refs?|paperclip[ \t]+qa[ \t]+task|paperclip[ \t]+task|paperclip[ \t]+issue|issue)[ \t]*:?[ \t]+(.+)$/i;

/**
 * Does this PR claim this issue? Mirrors the webhook's link rule: the
 * identifier appears in the PR title, the head branch, or on a labeled owning
 * reference line in the body. Case-insensitive, bounded so BLO-123 does not
 * match BLO-1234.
 *
 * The body is NOT scanned as free text. The script's operating condition is
 * issues that currently read `no-linked-pull-request`, so a row it creates is
 * typically the issue's ONLY `pull_request` work product — and the probe
 * aggregates with `every`. One spurious sibling link therefore either denies
 * evidence the issue earned, or (if that wrong PR is merged and Ally-clean)
 * grants both truth shapes vacuously over a single wrong element. Same-fleet
 * siblings quoting each other's identifiers is the normal case here, not an
 * edge.
 */
export function namesIssue(pr, identifier) {
  if (!identifier) return false;
  const re = new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  if (re.test(`${pr.title ?? ""}\n${pr.headRefName ?? ""}`)) return true;
  return (pr.body ?? "")
    .split(/\r?\n/)
    .some((line) => {
      const rest = line.match(OWNING_LABEL_LINE)?.[1];
      return rest ? re.test(rest) : false;
    });
}

/** The list route has returned both shapes; neither is worth guessing at 3am. */
const asIssues = (body) => (Array.isArray(body) ? body : (body?.issues ?? []));

/** GitHub PR state -> issueWorkProductStatusSchema (packages/shared/src/validators/work-product.ts). */
export function prStatus(pr) {
  if (pr.state === "MERGED") return "merged";
  if (pr.isDraft) return "draft";
  if (pr.state === "CLOSED") return "closed";
  return "ready_for_review";
}

let created = 0;
let skipped = 0;
let unrelated = 0;
let failed = 0;

if (RUN) for (const status of ["in_review", "blocked", "in_progress"]) {
  const issues = asIssues(await j(`/companies/${CID}/issues?status=${status}&limit=${LIMIT}`));
  // The list caps silently; saying so beats reporting partial coverage as total.
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

      console.log(`${APPLY ? "CREATE" : "DRY-RUN"} ${issue.identifier} <- ${key} (${body.status})`);
      if (APPLY) {
        await j(`/issues/${issue.id}/work-products`, { method: "POST", body: JSON.stringify(body) });
        created += 1;
      }
    }
  }
}

if (RUN) console.log(`done: created=${created} skipped=${skipped} unrelated=${unrelated} unreadable=${failed} apply=${APPLY}`);
else console.error("not invoked as a script (argv[1] does not match this module); no backfill performed");
