import { describe, expect, it } from "vitest";
import { REDACTED_SENTINEL, type CompanySecret, type UserSecretDefinition } from "@paperclipai/shared";
import {
  canStoreValueAsSecret,
  computeDuplicateNames,
  computeRowHealth,
  computeUserSecretRowHealth,
  emptyRow,
  envKeyFromSecretName,
  maskedRenameBlockers,
  maskedRenameIssue,
  planSourceSwitch,
  rowsFromValue,
  secretNameFromKey,
  validateName,
  valueFromRows,
  type EnvRow,
} from "./model";

function makeUserSecretDefinition(overrides: { key: string; status?: "active" | "disabled" | "archived" }): UserSecretDefinition {
  return {
    id: `def-${overrides.key}`,
    companyId: "co",
    key: overrides.key,
    name: overrides.key.toUpperCase(),
    description: null,
    status: overrides.status ?? "active",
    provider: "local_encrypted",
    managedMode: "paperclip_managed",
    providerConfigId: null,
    providerMetadata: null,
    usageGuidance: null,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    deletedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function makeSecret(overrides: Partial<CompanySecret> & Pick<CompanySecret, "id">): CompanySecret {
  return {
    companyId: "co",
    scope: "company",
    ownerUserId: null,
    userSecretDefinitionId: null,
    key: overrides.id,
    name: overrides.id.toUpperCase(),
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 3,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe("rowsFromValue", () => {
  it("returns no rows for empty/undefined input (no ghost row)", () => {
    expect(rowsFromValue(undefined)).toEqual([]);
    expect(rowsFromValue({})).toEqual([]);
  });

  it("maps legacy string, plain, secret_ref, and user_secret_ref bindings", () => {
    const rows = rowsFromValue({
      LEGACY: "raw",
      PLAIN: { type: "plain", value: "v" },
      REF: { type: "secret_ref", secretId: "s1", version: 2 },
      REF_LATEST: { type: "secret_ref", secretId: "s2" },
      USER_REF: { type: "user_secret_ref", key: "github_token", version: "latest", required: false },
    });
    expect(
      rows.map((r) => ({
        name: r.name,
        source: r.source,
        textValue: r.textValue,
        secretId: r.secretId,
        userSecretKey: r.userSecretKey,
        required: r.required,
        version: r.version,
      })),
    ).toEqual([
      { name: "LEGACY", source: "text", textValue: "raw", secretId: "", userSecretKey: "", required: true, version: "latest" },
      { name: "PLAIN", source: "text", textValue: "v", secretId: "", userSecretKey: "", required: true, version: "latest" },
      { name: "REF", source: "secret", textValue: "", secretId: "s1", userSecretKey: "", required: true, version: 2 },
      { name: "REF_LATEST", source: "secret", textValue: "", secretId: "s2", userSecretKey: "", required: true, version: "latest" },
      {
        name: "USER_REF",
        source: "user_secret",
        textValue: "",
        secretId: "",
        userSecretKey: "github_token",
        required: false,
        version: "latest",
      },
    ]);
  });
});

describe("valueFromRows (emit semantics)", () => {
  function row(partial: Partial<EnvRow>): EnvRow {
    return { ...emptyRow(), ...partial };
  }

  it("emits undefined when there are no complete rows", () => {
    expect(valueFromRows([])).toBeUndefined();
    expect(valueFromRows([row({ name: "" })])).toBeUndefined();
  });

  it("drops rows with empty (trimmed) names", () => {
    expect(valueFromRows([row({ name: "   ", textValue: "x" })])).toBeUndefined();
  });

  it("drops secret rows without a chosen secret (incomplete ref)", () => {
    expect(valueFromRows([row({ name: "A", source: "secret", secretId: "" })])).toBeUndefined();
  });

  it("drops user-secret rows without a chosen definition key", () => {
    expect(valueFromRows([row({ name: "A", source: "user_secret", userSecretKey: "" })])).toBeUndefined();
  });

  it("emits plain, secret_ref, and user_secret_ref bindings", () => {
    expect(
      valueFromRows([
        row({ name: "A", source: "text", textValue: "1" }),
        row({ name: "B", source: "secret", secretId: "s1", version: 2 }),
        row({ name: "C", source: "user_secret", userSecretKey: "github_token", required: false }),
      ]),
    ).toEqual({
      A: { type: "plain", value: "1" },
      B: { type: "secret_ref", secretId: "s1", version: 2 },
      C: { type: "user_secret_ref", key: "github_token", version: "latest", required: false },
    });
  });

  it("is last-writer-wins on duplicate names", () => {
    expect(
      valueFromRows([
        row({ name: "A", textValue: "first" }),
        row({ name: "A", textValue: "second" }),
      ]),
    ).toEqual({ A: { type: "plain", value: "second" } });
  });
});

describe("validateName", () => {
  const reserved = ["PAPERCLIP_"];

  it("returns null for empty and valid names", () => {
    expect(validateName("", new Set(), reserved)).toBeNull();
    expect(validateName("GH_TOKEN", new Set(), reserved)).toBeNull();
    expect(validateName("_private1", new Set(), reserved)).toBeNull();
  });

  it("flags invalid charset", () => {
    expect(validateName("1BAD", new Set(), reserved)?.level).toBe("error");
    expect(validateName("has-dash", new Set(), reserved)?.message).toMatch(/letters, digits/);
  });

  it("flags duplicates as errors", () => {
    expect(validateName("DUP", new Set(["DUP"]), reserved)).toEqual({ level: "error", message: "Duplicate name" });
  });

  it("flags reserved prefixes as warnings", () => {
    const issue = validateName("PAPERCLIP_HOME", new Set(), reserved);
    expect(issue?.level).toBe("warn");
    expect(issue?.message).toMatch(/Reserved prefix/);
  });

  it("charset error takes precedence over reserved prefix", () => {
    expect(validateName("PAPERCLIP-X", new Set(), reserved)?.level).toBe("error");
  });
});

describe("maskedRenameIssue (PEN-3033)", () => {
  const masked = () => rowsFromValue({ GH_TOKEN: REDACTED_SENTINEL })[0]!;

  it("is silent while the row keeps the key its mask was issued under", () => {
    expect(maskedRenameIssue(masked())).toBeNull();
    // Whitespace is how the name input delivers a name mid-edit; it must not read as a rename.
    expect(maskedRenameIssue({ ...masked(), name: " GH_TOKEN " })).toBeNull();
  });

  it("errors once a withheld row is renamed, and names the key to get back to", () => {
    const issue = maskedRenameIssue({ ...masked(), name: "GITHUB_TOKEN" });
    expect(issue?.level).toBe("error");
    expect(issue?.message).toContain("GH_TOKEN");
  });

  it("clears when the user renames back", () => {
    const renamed = { ...masked(), name: "GITHUB_TOKEN" };
    expect(maskedRenameIssue(renamed)).not.toBeNull();
    expect(maskedRenameIssue({ ...renamed, name: "GH_TOKEN" })).toBeNull();
  });

  it("clears when the user supplies a value, because the row is no longer withheld", () => {
    // Exactly what the value input's onChange emits: `{ textValue, masked: false }`. After it the
    // client holds a real value for the new key, so the rename is legitimate and must go through.
    const renamed = { ...masked(), name: "GITHUB_TOKEN", textValue: "real", masked: false };
    expect(maskedRenameIssue(renamed)).toBeNull();
  });

  it("is inert on rows that were never masked", () => {
    expect(maskedRenameIssue({ ...emptyRow(), name: "ANYTHING" })).toBeNull();
    expect(maskedRenameIssue(rowsFromValue({ GH_TOKEN: "real" })[0]!)).toBeNull();
  });

  it("clears when a renamed row is rebound to a secret, which emits no sentinel", () => {
    // `Row.tsx`'s "to-secret" patches `{ source: "secret", ... }` and leaves `masked` set, so a
    // predicate keyed on the flag alone would block this — and it saves perfectly well, because
    // `valueFromRows` emits a `secret_ref` for it and the placeholder never reaches the server.
    const rebound = { ...masked(), name: "GITHUB_TOKEN", source: "secret" as const, secretId: "sec_1" };
    expect(maskedRenameIssue(rebound)).toBeNull();
    expect(valueFromRows([rebound])).toEqual({
      GITHUB_TOKEN: { type: "secret_ref", secretId: "sec_1", version: "latest" },
    });

    const reboundUserSecret = { ...masked(), name: "GITHUB_TOKEN", source: "user_secret" as const, userSecretKey: "gh" };
    expect(maskedRenameIssue(reboundUserSecret)).toBeNull();
  });

  it("blocks exactly the rows whose save would carry the sentinel", () => {
    const blocked = { ...masked(), name: "GITHUB_TOKEN" };
    const allowed = { ...masked(), name: "GITHUB_TOKEN", source: "secret" as const, secretId: "sec_1" };
    expect(maskedRenameBlockers([masked(), blocked, allowed])).toEqual([blocked]);
    // The predicate and the emit must agree: only the blocked row's payload carries the placeholder.
    expect(valueFromRows([blocked])).toEqual({ GITHUB_TOKEN: { type: "plain", value: REDACTED_SENTINEL } });
  });
});

describe("computeDuplicateNames", () => {
  it("collects names appearing more than once", () => {
    const rows = [
      { ...emptyRow(), name: "A" },
      { ...emptyRow(), name: "A" },
      { ...emptyRow(), name: "B" },
      { ...emptyRow(), name: "" },
    ];
    expect([...computeDuplicateNames(rows)]).toEqual(["A"]);
  });
});

describe("computeRowHealth", () => {
  const secrets = [makeSecret({ id: "active" }), makeSecret({ id: "disabled", status: "disabled" })];

  it("returns null for healthy secret and text rows", () => {
    expect(computeRowHealth({ ...emptyRow(), source: "text", name: "A", textValue: "x" }, secrets)).toBeNull();
    expect(computeRowHealth({ ...emptyRow(), source: "secret", secretId: "active" }, secrets)).toBeNull();
  });

  it("flags a missing secret as an error", () => {
    expect(computeRowHealth({ ...emptyRow(), source: "secret", secretId: "gone" }, secrets)?.kind).toBe("missing");
  });

  it("flags a disabled secret as a warning", () => {
    expect(computeRowHealth({ ...emptyRow(), source: "secret", secretId: "disabled" }, secrets)?.kind).toBe("disabled");
  });
});

describe("computeUserSecretRowHealth", () => {
  const definitions = [
    makeUserSecretDefinition({ key: "active" }),
    makeUserSecretDefinition({ key: "disabled", status: "disabled" }),
  ];

  it("returns null for healthy user-secret refs and non-user-secret rows", () => {
    expect(computeUserSecretRowHealth({ ...emptyRow(), source: "text", name: "A" }, definitions)).toBeNull();
    expect(
      computeUserSecretRowHealth({ ...emptyRow(), source: "user_secret", userSecretKey: "active" }, definitions),
    ).toBeNull();
  });

  it("flags missing and disabled user-secret definitions", () => {
    expect(computeUserSecretRowHealth({ ...emptyRow(), source: "user_secret", userSecretKey: "gone" }, definitions)?.kind).toBe("missing");
    expect(computeUserSecretRowHealth({ ...emptyRow(), source: "user_secret", userSecretKey: "disabled" }, definitions)?.kind).toBe("disabled");
  });
});

describe("planSourceSwitch (§6.3)", () => {
  it("is a noop when the source is unchanged", () => {
    expect(planSourceSwitch({ ...emptyRow(), source: "text" }, "text")).toEqual({ kind: "noop" });
  });

  it("preserves a non-empty value on Text→Secret by opening the store popover", () => {
    const plan = planSourceSwitch({ ...emptyRow(), name: "GH_TOKEN", source: "text", textValue: "abc" }, "secret");
    expect(plan).toEqual({ kind: "open-store", name: "gh_token", value: "abc" });
  });

  it("switches straight to secret when the text value is empty", () => {
    expect(planSourceSwitch({ ...emptyRow(), source: "text", textValue: "  " }, "secret")).toEqual({ kind: "to-secret" });
  });

  it("offers undo on Secret→Text when a secret was bound", () => {
    const row = { ...emptyRow(), source: "secret" as const, secretId: "s1", version: 2 as const };
    const plan = planSourceSwitch(row, "text");
    expect(plan.kind).toBe("to-text");
    if (plan.kind === "to-text") expect(plan.undoFrom?.secretId).toBe("s1");
  });

  it("does not offer undo on Secret→Text when no secret was bound", () => {
    const plan = planSourceSwitch({ ...emptyRow(), source: "secret" }, "text");
    expect(plan).toEqual({ kind: "to-text", undoFrom: null });
  });

  it("routes a withheld row to the picker instead of storing the placeholder (PEN-3033)", () => {
    // The mask is non-empty, so the ordinary `textValue.trim()` test would send this down
    // `open-store` and create a company secret holding `***REDACTED***`.
    const row = { ...emptyRow(), name: "GH_TOKEN", source: "text" as const, textValue: REDACTED_SENTINEL, masked: true };
    expect(planSourceSwitch(row, "secret")).toEqual({ kind: "to-secret" });
  });

  it("still stores a value the user typed over the mask", () => {
    // `masked` is cleared on edit, so this is an ordinary non-empty value again.
    const row = { ...emptyRow(), name: "GH_TOKEN", source: "text" as const, textValue: "real", masked: false };
    expect(planSourceSwitch(row, "secret")).toEqual({ kind: "open-store", name: "gh_token", value: "real" });
  });
});

describe("withheld-value handling (PEN-3033)", () => {
  it("flags a masked plain-string binding", () => {
    const [row] = rowsFromValue({ GH_TOKEN: REDACTED_SENTINEL });
    expect(row.masked).toBe(true);
    expect(row.textValue).toBe(REDACTED_SENTINEL);
  });

  it("flags a masked plain-object binding", () => {
    const [row] = rowsFromValue({ GH_TOKEN: { type: "plain", value: REDACTED_SENTINEL } });
    expect(row.masked).toBe(true);
  });

  it("records the key each mask was issued under, on both binding spellings", () => {
    // `maskedKey` is what lets the rename check tell "moved" from "moved back". Asserted on BOTH
    // masked branches of `rowsFromValue`: they are separate code paths, and a mask arriving
    // without its key silently disables the check rather than failing it.
    expect(rowsFromValue({ GH_TOKEN: REDACTED_SENTINEL })[0]!.maskedKey).toBe("GH_TOKEN");
    expect(rowsFromValue({ GH_TOKEN: { type: "plain", value: REDACTED_SENTINEL } })[0]!.maskedKey).toBe("GH_TOKEN");
    // And only alongside a mask: a `maskedKey` on an unmasked row would read as a general
    // "original name" and invite a rename check that fires on ordinary edits.
    expect(rowsFromValue({ GH_TOKEN: "real" })[0]!.maskedKey).toBeUndefined();
    expect(rowsFromValue({ GH_TOKEN: { type: "plain", value: "real" } })[0]!.maskedKey).toBeUndefined();
  });

  it("does not flag an ordinary value", () => {
    const [row] = rowsFromValue({ GH_TOKEN: "real" });
    expect(row.masked).toBe(false);
  });

  it("re-emits the sentinel on save so the server can merge the stored value back", () => {
    // `valueFromRows` must NOT drop or blank a withheld row: `restoreMaskedEnvBindings` matches on
    // this exact string to restore the real binding. Emitting anything else destroys it.
    const rows = rowsFromValue({ GH_TOKEN: REDACTED_SENTINEL });
    expect(valueFromRows(rows)).toEqual({ GH_TOKEN: { type: "plain", value: REDACTED_SENTINEL } });
  });

  it("refuses to store a withheld value as a secret, and allows it once edited", () => {
    const masked = { ...emptyRow(), source: "text" as const, textValue: REDACTED_SENTINEL, masked: true };
    expect(canStoreValueAsSecret(masked)).toBe(false);
    // What the value input's onChange produces once the user types over the mask.
    expect(canStoreValueAsSecret({ ...masked, textValue: "real", masked: false })).toBe(true);
  });

  it("refuses on an empty row, so the predicate is not merely a mask test", () => {
    expect(canStoreValueAsSecret({ ...emptyRow(), source: "text", textValue: "  " })).toBe(false);
  });
});

describe("name suggestion helpers", () => {
  it("secretNameFromKey lowercases to snake", () => {
    expect(secretNameFromKey("GH_TOKEN")).toBe("gh_token");
    expect(secretNameFromKey("Stripe-API-Key!")).toBe("stripe_api_key");
  });

  it("envKeyFromSecretName uppercases to snake", () => {
    expect(envKeyFromSecretName("github token")).toBe("GITHUB_TOKEN");
  });
});
