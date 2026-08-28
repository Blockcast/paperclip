import type {
  PluginApiRequestInput,
  PluginApiResponse,
  PluginContext,
  PluginPerformActionContext,
} from "@paperclipai/plugin-sdk";
import { recoverAggregateFiring } from "./webhook-handler.js";

export const RECOVER_AGGREGATE_FIRING_ACTION = "recover-aggregate-firing";
export const LIST_AGGREGATE_FIRING_FENCES_ROUTE = "list-aggregate-firing-fences";
export const RECOVER_AGGREGATE_FIRING_ROUTE = "recover-aggregate-firing";

type AggregateFiringFenceRow = {
  aggregate_key: string;
  firing_token: string;
  updated_at: string;
};

export type AggregateFiringFence = {
  aggregateKey: string;
  firingToken: string;
  updatedAt: string;
};

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function recoveryFailureResponse(status = 400): PluginApiResponse {
  return {
    status,
    body: { error: "Alertmanager aggregate firing recovery failed" },
  };
}

function isBoardUser(input: PluginApiRequestInput): boolean {
  return input.actor.actorType === "user" && Boolean(nonEmptyString(input.actor.userId));
}

/**
 * List only currently-held firing fences for the already host-authorized
 * company. The token is intentionally present here: it is the capability an
 * operator needs to identify the interrupted owner, and this route is
 * declared `auth: board` so the host applies normal board/company access
 * checks before the worker sees it. Callers must treat this response as
 * sensitive and non-cacheable.
 */
export async function listAggregateFiringFences(
  ctx: PluginContext,
  companyId: string,
): Promise<AggregateFiringFence[]> {
  const rows = await ctx.db.query<AggregateFiringFenceRow>(
    `SELECT aggregate_key, firing_token, updated_at
       FROM ${ctx.db.namespace}.alertmanager_aggregate_lifecycle_fences
      WHERE company_id = $1
        AND phase = 'firing'
        AND firing_token IS NOT NULL
      ORDER BY updated_at ASC`,
    [companyId],
  );
  return rows.map((row) => ({
    aggregateKey: row.aggregate_key,
    firingToken: row.firing_token,
    updatedAt: row.updated_at,
  }));
}

async function recoverAndAudit(
  ctx: PluginContext,
  companyId: string,
  aggregateKey: string,
  firingToken: string,
): Promise<{ recovered: boolean }> {
  const recovered = await recoverAggregateFiring(
    ctx,
    companyId,
    aggregateKey,
    firingToken,
  );

  // Never include firingToken in the activity message, entity data, or
  // metadata. The aggregate key is normally derived from alert labels, so it
  // is untrusted input too; redact the token if a malicious/synthetic alert
  // made the two values overlap. The token is bearer-equivalent and only the
  // list route may return it to an already authorized board user.
  const auditAggregateKey = aggregateKey.split(firingToken).join("[redacted]");
  await ctx.activity.log({
    companyId,
    message: `Alertmanager aggregate firing recovery ${recovered ? "succeeded" : "found no matching fence"} for ${auditAggregateKey}`,
    entityType: "alertmanager_aggregate",
    entityId: auditAggregateKey,
    metadata: {
      aggregateKey: auditAggregateKey,
      recovered,
    },
  });

  return { recovered };
}

/**
 * Worker implementation for the manifest-declared operator API. The host
 * enforces `auth: board` and company membership; the worker repeats the user
 * check as defense in depth because the firing token is bearer-equivalent.
 */
export async function handleRecoveryApiRequest(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  if (!isBoardUser(input)) {
    return recoveryFailureResponse(403);
  }

  if (input.routeKey === LIST_AGGREGATE_FIRING_FENCES_ROUTE) {
    try {
      const requestedCompanyId = nonEmptyString(input.query.companyId);
      if (requestedCompanyId !== input.companyId) {
        return recoveryFailureResponse();
      }
      return {
        headers: { "cache-control": "no-store" },
        body: {
          fences: await listAggregateFiringFences(ctx, input.companyId),
        },
      };
    } catch {
      throw new Error("Alertmanager aggregate fence listing failed");
    }
  }

  if (input.routeKey === RECOVER_AGGREGATE_FIRING_ROUTE) {
    const body = input.body && typeof input.body === "object"
      ? input.body as Record<string, unknown>
      : null;
    const requestedCompanyId = nonEmptyString(body?.companyId);
    const aggregateKey = nonEmptyString(body?.aggregateKey);
    const firingToken = nonEmptyString(body?.firingToken);
    if (
      !requestedCompanyId ||
      requestedCompanyId !== input.companyId ||
      !aggregateKey ||
      !firingToken
    ) {
      return recoveryFailureResponse();
    }

    try {
      return {
        headers: { "cache-control": "no-store" },
        body: await recoverAndAudit(
          ctx,
          requestedCompanyId,
          aggregateKey,
          firingToken,
        ),
      };
    } catch {
      throw new Error("Alertmanager aggregate firing recovery failed");
    }
  }

  return {
    status: 404,
    body: { error: "Alertmanager plugin API route not found" },
  };
}

/**
 * Register the operator-only escape hatch for an interrupted firing delivery.
 * The handler intentionally collapses every validation/database failure to a
 * fixed error: action params include a bearer-equivalent token, and forwarding
 * an arbitrary exception could disclose it through the action response.
 */
export function registerRecoveryAction(ctx: PluginContext): void {
  ctx.actions.register(
    RECOVER_AGGREGATE_FIRING_ACTION,
    async (
      params: Record<string, unknown>,
      context: PluginPerformActionContext,
    ): Promise<{ recovered: boolean }> => {
      try {
        if (context.actor.type !== "user" || !nonEmptyString(context.actor.userId)) {
          throw new Error("operator actor required");
        }

        const hostCompanyId = nonEmptyString(context.companyId);
        if (!hostCompanyId) throw new Error("company scope required");

        const requestedCompanyId = nonEmptyString(params.companyId);
        if (!requestedCompanyId || requestedCompanyId !== hostCompanyId) {
          throw new Error("company scope mismatch");
        }

        const aggregateKey = nonEmptyString(params.aggregateKey);
        const firingToken = nonEmptyString(params.firingToken);
        if (!aggregateKey || !firingToken) {
          throw new Error("aggregate key and firing token required");
        }

        return recoverAndAudit(
          ctx,
          requestedCompanyId,
          aggregateKey,
          firingToken,
        );
      } catch {
        throw new Error("Alertmanager aggregate firing recovery failed");
      }
    },
  );
}
