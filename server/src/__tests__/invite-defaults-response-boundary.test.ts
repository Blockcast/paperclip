import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, invites, joinRequests } from "@paperclipai/db";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { redactInviteRecord, redactJoinRequestRecord } from "../routes/invite-response.js";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PEN-3725 (PEN-2370 series) — `invites.defaultsPayload` and `joinRequests.agentDefaultsPayload`
 * carry gateway adapter config by the onboarding manifest's own contract, and every exit that
 * answered with the stored row spread them verbatim to any principal holding `users:invite` or
 * `joins:approve`. `invites.tokenHash` rode out on the same unstripped spread.
 *
 * Every fixture value below is invented. No real credential is quoted anywhere in this file, per the
 * parent ticket's standing prohibition — the `devicePrivateKeyPem` fixture is deliberately NOT a
 * real PEM block, since the key NAME is what drives its redaction and a realistic block would put a
 * key-shaped artifact in the tree for no added assurance.
 */

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    isInstanceAdmin: vi.fn(),
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({ getById: vi.fn() }),
  boardAuthService: () => ({
    createChallenge: vi.fn(),
    resolveBoardAccess: vi.fn(),
    assertCurrentBoardKey: vi.fn(),
    revokeBoardApiKey: vi.fn(),
  }),
  deduplicateAgentName: vi.fn(),
  logActivity: vi.fn(),
  notifyHireApproved: vi.fn(),
}));

const OPENCLAW_TOKEN_SENTINEL = "sentinel-openclaw-gateway-token-must-not-egress";
const HERMES_KEY_SENTINEL = "sentinel-hermes-gateway-key-must-not-egress";
const DEVICE_KEY_SENTINEL = "sentinel-device-private-key-must-not-egress";
const TOKEN_HASH_SENTINEL = "sentinel-invite-token-hash-must-not-egress";

/** The shape the onboarding manifest tells an OpenClaw joiner to send. */
function openClawDefaults(): Record<string, unknown> {
  return {
    adapterType: "openclaw_gateway",
    url: "wss://gateway.example/socket",
    headers: { "x-openclaw-token": OPENCLAW_TOKEN_SENTINEL },
    devicePrivateKeyPem: DEVICE_KEY_SENTINEL,
    apiKey: HERMES_KEY_SENTINEL,
    agentMessage: "join the company",
    human: { role: "operator", grants: ["issue:read"] },
    agent: { grants: ["users:invite"] },
  };
}

function bodyText(value: unknown): string {
  return JSON.stringify(value);
}

