/**
 * BLO-30608 AC3 — backfill the gate re-validation split over the current population.
 *
 * Reports, for every open human-gated row in a company, the three-way split
 * {`still-gated`, `resolved-but-open`, `unverifiable`} plus the measured cost of
 * one full pass (AC5). It never changes an issue's state, status, or blocker
 * edges on either source — BLO-30608 is explicit that the pass reports and an
 * owner decides. (One narrow, non-issue side effect exists on `--source=api`
 * only; it is stated under "approximations" below rather than left implicit.)
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
 * Both also rank oldest-human-clock-first, through the same
 * `orderByHumanSilenceDescending` the production producer uses, *before* the
 * probe budget is applied. Under a cap the ordering decides the finding: probe
 * in query or response order and the reported split measures that order rather
 * than staleness.
 *
 * Where `--source=api` is only an approximation, stated rather than papered over:
 *
 * - **Clock.** The API does not expose `lastHumanTouchAt` (an `issue_comments` /
 *   `activity_log` aggregate), so the API path ranks on `createdAt` alone. It
 *   errs one way: a human-touched row ranks *older* than the sweep would rank
 *   it, so a capped API run can over-probe a recently-tended row — never skip
 *   one the sweep would have reached first.
 * - **Population.** The hidden-row and digest-row exclusions are reproduced from
 *   the fields the API returns; any future server-side predicate the endpoint
 *   does not expose would not be.
 * - **Where the budget lands.** The API path applies the probe budget while
 *   acquiring, because its per-issue approvals call is the only unbounded cost
 *   in the pass; the DB path hands the whole population to `revalidateGates`
 *   and lets the classifier cap it. Either way the rows left unexamined are
 *   reported as `notProbed`, so `population === probed + notProbed` holds on
 *   both sources and a capped run can never read as a complete one.
 * - **Read-only, with one stated exception on this path only.** The pass
 *   changes no issue state, blocker edge, or status on either source. But
 *   `GET /api/issues/:id/interactions` — the only way to read interaction
 *   evidence without database access — first runs
 *   `expireRequestConfirmationsSupersededByHistoricalComments`, so reading it
 *   can expire a confirmation card that a later comment had already superseded.
 *   That is the endpoint's normal behaviour for *any* reader, including the UI,
 *   and it touches no issue field. It is called out because "read-only" is an
 *   acceptance criterion and an unstated write would quietly break it. The
 *   shipping DB path reads `issue_thread_interactions` directly and has no such
 *   effect; use `--source=db` if you need a strictly side-effect-free pass.
 * - **Cost.** Interaction evidence is a second per-issue call, so this path now
 *   costs roughly 2 round trips per probed row rather than 1. The DB path is
 *   unaffected: it batches at 500 rows per query.
 *
 * For a split that *is* the sweep's split, use `--source=db`.
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
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MAX_PROBES,
  revalidateGates,
  type GateEvidenceInput,
  type GateRevalidationReport,
} from "../server/src/services/human-gated-gate-revalidation.js";
import {
  HUMAN_GATED_DIGEST_ORIGIN_KIND,
  orderByHumanSilenceDescending,
} from "../server/src/services/human-gated-ageing.js";

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
  /**
   * Rows inside `population` this pass deliberately acquired *no* evidence for,
   * because the probe budget ran out during acquisition.
   *
   * This exists because `revalidateGates` can only report a row as unexamined
   * if it was handed the row in the first place: its `notProbed` is
   * `inputs.length - classified`. An acquisition that applies the budget itself
   * hands over a pre-trimmed list, so the classifier's `notProbed` is
   * structurally zero and the report would claim a capped sample was the whole
   * queue — understating exactly the backlog this backfill exists to size.
   * Acquisition-side truncation is therefore counted here and added back in
   * {@link main}, so `population === probed + notProbed` holds on both sources.
   */
  omitted: number;
};

/**
 * Round trips one `--source=db` pass costs, for a population of `population`.
 *
 * The DB path runs five *batched* query families plus one unbatched candidate
 * query:
 *
 * - `loadHumanGatedIssues` — 1 candidate `SELECT`, then the two human-clock
 *   aggregates (`latestHumanCommentAt`, `latestHumanActivityAt`);
 * - `loadGateEvidence` — blockers, approvals, and interactions.
 *
 * Each of the five batched families runs once per `chunkSize`-row chunk, so the
 * total is `1 + 5 * ceil(population / chunkSize)` — O(ceil(n/chunk)), not O(n),
 * which is why the probe cap can be raised well past the population without a
 * cost cliff.
 *
 * This is derived rather than stated because a constant cannot be right across
 * the range. A hard-coded `6` is correct only for `1..chunkSize` rows: it
 * *understates* a population that spans two or more chunks (the live 746-row
 * pass costs 11, not 6) and *overstates* an empty one, where `chunk([])` yields
 * no iterations and the candidate query is the only round trip. Both directions
 * corrupt the measured cost this backfill exists to report.
 */
