// Identifier allocator — central choice point for who mints a new issue's
// identifier. Task 2.1 of the Linear ↔ Paperclip ID Unification plan
// (onprem-k8s commit 9979d0d / .planning/linear-id-unification.md).
//
// Today: every company gets the paperclip-internal `${issuePrefix}-${counter}`
// path, which is the existing behaviour pulled verbatim out of
// services/issues.ts so it's testable and so the linear branch has a place
// to land in Task 2.2 without re-touching the issue creation tx.
//
// The function deliberately accepts a transaction-or-db handle (Drizzle's
// `tx` shares the `Db` shape during `db.transaction(...)`) because the
// paperclip path's counter increment must run inside the same tx as the
// `issues` insert — otherwise two concurrent creators race on
// `issue_counter` and produce a duplicate identifier despite the
// self-correcting `greatest(issueCounter, currentMax) + 1`.
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, issues, pluginCompanySettings, plugins } from "@paperclipai/db";
import { secretService } from "./secrets.js";

// Structural subset of `Db` that the allocator actually uses. Same pattern
// as `GoalReader` in services/goals.ts — accepts either the root client or
// an active tx (Drizzle's tx handle structurally satisfies this Pick).
type IdentifierAllocatorDb = Pick<Db, "select" | "update">;

const LINEAR_PLUGIN_KEY = "paperclip-plugin-linear";
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

export interface AllocateIdentifierInput {
  /** Drizzle handle. Pass the active transaction when called from inside one. */
  db: IdentifierAllocatorDb;
  companyId: string;
  /** Title is plumbed through for the Linear path (Task 2.2) which posts it
   *  to Linear's IssueCreate mutation. The paperclip path ignores it. */
  title: string;
  description?: string | null;
}

export interface AllocateIdentifierResult {
  /** The minted identifier (e.g. "BLO-2667" or "PCL-12"). */
  identifier: string;
  /** Bookkeeping: the integer suffix, used to populate issues.issueNumber. */
  issueNumber: number;
  /** Which provider issued the identifier. Determines downstream link rows. */
  source: "paperclip" | "linear";
  /** Linear-side issue id, when source === "linear". */
  externalIssueId?: string;
}

export async function allocateIdentifier(
  input: AllocateIdentifierInput,
): Promise<AllocateIdentifierResult> {
  const { db, companyId } = input;

  const company = await db
    .select({ provider: companies.identifierProvider })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0]);

  if (company?.provider === "linear") {
    return allocateFromLinear(input);
  }
  return allocateFromPaperclip(input);
}

// Pulled verbatim from services/issues.ts (the previous inline block).
// Kept transactional: the caller MUST pass the active tx as `input.db` when
// inside an issue-creation transaction, otherwise concurrent creators race
// on `companies.issue_counter`.
async function allocateFromPaperclip(
  input: AllocateIdentifierInput,
): Promise<AllocateIdentifierResult> {
  const { db, companyId } = input;

  // Self-correcting counter: use MAX(issue_number) + 1 if the counter has
  // drifted below the actual max. Defends against historical data imports
  // that leave issueCounter stale relative to the issues table.
  const [maxRow] = await db
    .select({ maxNum: sql<number>`coalesce(max(${issues.issueNumber}), 0)` })
    .from(issues)
    .where(eq(issues.companyId, companyId));
  const currentMax = maxRow?.maxNum ?? 0;

  const [company] = await db
    .update(companies)
    .set({
      issueCounter: sql`greatest(${companies.issueCounter}, ${currentMax}) + 1`,
    })
    .where(eq(companies.id, companyId))
    .returning({ issueCounter: companies.issueCounter, issuePrefix: companies.issuePrefix });

  const issueNumber = company.issueCounter;
  const identifier = `${company.issuePrefix}-${issueNumber}`;

  return { identifier, issueNumber, source: "paperclip" };
}

