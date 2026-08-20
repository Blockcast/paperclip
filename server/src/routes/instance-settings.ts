import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import {
  issueGraphLivenessAutoRecoveryRequestSchema,
  patchInstanceSettingsSchema,
  patchInstanceExperimentalSettingsSchema,
  patchInstanceGeneralSettingsSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import {
  auditHookCommands,
  describeHookCommandFinding,
  LIFECYCLE_HOOK_COMMAND_SETTINGS,
  LIFECYCLE_HOOK_COMMAND_UNRESOLVED_ACTION,
  type HookCommandAuditFinding,
} from "../services/lifecycle-hook-command-audit.js";
import {
  companyService,
  heartbeatService,
  instanceSettingsService,
  logActivity,
} from "../services/index.js";
import { environmentService } from "../services/environments.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";
import { assertBoardOrgAccess, getActorInfo } from "./authz.js";

function assertCanManageInstanceSettings(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

/**
 * Audit the lifecycle hook commands carried by a general-settings PATCH for
 * absolute script paths that do not exist (BLO-28782).
 *
 * Advisory, never a gate. `existsSync` here runs on the pod serving the PATCH,
 * which is not the pod that later spawns the hook. That is decidable for paths
 * baked into the image — same image on both tiers — but a path on a **mounted
 * volume** is per-pod: `bash /paperclip/scripts/relogin.sh` on a volume mounted
 * into workers but not the API tier is unresolvable from here while being
 * perfectly runnable where it actually fires. Rejecting that write would lock an
 * operator out of a valid configuration with no override, and `preRunCmd` /
 * `postRunCmd` are not exposed in the settings UI at all — they are set through
 * exactly the ops path most likely to reference volume-mounted scripts.
 *
 * That undecidability is the same reason the boot audit is deliberately
 * non-fatal, and it applies with more force here, where the consequence would be
 * refusing the write rather than logging. So the write path matches the boot
 * path: never block, always surface. Findings are returned to the caller and
 * recorded under `instance.lifecycle_hook_command_unresolved` — the activity
 * action an operator already queries to see hook failures.
 *
 * Only keys present in the patch are audited, so an unrelated PATCH is never
 * annotated with pre-existing drift — that case is the boot audit's job.
 */
function auditPatchedHookCommands(patch: Record<string, unknown>): HookCommandAuditFinding[] {
  const patched = LIFECYCLE_HOOK_COMMAND_SETTINGS.filter((setting) =>
    Object.prototype.hasOwnProperty.call(patch, setting),
  );
  if (patched.length === 0) return [];

  return auditHookCommands({
    preRunCmd: null,
    postRunCmd: null,
    quotaExhaustedCmd: null,
    ...Object.fromEntries(
      patched.map((setting) => [
        setting,
        typeof patch[setting] === "string" ? (patch[setting] as string) : null,
      ]),
    ),
  });
}

export function instanceSettingsRoutes(db: Db) {
  const router = Router();
  const svc = instanceSettingsService(db);
  const environments = environmentService(db);
  const heartbeat = heartbeatService(db);

  router.get("/instance/settings", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await svc.get());
  });

  router.patch(
    "/instance/settings",
    validate(patchInstanceSettingsSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      if (Object.prototype.hasOwnProperty.call(req.body, "defaultEnvironmentId")) {
        await assertEnvironmentSelectionForCompany(
          environments,
          "instance",
          typeof req.body.defaultEnvironmentId === "string" ? req.body.defaultEnvironmentId : null,
        );
      }
      const updated = await svc.update(req.body);
      const actor = getActorInfo(req);
      const companyIds = await svc.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            agentApiKeyId: actor.agentApiKeyId,
            action: "instance.settings.updated",
            entityType: "instance_settings",
            entityId: updated.id,
            details: {
              defaultEnvironmentId: updated.defaultEnvironmentId,
              changedKeys: Object.keys(req.body).sort(),
            },
          }),
        ),
      );
      res.json(updated);
    },
  );

  router.get("/instance/settings/general", async (req, res) => {
    // General settings (e.g. keyboardShortcuts) are readable by any
    // authenticated org member or instance admin. Only PATCH requires instance-admin.
    assertBoardOrgAccess(req);
    res.json(await svc.getGeneral());
  });

  router.patch(
    "/instance/settings/general",
    validate(patchInstanceGeneralSettingsSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const hookFindings = auditPatchedHookCommands(req.body);
      const updated = await svc.updateGeneral(req.body);
      const actor = getActorInfo(req);
      const companyIds = await svc.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            agentApiKeyId: actor.agentApiKeyId,
            action: "instance.settings.general_updated",
            entityType: "instance_settings",
            entityId: updated.id,
            details: {
              general: updated.general,
              changedKeys: Object.keys(req.body).sort(),
            },
          }),
        ),
      );
      if (hookFindings.length > 0) {
        // Advisory only: the write already landed, so a failure to record the
        // warning must not turn a successful save into a 500 the operator reads
        // as "it did not save".
        try {
          await Promise.all(
            companyIds.flatMap((companyId) =>
              hookFindings.map((finding) =>
                logActivity(db, {
                  companyId,
                  actorType: actor.actorType,
                  actorId: actor.actorId,
                  agentId: actor.agentId,
                  runId: actor.runId,
                  agentApiKeyId: actor.agentApiKeyId,
                  action: LIFECYCLE_HOOK_COMMAND_UNRESOLVED_ACTION,
                  entityType: "instance_settings",
                  entityId: finding.setting,
                  details: {
                    setting: finding.setting,
                    command: finding.command,
                    missingPaths: finding.missingPaths,
                    detectedAt: "write",
                  },
                }),
              ),
            ),
          );
        } catch (err) {
          logger.warn({ err }, "failed to record lifecycle hook command write-time warning");
        }
      }
      res.json(
        hookFindings.length === 0
          ? updated.general
          : {
              ...updated.general,
              hookCommandWarnings: hookFindings.map((finding) => ({
                ...finding,
                message: describeHookCommandFinding(finding),
              })),
            },
      );
    },
  );

  router.get("/instance/settings/experimental", async (req, res) => {
    // Experimental settings are readable by any authenticated org member
    // or instance admin. Updating them remains instance-admin only because
    // this payload includes instance-wide operational controls.
    assertBoardOrgAccess(req);
    res.json(await svc.getExperimental());
  });

  router.patch(
    "/instance/settings/experimental",
    validate(patchInstanceExperimentalSettingsSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const updated = await svc.updateExperimental(req.body);
      const actor = getActorInfo(req);
      const companyIds = await svc.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            agentApiKeyId: actor.agentApiKeyId,
            action: "instance.settings.experimental_updated",
            entityType: "instance_settings",
            entityId: updated.id,
            details: {
              experimental: updated.experimental,
              changedKeys: Object.keys(req.body).sort(),
            },
          }),
        ),
      );
      res.json(updated.experimental);
    },
  );

  // POST /api/instance/reset — delete all companies (cascades all data) for fresh onboarding
  router.post("/instance/reset", async (req, res) => {
    assertCanManageInstanceSettings(req);
    const svcCompany = companyService(db);
    const allCompanies = await db.select({ id: companies.id }).from(companies);
    for (const company of allCompanies) {
      await svcCompany.remove(company.id);
    }
    res.json({ ok: true, deleted: allCompanies.length });
  });

  router.post(
    "/instance/settings/experimental/issue-graph-liveness-auto-recovery/preview",
    validate(issueGraphLivenessAutoRecoveryRequestSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      res.json(await heartbeat.buildIssueGraphLivenessAutoRecoveryPreview({
        lookbackHours: req.body.lookbackHours,
      }));
    },
  );

  router.post(
    "/instance/settings/experimental/issue-graph-liveness-auto-recovery/run",
    validate(issueGraphLivenessAutoRecoveryRequestSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const actor = getActorInfo(req);
      const result = await heartbeat.reconcileIssueGraphLiveness({
        runId: actor.runId,
        force: true,
        lookbackHours: req.body.lookbackHours,
      });
      const companyIds = await svc.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            agentApiKeyId: actor.agentApiKeyId,
            action: "instance.settings.issue_graph_liveness_auto_recovery_run",
            entityType: "instance_settings",
            entityId: "default",
            details: {
              lookbackHours: result.lookbackHours,
              escalationsCreated: result.escalationsCreated,
              existingEscalations: result.existingEscalations,
              skippedOutsideLookback: result.skippedOutsideLookback,
              // Suppression volume is the quantity BLO-27676 changed, and an
              // operator-triggered run is where it most wants recording: without
              // these the audit trail cannot distinguish "nothing was wrong" from
              // "everything was suppressed".
              skippedReescalationCooldown: result.skippedReescalationCooldown,
              skippedUnchangedTarget: result.skippedUnchangedTarget,
              escalationIssueIds: result.escalationIssueIds,
            },
          }),
        ),
      );
      res.json(result);
    },
  );

  return router;
}
