import { describe, it, expect, vi } from "vitest";
import {
  approvals as approvalsTable,
  companyMemberships as companyMembershipsTable,
} from "@paperclipai/db";
import {
  loadDexRbacConfig,
  parseIdTokenGroups,
  reconcileDexUser,
} from "../auth/oidc-rbac.js";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

describe("parseIdTokenGroups", () => {
  it("extracts a string[] groups claim", () => {
    const idToken = makeJwt({
      sub: "u1",
      groups: ["980aeb78-a886-4dae-98bb-7a9893d20706", "675cb5f3-4a94-4514-96d8-9899587b19ed"],
    });
    expect(parseIdTokenGroups(idToken)).toEqual([
      "980aeb78-a886-4dae-98bb-7a9893d20706",
      "675cb5f3-4a94-4514-96d8-9899587b19ed",
    ]);
  });

  it("returns [] for a token with no groups claim", () => {
    const idToken = makeJwt({ sub: "u1", email: "a@b.com" });
    expect(parseIdTokenGroups(idToken)).toEqual([]);
  });

  it("returns [] for a token with a non-array groups claim", () => {
    const idToken = makeJwt({ sub: "u1", _claim_names: { groups: "src1" } });
    expect(parseIdTokenGroups(idToken)).toEqual([]);
  });

  it("returns [] for malformed tokens (no panic)", () => {
    expect(parseIdTokenGroups(null)).toEqual([]);
    expect(parseIdTokenGroups("")).toEqual([]);
    expect(parseIdTokenGroups("not.a.jwt.atall")).toEqual([]);
    expect(parseIdTokenGroups("header.bm90LWpzb24.sig")).toEqual([]);
  });

  it("filters non-string entries out of the groups array", () => {
    const idToken = makeJwt({ groups: ["980aeb78", 123, null, "675cb5f3"] });
    expect(parseIdTokenGroups(idToken)).toEqual(["980aeb78", "675cb5f3"]);
  });
});

describe("loadDexRbacConfig", () => {
  it("loads Workspace group email mappings from env", () => {
    const saved = {
      providerId: process.env.PAPERCLIP_DEX_OIDC_PROVIDER_ID,
      companyId: process.env.PAPERCLIP_DEX_BLOCKCAST_COMPANY_ID,
      operatorGroup: process.env.PAPERCLIP_DEX_OPERATOR_GROUP,
      adminGroup: process.env.PAPERCLIP_DEX_ADMIN_GROUP,
      adminApprovalType: process.env.PAPERCLIP_DEX_ADMIN_APPROVAL_TYPE,
    };
    process.env.PAPERCLIP_DEX_OIDC_PROVIDER_ID = "dex-google";
    process.env.PAPERCLIP_DEX_BLOCKCAST_COMPANY_ID = "co-blockcast";
    process.env.PAPERCLIP_DEX_OPERATOR_GROUP = "infra-pve-sudo@blockcast.net";
    process.env.PAPERCLIP_DEX_ADMIN_GROUP = "paperclip-admins@blockcast.net";
    process.env.PAPERCLIP_DEX_ADMIN_APPROVAL_TYPE = "paperclip_admin_elevation";
    try {
      expect(loadDexRbacConfig()).toEqual({
        providerId: "dex-google",
        blockcastCompanyId: "co-blockcast",
        operatorGroupId: "infra-pve-sudo@blockcast.net",
        adminGroupId: "paperclip-admins@blockcast.net",
        adminApprovalType: "paperclip_admin_elevation",
        payloadSource: "dex_groups_claim",
      });
    } finally {
      if (saved.providerId === undefined) delete process.env.PAPERCLIP_DEX_OIDC_PROVIDER_ID;
      else process.env.PAPERCLIP_DEX_OIDC_PROVIDER_ID = saved.providerId;
      if (saved.companyId === undefined) delete process.env.PAPERCLIP_DEX_BLOCKCAST_COMPANY_ID;
      else process.env.PAPERCLIP_DEX_BLOCKCAST_COMPANY_ID = saved.companyId;
      if (saved.operatorGroup === undefined) delete process.env.PAPERCLIP_DEX_OPERATOR_GROUP;
      else process.env.PAPERCLIP_DEX_OPERATOR_GROUP = saved.operatorGroup;
      if (saved.adminGroup === undefined) delete process.env.PAPERCLIP_DEX_ADMIN_GROUP;
      else process.env.PAPERCLIP_DEX_ADMIN_GROUP = saved.adminGroup;
      if (saved.adminApprovalType === undefined) delete process.env.PAPERCLIP_DEX_ADMIN_APPROVAL_TYPE;
      else process.env.PAPERCLIP_DEX_ADMIN_APPROVAL_TYPE = saved.adminApprovalType;
    }
  });
});

