/**
 * BLO-29420 AC4 — observe the digest end-to-end on a controlled instance.
 *
 * Deliberately goes through `startHumanGatedDigestSweep` — the exact function
 * `server/src/index.ts` calls behind the config flag — rather than the pure
 * `selectAgedHumanGatedIssues`. Calling the pure function is what CI has been
 * doing since 2026-08-10 while the escalation never fired.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  issueComments,
  issues,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { loadConfig } from "../server/src/config.js";
import {
  HUMAN_GATED_DIGEST_ORIGIN_KIND,
  startHumanGatedDigestSweep,
} from "../server/src/services/human-gated-ageing-digest.js";

const NOW = new Date();
const OWNER_USER_ID = "user_dev_owner";
const day = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * day);

const tempDb = await startEmbeddedPostgresTestDatabase("blo-29420-ac4-");
const db = createDb(tempDb.connectionString);

const companyId = randomUUID();
const agentId = randomUUID();

await db.insert(companies).values({
  id: companyId,
  name: "Dev Instance",
  issuePrefix: "DEV",
  requireBoardApprovalForNewAgents: false,
});
await db.insert(agents).values({
  id: agentId,
  companyId,
  name: "Dev Agent",
  role: "engineer",
  status: "idle",
});
await db.insert(companyMemberships).values({
  companyId,
  principalType: "user",
  principalId: OWNER_USER_ID,
  status: "active",
  membershipRole: "owner",
});

let issueNumber = 900;
async function seed(input: {
  identifier: string;
  title: string;
  status: string;
  priority: string;
  ageDays: number;
  humanTouchDaysAgo?: number;
  agentCommentDaysAgo?: number;
}) {
  const id = randomUUID();
  issueNumber += 1;
  await db.insert(issues).values({
    id,
    companyId,
    issueNumber,
    identifier: input.identifier,
    title: input.title,
    status: input.status,
    priority: input.priority,
    assigneeUserId: OWNER_USER_ID,
    originKind: "manual",
    originFingerprint: "default",
    createdAt: daysAgo(input.ageDays),
  });
  if (input.humanTouchDaysAgo !== undefined) {
    await db.insert(issueComments).values({
      companyId,
      issueId: id,
      body: "human comment",
      authorType: "user",
      authorUserId: OWNER_USER_ID,
      createdAt: daysAgo(input.humanTouchDaysAgo),
    });
  }
  if (input.agentCommentDaysAgo !== undefined) {
    // The move the escalation must survive: an agent commenting today.
    await db.insert(issueComments).values({
      companyId,
      issueId: id,
      body: "agent status update",
      authorType: "agent",
      authorAgentId: agentId,
      createdAt: daysAgo(input.agentCommentDaysAgo),
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: id,
      createdAt: daysAgo(input.agentCommentDaysAgo),
    });
  }
  return id;
}

await seed({
  identifier: "DEV-101",
  title: "Approve the Q3 vendor contract",
  status: "in_review",
  priority: "critical",
  ageDays: 63,
});
await seed({
  identifier: "DEV-102",
  title: "Sign off on the new on-call rotation",
  status: "in_review",
  priority: "high",
  ageDays: 41,
  // Agent commented 6 hours ago and bumped activity — must NOT silence it.
  agentCommentDaysAgo: 0.25,
});
await seed({
  identifier: "DEV-103",
  title: "Decide whether to renew the Datadog plan",
  status: "todo",
  priority: "medium",
  ageDays: 37,
});
await seed({
  identifier: "DEV-104",
  title: "Recently answered by a human — must not appear",
  status: "in_review",
  priority: "critical",
  ageDays: 90,
  humanTouchDaysAgo: 2,
});

console.log("=== config (flag path index.ts gates on) ===");
const config = loadConfig();
console.log("humanGatedDigestEnabled     :", config.humanGatedDigestEnabled);
console.log("humanGatedDigestIntervalMin :", config.humanGatedDigestIntervalMinutes);
console.log("humanGatedDigestPeriodDays  :", config.humanGatedDigestPeriodDays);
console.log("paperclipNodeRole           :", config.paperclipNodeRole);

if (!(config.humanGatedDigestEnabled && config.paperclipNodeRole !== "api")) {
  throw new Error("config gate closed; index.ts would not start the sweep");
}

console.log("\n=== starting the sweep exactly as server/src/index.ts does ===");
const stop = startHumanGatedDigestSweep(db, config.humanGatedDigestIntervalMinutes * 60 * 1000, {
  periodDays: config.humanGatedDigestPeriodDays,
});

// The start function kicks off one tick immediately; give it time to land.
await new Promise((resolve) => setTimeout(resolve, 4000));
stop();

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

console.log(`\n=== digest rows produced by the wired tick: ${rows.length} ===`);
for (const row of rows) {
  console.log("identifier     :", row.identifier);
  console.log("status         :", row.status);
  console.log("assigneeUserId :", row.assigneeUserId);
  console.log("assigneeAgentId:", row.assigneeAgentId);
  console.log("originId       :", row.originId);
  console.log("\n----- description -----\n");
  console.log(row.description);
  console.log("\n----- end description -----");
}

await tempDb.cleanup();