export function dbRoundTrips(population: number, chunkSize: number): number {
  if (!Number.isInteger(population) || population < 0) {
    throw new Error(`population must be a non-negative integer, got ${population}`);
  }
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`chunkSize must be a positive integer, got ${chunkSize}`);
  }
  const BATCHED_QUERY_FAMILIES = 5;
  const CANDIDATE_QUERY = 1;
  return CANDIDATE_QUERY + BATCHED_QUERY_FAMILIES * Math.ceil(population / chunkSize);
}

/** Evidence over the exact code path the weekly sweep runs. */
async function acquireFromDb(companyId: string, now: Date): Promise<Acquisition> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for --source=db");

  const { createDb } = await import("@paperclipai/db");
  const { loadHumanGatedIssues, loadGateEvidence, AGGREGATE_CHUNK_SIZE } = await import(
    "../server/src/services/human-gated-ageing-digest.js"
  );

  const db = createDb(connectionString);
  const candidates = await loadHumanGatedIssues(db, companyId);
  // Rank before the budget lands, exactly as `humanGatedAgeingProducer` does.
  // `loadHumanGatedIssues` orders by `issues.id` — a lock-ordering choice, not
  // an age one — so probing it as returned would spend a capped budget on an
  // arbitrary slice and report a split that measures UUID order rather than
  // staleness.
  const byAgeDescending = orderByHumanSilenceDescending(candidates, now);
  const evidence = await loadGateEvidence(
    db,
    companyId,
    byAgeDescending.map((candidate) => ({
      id: candidate.id,
      identifier: candidate.identifier,
      // Threaded through so an `unverifiable` row can be named by *why* nothing
      // was checkable (BLO-30627 AC2) rather than reported as one opaque bucket.
      status: candidate.status,
    })),
  );
  return {
    evidence,
    calls: dbRoundTrips(candidates.length, AGGREGATE_CHUNK_SIZE),
    population: candidates.length,
    omitted: 0,
  };
}

/** Evidence over the public API, for a reader without database access. */
export async function acquireFromApi(
  companyId: string,
  budget: number | null,
  now: Date,
): Promise<Acquisition> {
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
    createdAt?: string | null;
    hiddenAt?: string | null;
    originKind?: string | null;
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

  // Reproduce `loadHumanGatedIssues`' population predicate, not just its
  // `assigneeUserId IS NOT NULL` clause. It also drops hidden rows and the
  // digest row itself — the latter because the digest is an open issue assigned
  // to a human, so leaving it in makes the report count itself. A population
  // that differs from the sweep's makes every count here incomparable with the
  // sweep's, which is the one thing this script exists to check.
  const humanGated = rows.filter(
    (row) =>
      Boolean(row.assigneeUserId) &&
      !row.hiddenAt &&
      row.originKind !== HUMAN_GATED_DIGEST_ORIGIN_KIND,
  );

  // Rank oldest-human-clock-first before the budget lands, through the same
  // helper the production producer uses. The API does not expose the
  // `lastHumanTouchAt` half of the clock (it is an `issue_comments` /
  // `activity_log` aggregate), so this path ranks on `createdAt` alone. That is
  // a stated approximation, and it errs in one direction only: a row a human
  // touched after creation ranks *older* here than the sweep would rank it, so
  // a capped API run can over-probe a recently-tended row — it can never skip
  // one the sweep would have probed first. Use `--source=db` for a split that
  // is the sweep's split by construction.
  const ranked = orderByHumanSilenceDescending(
    humanGated.map((row) => ({
      id: row.id,
      identifier: row.identifier ?? null,
      title: "",
      status: row.status,
      priority: "medium",
      assigneeUserId: row.assigneeUserId ?? null,
      // Mirror the loader: an unparseable value becomes `""` so it ranks last
      // rather than throwing the pass.
      createdAt: row.createdAt ?? "",
      lastHumanTouchAt: null,
      row,
    })),
    now,
  );
  // Applying the budget *here* rather than handing the whole population to
  // `revalidateGates` is deliberate: the per-issue approvals call below is the
  // only unbounded cost in this pass, and fetching it for rows the classifier
  // would immediately slice off would make `--max-probes` cost the same as an
  // uncapped run. The price is that the classifier can no longer see what it
  // did not receive, so the truncation is counted into `omitted` and added back
  // in `main` — never silently dropped.
  const probed = (budget === null ? ranked : ranked.slice(0, budget)).map(
    (candidate) => candidate.row,
  );

  // Approvals and interactions are both per-issue, so these are the only
  // unbounded-ish costs in the pass and both are bounded by the probe budget
  // rather than by the population. Issued together per row so the added gate
  // kind costs round trips but not wall clock.
  const evidence: GateEvidenceInput[] = [];
  for (const row of probed) {
    const [approvals, interactions] = (await Promise.all([
      getJson(`/api/issues/${row.id}/approvals`),
      getJson(`/api/issues/${row.id}/interactions`),
    ])) as [
      { id: string; type?: string | null; status: string }[],
      { id: string; kind?: string | null; status: string }[],
    ];
    evidence.push({
      issueId: row.id,
      identifier: row.identifier ?? null,
      status: row.status ?? null,
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
      interactions: (Array.isArray(interactions) ? interactions : []).map((interaction) => ({
        interactionId: interaction.id,
        interactionKind: interaction.kind ?? null,
        interactionStatus: interaction.status,
      })),
    });
  }

  return {
    evidence,
    calls,
    population: humanGated.length,
    omitted: humanGated.length - probed.length,
  };
}