describe("reconcileDexUser (mocked db)", () => {
  function makeDb() {
    // Track inserts and existing rows via a simple in-memory store. The
    // shape mirrors what drizzle's chained API expects: select().from().
    // where().limit(); insert().values(); update().set().where().
    const store = {
      memberships: [] as Array<{ id: string; companyId: string; principalType: string; principalId: string; status: string; membershipRole: string | null }>,
      approvals: [] as Array<{ id: string; companyId: string; type: string; requestedByUserId: string; status: string; payload: Record<string, unknown> }>,
    };
    const db = {
      select: vi.fn().mockImplementation((_cols: any) => ({
        from: (table: any) => ({
          where: (_clause: any) => ({
            limit: (_n: number) => {
              if (table === companyMembershipsTable) {
                const m = store.memberships[0];
                return m ? [{ id: m.id, status: m.status }] : [];
              }
              if (table === approvalsTable) {
                const a = store.approvals[0];
                return a ? [{ id: a.id }] : [];
              }
              return [];
            },
          }),
        }),
      })),
      insert: vi.fn().mockImplementation((table: any) => ({
        values: vi.fn().mockImplementation(async (row: any) => {
          const id = `id-${(store.memberships.length + store.approvals.length + 1)}`;
          if (table === companyMembershipsTable) {
            store.memberships.push({ id, ...row });
          } else if (table === approvalsTable) {
            store.approvals.push({ id, ...row });
          }
        }),
      })),
      update: vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      })),
      _store: store,
    } as any;
    return db;
  }

  const cfg = {
    providerId: "dex",
    blockcastCompanyId: "co-blockcast",
    operatorGroupId: "g-ssh",
    adminGroupId: "g-admin",
    adminApprovalType: "dex_admin_elevation",
    payloadSource: "dex_groups_claim",
  };

  it("inserts a new operator membership when user is in ssh-users", async () => {
    const db = makeDb();
    // Make the mock recognize the table identity by short-circuiting select to
    // always return empty (the membership doesn't exist yet).
    db.select = vi.fn(() => ({
      from: () => ({ where: () => ({ limit: () => [] }) }),
    }));
    const result = await reconcileDexUser(db, "user-1", ["g-ssh"], cfg);
    expect(result.addedMembership).toBe(true);
    expect(result.pendingAdminElevation).toBe(false);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("does not re-insert when the operator membership already exists and is active", async () => {
    const db = makeDb();
    db.select = vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: () => [{ id: "existing", status: "active" }],
        }),
      }),
    }));
    const result = await reconcileDexUser(db, "user-1", ["g-ssh"], cfg);
    expect(result.addedMembership).toBe(false);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("re-activates an archived membership when user re-appears in ssh-users", async () => {
    const db = makeDb();
    db.select = vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: () => [{ id: "existing", status: "archived" }],
        }),
      }),
    }));
    const result = await reconcileDexUser(db, "user-1", ["g-ssh"], cfg);
    expect(result.addedMembership).toBe(true);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("creates a pending approval (not a grant) when user is in AdminAgents", async () => {
    const db = makeDb();
    db.select = vi.fn(() => ({
      from: () => ({ where: () => ({ limit: () => [] }) }),
    }));
    const result = await reconcileDexUser(db, "user-1", ["g-admin"], cfg);
    expect(result.pendingAdminElevation).toBe(true);
    expect(result.addedMembership).toBe(false);
  });

  it("adds a non-empty title to a pending admin-elevation approval", async () => {
    const db = makeDb();
    db.select = vi.fn(() => ({
      from: () => ({ where: () => ({ limit: () => [] }) }),
    }));

    await reconcileDexUser(db, "user-1", ["g-admin"], cfg);

    expect(db._store.approvals).toHaveLength(1);
    expect(db._store.approvals[0]?.payload.title).toBe("Admin elevation requested for user-1");
  });

  it("does not create a duplicate approval when one is already pending", async () => {
    const db = makeDb();
    db.select = vi.fn(() => ({
      from: () => ({
        where: () => ({ limit: () => [{ id: "existing-approval" }] }),
      }),
    }));
    const result = await reconcileDexUser(db, "user-1", ["g-admin"], cfg);
    expect(result.pendingAdminElevation).toBe(false);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("no-ops for a user in unrelated groups", async () => {
    const db = makeDb();
    db.select = vi.fn(() => ({
      from: () => ({ where: () => ({ limit: () => [] }) }),
    }));
    const result = await reconcileDexUser(db, "user-1", ["g-other"], cfg);
    expect(result.addedMembership).toBe(false);
    expect(result.pendingAdminElevation).toBe(false);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("uses Dex Workspace group emails for operator grants", async () => {
    const db = makeDb();
    db.select = vi.fn(() => ({
      from: () => ({ where: () => ({ limit: () => [] }) }),
    }));
    const result = await reconcileDexUser(
      db,
      "user-1",
      ["Infra-PVE-Sudo@Blockcast.Net"],
      {
        providerId: "dex",
        blockcastCompanyId: "co-blockcast",
        operatorGroupId: "infra-pve-sudo@blockcast.net",
        adminGroupId: null,
        adminApprovalType: "dex_admin_elevation",
        payloadSource: "dex_groups_claim",
      },
    );
    expect(result.addedMembership).toBe(true);
    expect(result.pendingAdminElevation).toBe(false);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});
