import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  claimPendingAggregateResolutions,
  completeAggregateReopen,
  completeAggregateResolution,
  listAggregateReopenWork,
  releaseAggregateResolution,
  type AggregateReopenWork,
  type AggregateResolutionWork,
} from "./aggregate-store.js";
import { recordSourceResolvedAndCloseCovers } from "./escalation.js";
import type { AlertmanagerPluginConfig } from "./types.js";

export async function applyAggregateResolution(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  work: AggregateResolutionWork,
): Promise<"completed" | "firing" | "failed" | "superseded"> {
  const issueId = work.paperclipIssueId;
  if (!issueId) return "superseded";
  try {
    if (config.autoCloseOnResolve !== false) {
      const issue = await ctx.issues.get(issueId, work.companyId);
      if (issue && issue.status !== "done" && issue.status !== "cancelled") {
        await ctx.issues.update(issueId, { status: "cancelled" }, work.companyId);
      }
    } else {
      await ensureComment(
        ctx,
        work.companyId,
        issueId,
        `Alert resolved at ${work.resolvedAt}.`,
      );
    }
  } catch (err) {
    await releaseAggregateResolution(
      ctx,
      work.companyId,
      work.aggregateKey,
      work.claim,
    );
    ctx.logger.warn(`Failed to apply resolution to issue ${issueId}: ${String(err)}`);
    return "failed";
  }

  const completion = await completeAggregateResolution(
    ctx,
    work.companyId,
    work.aggregateKey,
    work.claim,
    work.resolvedAt,
  );
  if (completion === "firing") {
    await repairAggregateReopen(ctx, config, work, work.claim);
    return completion;
  }
  if (completion === "completed") {
    try {
      await recordSourceResolvedAndCloseCovers(ctx, work.companyId, issueId);
    } catch (err) {
      ctx.logger.warn(
        `Failed to record resolution against escalation covers for issue ${issueId}: ${String(err)}`,
      );
    }
    ctx.logger.info(`Alertmanager: final resolution for aggregate ${work.aggregateKey}`);
    await ctx.metrics.write("alertmanager.aggregate.final_resolved", 1, {
      alertname: work.alertname,
      severity: work.severity,
    });
  }
  return completion;
}

async function repairAggregateReopen(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  work: AggregateReopenWork,
  claim?: string,
): Promise<void> {
  const issueId = work.paperclipIssueId;
  if (!issueId) return;
  if (config.autoCloseOnResolve !== false) {
    const issue = await ctx.issues.get(issueId, work.companyId);
    if (issue && (issue.status === "done" || issue.status === "cancelled")) {
      await ctx.issues.update(issueId, { status: "todo" }, work.companyId);
    }
  } else {
    await ensureComment(
      ctx,
      work.companyId,
      issueId,
      "Alert is firing again; the prior aggregate-resolution comment is no longer current.",
    );
  }
  await completeAggregateReopen(ctx, work.companyId, work.aggregateKey, claim);
  ctx.logger.info(`Alertmanager: repaired re-fire for aggregate ${work.aggregateKey}`);
}

async function ensureComment(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  body: string,
): Promise<void> {
  const comments = await ctx.issues.listComments(issueId, companyId);
  if (comments.some((comment) => comment.body === body)) return;
  await ctx.issues.createComment(issueId, body, companyId);
}

export async function reconcileAggregateLifecycle(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
): Promise<void> {
  const companyId = config.defaultCompanyId;
  if (!companyId) return;
  for (const work of await listAggregateReopenWork(ctx, companyId)) {
    try {
      await repairAggregateReopen(
        ctx,
        config,
        work,
        work.resolutionClaim ?? undefined,
      );
    } catch (err) {
      ctx.logger.warn(
        `Alertmanager: failed to repair aggregate ${work.aggregateKey}: ${String(err)}`,
      );
    }
  }
  for (const work of await claimPendingAggregateResolutions(ctx, companyId)) {
    await applyAggregateResolution(ctx, config, work);
  }
}