export function renderReport(
  report: GateRevalidationReport,
  meta: {
    population: number;
    calls: number;
    elapsedMs: number;
    source: string;
    /**
     * Unexamined rows across *both* truncation points — the classifier's own
     * budget and any the acquisition dropped. Not `report.notProbed`, which
     * sees only the former.
     */
    notProbed: number;
  },
): string {
  const probed =
    report.counts["still-gated"] + report.counts["resolved-but-open"] + report.counts.unverifiable;
  const lines = [
    `# BLO-30608 gate re-validation backfill (source: ${meta.source})`,
    "",
    `Open human-gated population : ${meta.population}`,
    `Probed                      : ${probed}${meta.notProbed > 0 ? ` (${meta.notProbed} beyond the budget)` : ""}`,
    "",
    `still-gated        : ${report.counts["still-gated"]}`,
    `resolved-but-open  : ${report.counts["resolved-but-open"]}`,
    `unverifiable       : ${report.counts.unverifiable}`,
    "",
    "resolved-but-open by who can clear it:",
    `  blocker edge cancelled (never self-clears) : ${report.countsByResolutionKind["blocker-cancelled-edge-stuck"]}`,
    `  every question card withdrawn/expired      : ${report.countsByResolutionKind["interaction-abandoned"]}`,
    `  all blockers done, row never moved         : ${report.countsByResolutionKind["blocker-done-row-not-moved"]}`,
    `  every linked approval decided              : ${report.countsByResolutionKind["approval-decided"]}`,
    `  at least one question card answered        : ${report.countsByResolutionKind["interaction-answered"]}`,
    "",
    "unverifiable by why no gate was checkable:",
    `  status 'blocked' but no blocker edge       : ${report.countsByUnverifiableReason["blocked-status-without-blocker-edge"]}`,
    `  status 'in_review' but no approval card    : ${report.countsByUnverifiableReason["in-review-without-approval-record"]}`,
    `  in progress, gate is outside this system   : ${report.countsByUnverifiableReason["in-progress-no-expressed-gate"]}`,
    `  queued, waiting on attention not a gate    : ${report.countsByUnverifiableReason["awaiting-start"]}`,
    `  status unreadable                          : ${report.countsByUnverifiableReason["status-unreadable"]}`,
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
  // One clock reading for the whole pass: ranking must not shift underneath a
  // long acquisition, or two rows can swap places mid-run.
  const now = new Date(startedAt);
  const acquisition =
    args.source === "db"
      ? await acquireFromDb(args.companyId, now)
      : await acquireFromApi(args.companyId, args.maxProbes, now);
  const report = revalidateGates(acquisition.evidence, { maxProbes: args.maxProbes });
  const elapsedMs = Date.now() - startedAt;
  // Rows can go unexamined at either truncation point — the acquisition's, or
  // the classifier's. Reporting only the classifier's would let a capped API
  // run print a sample as if it were the whole queue. Summing them keeps the
  // invariant `population === probed + notProbed` true on both sources.
  const notProbed = report.notProbed + acquisition.omitted;

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          source: args.source,
          population: acquisition.population,
          counts: report.counts,
          countsByResolutionKind: report.countsByResolutionKind,
          countsByUnverifiableReason: report.countsByUnverifiableReason,
          notProbed,
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
      notProbed,
    }),
  );
}

// Only run when invoked as the entrypoint. Without this guard, importing the
// module to test `acquireFromApi` runs `main`, which exits the process on the
// missing `--company` argument and takes the test runner with it.
const isEntrypoint =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
