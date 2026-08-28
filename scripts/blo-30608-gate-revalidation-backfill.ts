/**
 * BLO-30608 AC3 — backfill the gate re-validation split over the current population.
 *
 * Reports, for every open human-gated row in a company, the three-way split
 * {`still-gated`, `resolved-but-open`, `unverifiable`} plus the measured cost of
 * one full pass (AC5). It is **read-only** on both evidence sources: no write
 * path exists here and none is wanted — BLO-30608 is explicit that the pass
 * reports and an owner decides.
 *
 * Two evidence sources, one classifier:
 *
 * - `--source=db` (default) — uses `loadHumanGatedIssues` + `loadGateEvidence`,
 *   i.e. the exact code path the weekly sweep runs. Its numbers are the sweep's
 *   numbers by construction. Needs `DATABASE_URL`.
 * - `--source=api` — reads the same evidence over the public API
 *   (`PAPERCLIP_API_URL` + `PAPERCLIP_API_KEY`), so an agent holding ordinary
 *   credentials can reproduce the split without database access.
 *
 * Both feed the *same* `revalidateGates`, so only evidence acquisition differs
 * and a verdict cannot depend on which source produced it. That is the point of
 * offering both: the API path is auditable by whoever is reading the report,
 * and the DB path is the one that ships.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/blo-30608-gate-revalidation-backfill.ts --company <uuid>
 *   npx tsx scripts/blo-30608-gate-revalidation-backfill.ts --source=api --company <uuid>
 *
 *   --max-probes N   probe budget (default: the module's DEFAULT_MAX_PROBES)
 *   --max-probes 0   with `--all`, opt out of the cap entirely
 *   --all            equivalent to an uncapped pass; use to size the whole queue
 *   --json           emit machine-readable output instead of the text report
 */
import {
  DEFAULT_MAX_PROBES,
  revalidateGates,
  type GateEvidenceInput,
  type GateRevalidationReport,
} from "../server/src/services/human-gated-gate-revalidation.js";

const OPEN_STATUSES = ["todo", "backlog", "in_progress", "in_review", "blocked"] as const;

type Args = {
  companyId: string;
  source: "db" | "api";
  maxProbes: number | null;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
    if (inline) return inline.slice(flag.length + 1);
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const companyId = get("--company") ?? process.env.PAPERCLIP_COMPANY_ID;
  if (!companyId) throw new Error("--company <uuid> (or PAPERCLIP_COMPANY_ID) is required");

  const source = (get("--source") ?? "db") as "db" | "api";
  if (source !== "db" && source !== "api") {
    throw new Error(`--source must be 'db' or 'api', received ${source}`);
  }

  const all = argv.includes("--all");
  const rawMax = get("--max-probes");
  // `--all` is the explicit opt-out. A bare `--max-probes 0` is honoured as a
  // real budget of zero rather than silently reinterpreted as "no cap": a flag
  // that means its opposite is how an unbounded pass happens by accident.
  const maxProbes = all ? null : rawMax === undefined ? DEFAULT_MAX_PROBES : Number(rawMax);
  if (maxProbes !== null && (!Number.isInteger(maxProbes) || maxProbes < 0)) {
    throw new Error(`--max-probes must be a non-negative integer, received ${String(rawMax)}`);
  }

  return { companyId, source, maxProbes, json: argv.includes("--json") };
}

type Acquisition = {
  evidence: GateEvidenceInput[];
  /** Round trips spent acquiring evidence — the AC5 cost figure. */
  calls: number;
  /** Open human-gated rows found, before the probe budget is applied. */
  population: number;
};

/** Evidence over the exact code path the weekly sweep runs. */
async function acquireFromDb(companyId: string): Promise<Acquisition> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for --source=db");

  const { createDb } = await import("@paperclipai/db");
  const { loadHumanGatedIssues, loadGateEvidence } = await import(
    "../server/src/services/human-gated-ageing-digest.js"
  );

  const db = createDb(connectionString);
  const candidates = await loadHumanGatedIssues(db, companyId);
  const evidence = await loadGateEvidence(
    db,
    companyId,
    candidates.map((candidate) => ({ id: candidate.id, identifier: candidate.identifier })),
  );
  // 1 candidate query + 2 human-clock aggregates + 2 evidence queries.
  return { evidence, calls: 5, population: candidates.length };
}

