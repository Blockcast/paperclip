/**
 * AC5 harness for BLO-30259 — observe one digest end-to-end.
 *
 * Deliberately NOT a mock. It drives, in order:
 *   1. `reconcileRepoReviewState` — the reconciler's real fetch code, against
 *      live GitHub, with the real installation token, writing real rows.
 *   2. `humanGatedDigestTick` — the wired entry point `server/src/index.ts`
 *      schedules, with the default producer set.
 * and prints the resulting durable digest row's body.
 *
 * Only `prReviewStateReconcilerTick`'s token-minting step is bypassed (this pod
 * has no GitHub App private key; it has the installation token `gh` uses).
 *
 * Run:  npx tsx server/src/scripts/blo-30259-observe-digest.ts
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { agents, companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { reconcileRepoReviewState } from "../services/pr-review-state-reconciler.js";
import {
  HUMAN_GATED_DIGEST_ORIGIN_KIND,
  humanGatedDigestOriginId,
  humanGatedDigestTick,
} from "../services/human-gated-ageing-digest.js";

const REPO = process.env.BLO_30259_REPO ?? "Blockcast/onprem-k8s";
const MAX_PRS = Number(process.env.BLO_30259_MAX_PRS ?? "60");
const HUMAN_USER_ID = "user_human_owner";

// The agent runtime's installation token, same one the `gh` wrapper injects.
// Overridable so this can be pointed at any credential rather than assuming the
// pod layout.
const TOKEN_PATH = process.env.BLO_30259_TOKEN_PATH ?? "/paperclip/.secrets/github-token/token";
const token = readFileSync(TOKEN_PATH, "utf8").trim();

const tempDb = await startEmbeddedPostgresTestDatabase("blo-30259-observe-");
const db = createDb(tempDb.connectionString);

try {
  const companyId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "BLO-30259 observation",
    issuePrefix: "OBS",
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: randomUUID(),
    companyId,
    name: "OBS Agent",
    role: "engineer",
    status: "idle",
  });
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: HUMAN_USER_ID,
    status: "active",
    membershipRole: "owner",
  });

  console.log(`\n=== 1. reconciler: live GitHub -> pull_request_review_state (${REPO}) ===`);
  const reconciled = await reconcileRepoReviewState(db, {
    companyId,
    repoFullName: REPO,
    token,
    maxPullRequests: MAX_PRS,
  });
  console.log(JSON.stringify(reconciled, null, 2));

  console.log(`\n=== 2. wired tick: humanGatedDigestTick (DEFAULT_DIGEST_PRODUCERS) ===`);
  const result = await humanGatedDigestTick(db, { companyId });
  console.log(JSON.stringify(result, null, 2));

  const rows = await db
    .select({
      identifier: issues.identifier,
      status: issues.status,
      assigneeUserId: issues.assigneeUserId,
      assigneeAgentId: issues.assigneeAgentId,
      originId: issues.originId,
      description: issues.description,
    })
    .from(issues)
    .where(eq(issues.originKind, HUMAN_GATED_DIGEST_ORIGIN_KIND));
  const mine = rows.filter((row) => row.originId === humanGatedDigestOriginId(companyId));

  console.log(`\n=== 3. the durable digest row ===`);
  for (const row of mine) {
    console.log(
      `identifier=${row.identifier} status=${row.status} assigneeUserId=${row.assigneeUserId} assigneeAgentId=${row.assigneeAgentId}`,
    );
    console.log("---------------- BODY ----------------");
    console.log(row.description);
    console.log("--------------- /BODY ----------------");
  }
} finally {
  await tempDb.cleanup();
}