describe("invite / join-request adapter defaults — redaction unit", () => {
  it("masks every credential field an OpenClaw invite payload carries", () => {
    const redacted = redactInviteRecord({
      id: "invite-1",
      tokenHash: TOKEN_HASH_SENTINEL,
      defaultsPayload: openClawDefaults(),
    });

    const serialized = bodyText(redacted);
    expect(serialized).not.toContain(OPENCLAW_TOKEN_SENTINEL);
    expect(serialized).not.toContain(HERMES_KEY_SENTINEL);
    expect(serialized).not.toContain(DEVICE_KEY_SENTINEL);
    expect(serialized).not.toContain(TOKEN_HASH_SENTINEL);
    expect(redacted).not.toHaveProperty("tokenHash");
  });

  it("keeps the non-credential fields the admin surfaces actually render", () => {
    const redacted = redactInviteRecord({
      id: "invite-1",
      tokenHash: TOKEN_HASH_SENTINEL,
      defaultsPayload: openClawDefaults(),
    }) as { defaultsPayload: Record<string, any> };

    // These drive `humanRole`, `inviteMessage` and the grant preview. Masking them would break the
    // invite list for no disclosure benefit — none of them is credential material.
    expect(redacted.defaultsPayload.agentMessage).toBe("join the company");
    expect(redacted.defaultsPayload.human.role).toBe("operator");
    expect(redacted.defaultsPayload.agent.grants).toEqual(["users:invite"]);
    expect(redacted.defaultsPayload.adapterType).toBe("openclaw_gateway");
  });

  it("masks a gateway token carried under a RENAMED header, which name-based redaction alone misses", () => {
    // This is the reason the module uses `redactAgentConfigPayload` rather than the bare
    // `sanitizeRecord`: under `agentConfig` every non-benign header value is masked, so the cover
    // does not depend on the header happening to be spelled with "token" or "auth" in it.
    const redacted = redactInviteRecord({
      tokenHash: TOKEN_HASH_SENTINEL,
      defaultsPayload: { headers: { "x-gateway-handle": OPENCLAW_TOKEN_SENTINEL } },
    });

    expect(bodyText(redacted)).not.toContain(OPENCLAW_TOKEN_SENTINEL);
  });

  it("strips claimSecretHash and masks agentDefaultsPayload on a join request", () => {
    const redacted = redactJoinRequestRecord({
      id: "join-1",
      claimSecretHash: "sentinel-claim-secret-hash-must-not-egress",
      agentDefaultsPayload: openClawDefaults(),
    });

    const serialized = bodyText(redacted);
    expect(redacted).not.toHaveProperty("claimSecretHash");
    expect(serialized).not.toContain("sentinel-claim-secret-hash-must-not-egress");
    expect(serialized).not.toContain(OPENCLAW_TOKEN_SENTINEL);
    expect(serialized).not.toContain(DEVICE_KEY_SENTINEL);
  });

  it("passes a null / absent payload through without inventing one", () => {
    expect(redactInviteRecord({ id: "a", tokenHash: "h", defaultsPayload: null })).toEqual({
      id: "a",
      defaultsPayload: null,
    });
    expect(redactInviteRecord({ id: "a", tokenHash: "h" })).toEqual({ id: "a" });
  });

  it("POSITIVE CONTROL: the sentinels are present before redaction", () => {
    // Without this, every `not.toContain` above would pass just as happily against a fixture that
    // never carried the value in the first place.
    const raw = bodyText({ tokenHash: TOKEN_HASH_SENTINEL, defaultsPayload: openClawDefaults() });
    expect(raw).toContain(OPENCLAW_TOKEN_SENTINEL);
    expect(raw).toContain(HERMES_KEY_SENTINEL);
    expect(raw).toContain(DEVICE_KEY_SENTINEL);
    expect(raw).toContain(TOKEN_HASH_SENTINEL);
    expect(REDACTED_EVENT_VALUE).toBeTruthy();
  });
});

/**
 * The write-side decision, pinned as a control rather than left in a comment.
 *
 * `invite-response.ts` ships a read mask with NO restore half, and that is only safe because these
 * payloads never round-trip: nothing accepts a `defaultsPayload` for an EXISTING invite or join
 * request, so a masked value can never be PATCHed back over the stored credential. That is the trap
 * PEN-3033 had to pay for with `restoreMaskedEnvBindings`. If someone later adds an invite editor,
 * this test fails and sends them to the module header instead of letting them ship the corruption.
 */