// Linear path: read the linear plugin's per-company config, resolve the API
// key from the company-secret pointer (linearTokenRef), then call Linear's
// IssueCreate GraphQL mutation. Returns the Linear-issued identifier + the
// internal Linear issue id, both of which the caller persists into a
// linear_issue_links row after the issues row is inserted.
//
// The HTTP call runs inside whatever ctx the caller provides — typically the
// open db.transaction(...) from services/issues.ts. At low write rates this
// is fine; at higher write rates the tx holds the row lock for the duration
// of the Linear roundtrip and contention can grow. If that becomes a
// problem, hoist this call out of the tx in the caller.
async function allocateFromLinear(
  input: AllocateIdentifierInput,
): Promise<AllocateIdentifierResult> {
  const { db, companyId, title, description } = input;
  const cfg = await getLinearConfigForCompany(db, companyId);
  const created = await createLinearIssue({
    apiKey: cfg.apiKey,
    teamId: cfg.teamId,
    title,
    description: description ?? undefined,
  });
  // Linear identifier is "TEAM-N"; extract the numeric suffix so the issues
  // row's issue_number column stays meaningful (and so existing reports that
  // group by issue_number keep working).
  const numMatch = /-(\d+)$/.exec(created.identifier);
  if (!numMatch) {
    throw new Error(`Unexpected Linear identifier format: ${created.identifier}`);
  }
  return {
    identifier: created.identifier,
    issueNumber: Number.parseInt(numMatch[1], 10),
    source: "linear",
    externalIssueId: created.id,
  };
}

interface LinearConfig {
  apiKey: string;
  teamId: string;
}

async function getLinearConfigForCompany(
  db: IdentifierAllocatorDb,
  companyId: string,
): Promise<LinearConfig> {
  const [plugin] = await db
    .select({ id: plugins.id })
    .from(plugins)
    .where(eq(plugins.pluginKey, LINEAR_PLUGIN_KEY));
  if (!plugin) {
    throw new Error(
      `${LINEAR_PLUGIN_KEY} is not installed; cannot allocate Linear-issued identifiers`,
    );
  }

  const [settings] = await db
    .select({ json: pluginCompanySettings.settingsJson })
    .from(pluginCompanySettings)
    .where(
      and(
        eq(pluginCompanySettings.pluginId, plugin.id),
        eq(pluginCompanySettings.companyId, companyId),
      ),
    );
  if (!settings) {
    throw new Error(
      `${LINEAR_PLUGIN_KEY} is not configured for company ${companyId}; ` +
        `set teamId + linearTokenRef in the plugin UI before flipping ` +
        `companies.identifier_provider to 'linear'`,
    );
  }

  const json = settings.json as Record<string, unknown>;
  const teamId = typeof json.teamId === "string" ? json.teamId : null;
  const linearTokenRef = typeof json.linearTokenRef === "string" ? json.linearTokenRef : null;
  if (!teamId) {
    throw new Error(
      `${LINEAR_PLUGIN_KEY} settings for company ${companyId} are missing teamId`,
    );
  }
  if (!linearTokenRef) {
    throw new Error(
      `${LINEAR_PLUGIN_KEY} settings for company ${companyId} are missing linearTokenRef ` +
        `(OAuth-only configurations are not yet supported on the server-side identifier path)`,
    );
  }

  // The `db` parameter is a Pick<Db, "select" | "update">, but secretService
  // wants the full Db type. The cast is safe at runtime because Drizzle's tx
  // is structurally compatible — secretService only uses select/insert which
  // tx handles too. If a stricter signature on secretService is added later,
  // re-thread accordingly.
  const apiKey = await secretService(db as Db).resolveSecretValue(
    companyId,
    linearTokenRef,
    "latest",
  );
  return { apiKey, teamId };
}

interface CreatedLinearIssue {
  id: string;
  identifier: string;
  url: string;
}

async function createLinearIssue(params: {
  apiKey: string;
  teamId: string;
  title: string;
  description?: string;
}): Promise<CreatedLinearIssue> {
  const { apiKey, teamId, title, description } = params;
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      // Linear PATs are passed as the bare token (no "Bearer " prefix).
      // Mirrors the existing pattern in server/src/linear-tunnel.ts.
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `
        mutation IssueCreate($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue { id identifier url }
          }
        }
      `,
      variables: {
        input: {
          teamId,
          title,
          ...(description ? { description } : {}),
        },
      },
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Linear IssueCreate HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  const json = (await response.json()) as {
    errors?: unknown[];
    data?: { issueCreate?: { success?: boolean; issue?: CreatedLinearIssue | null } };
  };
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    throw new Error(`Linear IssueCreate GraphQL errors: ${JSON.stringify(json.errors).slice(0, 500)}`);
  }
  const issue = json.data?.issueCreate?.issue;
  if (!json.data?.issueCreate?.success || !issue) {
    throw new Error(`Linear IssueCreate did not return an issue (success=false or null)`);
  }
  return issue;
}