/** Evidence over the public API, for a reader without database access. */
async function acquireFromApi(companyId: string, budget: number | null): Promise<Acquisition> {
  const base = process.env.PAPERCLIP_API_URL;
  const key = process.env.PAPERCLIP_API_KEY;
  if (!base || !key) {
    throw new Error("PAPERCLIP_API_URL and PAPERCLIP_API_KEY are required for --source=api");
  }
  const headers = { Authorization: `Bearer ${key}` };
  let calls = 0;

  async function getJson(path: string): Promise<unknown> {
    calls += 1;
    const response = await fetch(`${base}${path}`, { headers });
    if (!response.ok) {
      throw new Error(`GET ${path} -> ${response.status} ${await response.text()}`);
    }
    return response.json();
  }

  type ApiIssue = {
    id: string;
    identifier?: string | null;
    status: string;
    assigneeUserId?: string | null;
    blockedBy?: { id: string; identifier?: string | null; status: string }[];
  };

  const rows: ApiIssue[] = [];
  for (const status of OPEN_STATUSES) {
    // Page rather than trusting one unbounded response: the endpoint caps its
    // page size, and a silently truncated population would understate every
    // count in this report.
    for (let offset = 0; ; offset += 200) {
      const page = (await getJson(
        `/api/companies/${companyId}/issues?status=${status}&includeBlockedBy=true&limit=200&offset=${offset}`,
      )) as ApiIssue[];
      rows.push(...page);
      if (page.length < 200) break;
    }
  }

  const humanGated = rows.filter((row) => Boolean(row.assigneeUserId));
  const probed = budget === null ? humanGated : humanGated.slice(0, budget);

  // Approvals are per-issue, so this is the only unbounded-ish cost in the pass
  // and it is bounded by the probe budget rather than by the population.
  const evidence: GateEvidenceInput[] = [];
  for (const row of probed) {
    const approvals = (await getJson(`/api/issues/${row.id}/approvals`)) as {
      id: string;
      type?: string | null;
      status: string;
    }[];
    evidence.push({
      issueId: row.id,
      identifier: row.identifier ?? null,
      blockers: (row.blockedBy ?? []).map((blocker) => ({
        blockerIssueId: blocker.id,
        blockerIdentifier: blocker.identifier ?? null,
        blockerStatus: blocker.status,
      })),
      approvals: (Array.isArray(approvals) ? approvals : []).map((approval) => ({
        approvalId: approval.id,
        approvalType: approval.type ?? null,
        approvalStatus: approval.status,
      })),
    });
  }

  return { evidence, calls, population: humanGated.length };
}

function renderReport(
  report: GateRevalidationReport,
  meta: { population: number; calls: number; elapsedMs: number; source: string },
): string {
  const probed =
    report.counts["still-gated"] + report.counts["resolved-but-open"] + report.counts.unverifiable;
  const lines = [
    `# BLO-30608 gate re-validation backfill (source: ${meta.source})`,
    "",
    `Open human-gated population : ${meta.population}`,
    `Probed                      : ${probed}${report.notProbed > 0 ? ` (${report.notProbed} beyond the budget)` : ""}`,
    "",
    `still-gated        : ${report.counts["still-gated"]}`,
    `resolved-but-open  : ${report.counts["resolved-but-open"]}`,
    `unverifiable       : ${report.counts.unverifiable}`,
    "",
    "resolved-but-open by who can clear it:",
    `  blocker edge cancelled (never self-clears) : ${report.countsByResolutionKind["blocker-cancelled-edge-stuck"]}`,
    `  all blockers done, row never moved         : ${report.countsByResolutionKind["blocker-done-row-not-moved"]}`,
    `  every linked approval decided              : ${report.countsByResolutionKind["approval-decided"]}`,
    "",
    `Cost: ${meta.calls} round trips, ${(meta.elapsedMs / 1000).toFixed(1)}s wall clock.`,
    "",
    "Read-only: no issue state, blocker edge, or status was changed by this pass.",
  ];

  const resolved = report.classifications.filter((c) => c.verdict === "resolved-but-open");
  if (resolved.length > 0) {
    lines.push("", "## resolved-but-open rows", "");
    for (const classification of resolved) {
      lines.push(`- ${classification.identifier ?? classification.issueId} — ${classification.evidence}`);
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const acquisition =
    args.source === "db"
      ? await acquireFromDb(args.companyId)
      : await acquireFromApi(args.companyId, args.maxProbes);
  const report = revalidateGates(acquisition.evidence, { maxProbes: args.maxProbes });
  const elapsedMs = Date.now() - startedAt;

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          source: args.source,
          population: acquisition.population,
          counts: report.counts,
          countsByResolutionKind: report.countsByResolutionKind,
          notProbed: report.notProbed,
          calls: acquisition.calls,
          elapsedMs,
          classifications: report.classifications,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    renderReport(report, {
      population: acquisition.population,
      calls: acquisition.calls,
      elapsedMs,
      source: args.source,
    }),
  );
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