describe("invite / join-request payloads do not round-trip", () => {
  const accessSource = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../routes/access.ts"),
    "utf8",
  );

  it("registers no PATCH/PUT/DELETE route on any invite or join-request path", () => {
    const mutatingRoutes = [...accessSource.matchAll(/router\.(patch|put|delete)\(\s*\n?\s*"([^"]+)"/g)]
      .map((match) => `${match[1]} ${match[2]}`);

    // Positive control: the scan must actually be finding routes, or an empty result below would
    // be the regex failing rather than the property holding.
    expect(mutatingRoutes.length).toBeGreaterThan(0);
    expect(mutatingRoutes.filter((route) => /invite|join-request/i.test(route))).toEqual([]);
  });

  it("keeps the revoke handler free of any request-body read", () => {
    // The two mutating invite/join routes that DO exist are POSTs. Revoke reads `req.body` nowhere,
    // so it cannot receive a masked payload back.
    const start = accessSource.indexOf('router.post("/invites/:inviteId/revoke"');
    expect(start).toBeGreaterThan(-1);
    // Bound the slice at the NEXT route registration — running to end-of-file would sweep in every
    // later handler and the assertion would be about the whole module rather than this one.
    const rest = accessSource.slice(start + 1);
    const end = rest.search(/\n\s*router\.[a-z]+\(/);
    expect(end).toBeGreaterThan(-1);
    const revokeHandler = rest.slice(0, end);

    expect(revokeHandler).toContain("users:invite");
    expect(revokeHandler).not.toContain("req.body");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres invite defaults boundary tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("invite / join-request adapter defaults — route exits", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let inviteId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-invite-defaults-boundary-");
    db = createDb(tempDb.connectionString);
  });

  beforeEach(async () => {
    companyId = randomUUID();
    inviteId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(invites).values({
      id: inviteId,
      companyId,
      inviteType: "company_join",
      tokenHash: TOKEN_HASH_SENTINEL,
      allowedJoinTypes: "both",
      defaultsPayload: openClawDefaults(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
  });

  afterEach(async () => {
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "local_implicit",
        userId: null,
        companyIds: [companyId],
      };
      next();
    });
    app.use(
      "/api",
      accessRoutes(db, {
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: [],
      }),
    );
    app.use(errorHandler);
    return app;
  }

  function expectNoCredentials(res: { status: number; text: string }) {
    expect(res.status).toBeLessThan(400);
    expect(res.text).not.toContain(OPENCLAW_TOKEN_SENTINEL);
    expect(res.text).not.toContain(HERMES_KEY_SENTINEL);
    expect(res.text).not.toContain(DEVICE_KEY_SENTINEL);
    expect(res.text).not.toContain(TOKEN_HASH_SENTINEL);
  }

  // --- users:invite -------------------------------------------------------------------------

  it("GET /companies/:companyId/invites does not egress defaultsPayload credentials or tokenHash", async () => {
    const res = await request(createApp()).get(`/api/companies/${companyId}/invites`);

    expectNoCredentials(res);
    // The derived fields are computed from the RAW row and must survive the mask.
    expect(res.body.invites[0].humanRole).toBe("operator");
    expect(res.body.invites[0].inviteMessage).toBe("join the company");
    expect(res.body.invites[0]).not.toHaveProperty("tokenHash");
  });

  it("POST /invites/:inviteId/revoke does not egress them on either return path", async () => {
    const app = createApp();

    const first = await request(app).post(`/api/invites/${inviteId}/revoke`).send({});
    expectNoCredentials(first);

    // Second call takes the already-revoked early return, which answers with a DIFFERENT row object
    // and was a separate unredacted exit.
    const second = await request(app).post(`/api/invites/${inviteId}/revoke`).send({});
    expectNoCredentials(second);
  });

  // --- joins:approve ------------------------------------------------------------------------

  it("GET /companies/:companyId/join-requests does not egress agentDefaultsPayload credentials", async () => {
    await db.insert(joinRequests).values({
      id: randomUUID(),
      inviteId,
      companyId,
      requestType: "agent",
      status: "pending_approval",
      requestIp: "127.0.0.1",
      agentName: "joining-agent",
      adapterType: "openclaw_gateway",
      agentDefaultsPayload: openClawDefaults(),
      claimSecretHash: "sentinel-claim-secret-hash-must-not-egress",
    });

    const res = await request(createApp()).get(`/api/companies/${companyId}/join-requests`);

    expectNoCredentials(res);
    expect(res.text).not.toContain("sentinel-claim-secret-hash-must-not-egress");
    expect(res.body[0].agentName).toBe("joining-agent");
  });
});
