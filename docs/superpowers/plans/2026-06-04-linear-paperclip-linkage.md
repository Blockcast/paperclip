# Linear ↔ Paperclip Linkage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native Linear duplicate relations (`markDuplicate` + a "Mark Linear Duplicate" action) and make the Paperclip back-link attachment fire on every sync path (create + import + webhook-update) plus a one-time bounded backfill.

**Architecture:** All work is inside the `paperclip-plugin-linear` plugin. `markDuplicate` mirrors the idempotent GraphQL pattern of `attachmentLinkURL` (check-then-create via the `gql` helper). The new action mirrors the existing `Link`/`Unlink Linear Issue` tools (`ctx.tools.register`). The back-link extension reuses the existing `writePaperclipBackLink` helper (already idempotent: Linear dedupes attachments by URL) at additional call sites. The backfill is a paged, resumable action keyed off a state cursor.

**Tech Stack:** TypeScript, Vitest, Linear GraphQL API (`gql` helper in `linear.ts`), the plugin host-services (`ctx.issues`, `ctx.config`, `ctx.state`, `ctx.tools`, `ctx.http.fetch`).

---

## Scope Check — this plan is the plugin-side half; the "auto-path" is split out

The spec's section 2 has an **auto path** ("when a Paperclip `issueRelations` row of type `duplicate` is created, push `markDuplicate`"). Codebase reality makes that a **separate subsystem**, deferred to a follow-up plan, because:

1. **`issue_relations.type` only allows `'blocks'`.** `packages/db/src/migrations/0049_flawless_abomination.sql:13` defines `CHECK ("type" IN ('blocks'))`. Storing a `duplicate` relation needs a **new migration** to extend that constraint.
2. **No Paperclip relation-created event exists.** The plugin subscribes to `issue.created`, `issue.updated`, goal/project events (`worker.ts` `ctx.events.on(...)`), but there is **no `issueRelation.created` event** emitted by the server, and no production code path that inserts `issueRelations` rows of type `duplicate` (only test fixtures `insert(issueRelations)`). The auto-path requires server-side platform work (a relation-create API + event emission) across `packages/db` + `server/src` — out of plugin scope.

This plan delivers the **manual, ID-driven path** (D2-compliant), which is exactly what unblocks marking the 6 known twins (handoff item 4). The auto-path becomes **`docs/superpowers/plans/<date>-linear-duplicate-autopath.md`** (see "Follow-up plan" at the end).

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/plugins/paperclip-plugin-linear/src/linear.ts` | Linear GraphQL client | **Add** `markDuplicate()` (after `attachmentLinkURL`, ~line 420) |
| `packages/plugins/paperclip-plugin-linear/src/constants.ts` | Tool/action keys | **Add** `TOOL_NAMES.markDuplicate` (in `TOOL_NAMES`, line 20) |
| `packages/plugins/paperclip-plugin-linear/src/manifest.ts` | Tool declarations | **Add** "Mark Linear Duplicate" tool entry (mirror `TOOL_NAMES.link` block at 201–216) |
| `packages/plugins/paperclip-plugin-linear/src/worker.ts` | Runtime: tools + events | **Add** the tool handler (after the `unlink` register, ~line 920); **add** `writePaperclipBackLink` call on the webhook Issue.update path (~line 1335) |
| `packages/plugins/paperclip-plugin-linear/tests/linear.spec.ts` | Unit tests for `linear.ts` | **Create** (new file — `markDuplicate` against a mocked `fetch`) |
| `packages/plugins/paperclip-plugin-linear/tests/plugin.spec.ts` | Plugin integration tests | **Add** describe blocks for the action, webhook-update back-link, and backfill |

---

### Task 1: `markDuplicate` in `linear.ts`

**Files:**
- Create: `packages/plugins/paperclip-plugin-linear/tests/linear.spec.ts`
- Modify: `packages/plugins/paperclip-plugin-linear/src/linear.ts` (add after `attachmentLinkURL`, ~line 420)

- [ ] **Step 1: Write the failing unit tests**

Create `packages/plugins/paperclip-plugin-linear/tests/linear.spec.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { markDuplicate } from "../src/linear.js";

// gql() (linear.ts:222) calls fetch(LINEAR_API, {..., body: JSON.stringify({query, variables})}),
// checks res.ok, then res.json() -> { data, errors }. Mock that contract.
function mockFetch(jsonResponses: unknown[]) {
  const fn = vi.fn();
  for (const r of jsonResponses) {
    fn.mockResolvedValueOnce({ ok: true, json: async () => r });
  }
  return fn as unknown as typeof fetch;
}

describe("markDuplicate", () => {
  it("creates a duplicate relation dupe -> keeper when none exists", async () => {
    const fetch = mockFetch([
      { data: { issue: { relations: { nodes: [] } } } }, // pre-check: no relations
      { data: { issueRelationCreate: { success: true, issueRelation: { id: "rel-1" } } } },
    ]);
    const res = await markDuplicate(fetch, "tok", "dupe-id", "keeper-id");
    expect(res).toEqual({ success: true, issueRelationId: "rel-1", alreadyRelated: false });
    const mutationBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    expect(mutationBody.variables).toEqual({
      input: { issueId: "dupe-id", relatedIssueId: "keeper-id", type: "duplicate" },
    });
  });

  it("is idempotent: existing duplicate relation -> no create, alreadyRelated=true", async () => {
    const fetch = mockFetch([
      { data: { issue: { relations: { nodes: [
        { id: "rel-x", type: "duplicate", relatedIssue: { id: "keeper-id" } },
      ] } } } },
    ]);
    const res = await markDuplicate(fetch, "tok", "dupe-id", "keeper-id");
    expect(res).toEqual({ success: true, issueRelationId: "rel-x", alreadyRelated: true });
    expect(fetch).toHaveBeenCalledOnce(); // pre-check only, no mutation
  });

  it("rethrows non-duplicate API errors", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { issue: { relations: { nodes: [] } } } }) })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" }) as unknown as typeof fetch;
    await expect(markDuplicate(fetch, "tok", "d", "k")).rejects.toThrow(/Linear API error: 500/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter paperclip-plugin-linear test linear.spec`
Expected: FAIL — `markDuplicate` is not exported from `../src/linear.js`.

- [ ] **Step 3: Implement `markDuplicate`**

Add to `packages/plugins/paperclip-plugin-linear/src/linear.ts` immediately after `attachmentLinkURL` (after line 420):

```ts
/**
 * Mark `dupeLinearId` as a native Linear "duplicate" of `keeperLinearId`
 * (issueRelationCreate type: duplicate). Idempotent: pre-checks the dupe
 * issue's relations and no-ops if the duplicate→keeper relation already
 * exists, mirroring the duplicate-URL handling in attachmentLinkURL. Both
 * args are Linear internal issue IDs (resolve identifiers via
 * getIssueByIdentifier first).
 */
export async function markDuplicate(
  fetch: LinearFetch,
  token: string,
  dupeLinearId: string,
  keeperLinearId: string,
): Promise<{ success: boolean; issueRelationId: string | null; alreadyRelated: boolean }> {
  const existing = await gql<{
    issue: {
      relations: { nodes: Array<{ id: string; type: string; relatedIssue: { id: string } | null }> };
    } | null;
  }>(fetch, token, `
    query IssueRelations($id: String!) {
      issue(id: $id) {
        relations { nodes { id type relatedIssue { id } } }
      }
    }
  `, { id: dupeLinearId });

  const already = existing.issue?.relations.nodes.find(
    (r) => r.type === "duplicate" && r.relatedIssue?.id === keeperLinearId,
  );
  if (already) {
    return { success: true, issueRelationId: already.id, alreadyRelated: true };
  }

  try {
    const data = await gql<{
      issueRelationCreate: { success: boolean; issueRelation: { id: string } | null };
    }>(fetch, token, `
      mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
        issueRelationCreate(input: $input) {
          success
          issueRelation { id }
        }
      }
    `, { input: { issueId: dupeLinearId, relatedIssueId: keeperLinearId, type: "duplicate" } });
    return {
      success: data.issueRelationCreate.success,
      issueRelationId: data.issueRelationCreate.issueRelation?.id ?? null,
      alreadyRelated: false,
    };
  } catch (err) {
    // A concurrent create may have raced the pre-check. Treat an "already
    // exists / duplicate" error as success (idempotent); rethrow anything else.
    if (/already|duplicate/i.test(String(err))) {
      return { success: true, issueRelationId: null, alreadyRelated: true };
    }
    throw err;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter paperclip-plugin-linear test linear.spec`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/paperclip-plugin-linear/src/linear.ts \
        packages/plugins/paperclip-plugin-linear/tests/linear.spec.ts
git commit -m "feat(linear-plugin): add idempotent markDuplicate (issueRelationCreate type:duplicate)"
```

---

### Task 2: "Mark Linear Duplicate" tool (manual, ID-driven)

**Files:**
- Modify: `packages/plugins/paperclip-plugin-linear/src/constants.ts:20` (`TOOL_NAMES`)
- Modify: `packages/plugins/paperclip-plugin-linear/src/manifest.ts` (mirror the `TOOL_NAMES.link` tool block at 201–216)
- Modify: `packages/plugins/paperclip-plugin-linear/src/worker.ts` (add handler after the `unlink` register, ~line 920)
- Test: `packages/plugins/paperclip-plugin-linear/tests/plugin.spec.ts`

- [ ] **Step 1: Add the tool name constant**

In `constants.ts`, inside `TOOL_NAMES` (line 20), add:

```ts
  markDuplicate: "mark-duplicate",
```

- [ ] **Step 2: Add the manifest tool entry**

In `manifest.ts`, copy the `name: TOOL_NAMES.link` tool object (lines 201–216) and add a sibling entry, matching that block's exact field set:

```ts
    {
      name: TOOL_NAMES.markDuplicate,
      displayName: "Mark Linear Duplicate",
      description: "Mark one Linear issue as a native duplicate of another (issueRelation type: duplicate)",
      parametersSchema: {
        type: "object",
        properties: {
          dupeRef: { type: "string", description: "Linear identifier or URL of the DUPLICATE (e.g. the canceled twin), e.g. BLO-1184" },
          keeperRef: { type: "string", description: "Linear identifier or URL of the KEEPER issue, e.g. BLO-2167" },
        },
        required: ["dupeRef", "keeperRef"],
      },
    },
```

- [ ] **Step 3: Write the failing handler test**

In `plugin.spec.ts`, add a describe block. Invoke the tool the same way the existing `TOOL_NAMES.link` tool is exercised in this file (search for how `TOOL_NAMES.link` / the link tool is invoked via the harness; use that same invoker — e.g. `harness.invokeTool(TOOL_NAMES.markDuplicate, {...})`). Mirror the back-link test's module-mock of `../src/linear.js`:

```ts
describe("mark-duplicate tool", () => {
  it("resolves both refs and calls markDuplicate(dupeId, keeperId)", async () => {
    harness = createTestHarness({
      manifest,
      config: { linearClientId: "c", linearClientSecret: "s", teamId: "team-1" },
    });
    await plugin.definition.setup(harness.ctx);
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken }, "lin_token_123",
    );

    const linearMod = await import("../src/linear.js");
    (linearMod.getIssueByIdentifier as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: "lin-dupe", identifier: "BLO-1184", url: "u", state: { type: "canceled" } } as never)
      .mockResolvedValueOnce({ id: "lin-keep", identifier: "BLO-2167", url: "u", state: { type: "completed" } } as never);
    (linearMod.markDuplicate as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ success: true, issueRelationId: "rel-1", alreadyRelated: false } as never);

    // Use the same tool-invocation entrypoint plugin.spec.ts uses for TOOL_NAMES.link:
    const res = await harness.invokeTool(TOOL_NAMES.markDuplicate, { dupeRef: "BLO-1184", keeperRef: "BLO-2167" });

    expect(linearMod.markDuplicate).toHaveBeenCalledWith(
      expect.anything(), expect.any(String), "lin-dupe", "lin-keep",
    );
    expect(res.data).toMatchObject({ dupe: "BLO-1184", keeper: "BLO-2167", success: true });
  });

  it("returns a clear error when a ref does not resolve", async () => {
    // getIssueByIdentifier resolves null for the dupe -> handler returns an error result, markDuplicate NOT called.
    // (mirror the structure above; assert res.data.error is set and markDuplicate not called)
  });
});
```

> Note: replace `harness.invokeTool` with whatever the file already uses to drive `TOOL_NAMES.link` if the name differs — match the existing pattern exactly. Fill in the second test body mirroring the first (no placeholder at execution time).

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm --filter paperclip-plugin-linear test plugin.spec -t "mark-duplicate"`
Expected: FAIL — tool `mark-duplicate` not registered.

- [ ] **Step 5: Implement the tool handler**

In `worker.ts`, after the `TOOL_NAMES.unlink` register (ends ~line 920), add:

```ts
    ctx.tools.register(
      TOOL_NAMES.markDuplicate,
      { displayName: "Mark Linear Duplicate", description: "Mark one Linear issue as a native duplicate of another", parametersSchema: { type: "object", properties: { dupeRef: { type: "string", description: "Linear identifier/URL of the duplicate issue" }, keeperRef: { type: "string", description: "Linear identifier/URL of the keeper issue" } }, required: ["dupeRef", "keeperRef"] } },
      async (params) => {
        const { dupeRef, keeperRef } = params as { dupeRef: string; keeperRef: string };
        const dupe = linear.parseLinearIssueRef(dupeRef);
        const keeper = linear.parseLinearIssueRef(keeperRef);
        if (!dupe || !keeper) {
          return { content: "Error: invalid ref", data: { error: "Could not parse dupe/keeper Linear reference" } };
        }
        const token = await resolveToken(ctx);
        const fetch = ctx.http.fetch.bind(ctx.http);
        const dupeIssue = await linear.getIssueByIdentifier(fetch, token, dupe.identifier);
        const keeperIssue = await linear.getIssueByIdentifier(fetch, token, keeper.identifier);
        if (!dupeIssue) return { content: "Error: dupe not found", data: { error: `${dupe.identifier} not found` } };
        if (!keeperIssue) return { content: "Error: keeper not found", data: { error: `${keeper.identifier} not found` } };

        const config = await ctx.config.get();
        const bestEffort = config.linearBacklinkBestEffort === true;
        try {
          const res = await linear.markDuplicate(fetch, token, dupeIssue.id, keeperIssue.id);
          return {
            content: res.alreadyRelated
              ? `${dupe.identifier} already a duplicate of ${keeper.identifier}`
              : `Marked ${dupe.identifier} as duplicate of ${keeper.identifier}`,
            data: { ...res, dupe: dupe.identifier, keeper: keeper.identifier },
          };
        } catch (err) {
          if (bestEffort) {
            ctx.logger.warn("markDuplicate failed (best-effort)", { dupe: dupe.identifier, keeper: keeper.identifier, error: String(err) });
            return { content: "Warning: mark duplicate failed (best-effort)", data: { error: String(err), dupe: dupe.identifier, keeper: keeper.identifier } };
          }
          throw err;
        }
      },
    );
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm --filter paperclip-plugin-linear test plugin.spec -t "mark-duplicate"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/plugins/paperclip-plugin-linear/src/constants.ts \
        packages/plugins/paperclip-plugin-linear/src/manifest.ts \
        packages/plugins/paperclip-plugin-linear/src/worker.ts \
        packages/plugins/paperclip-plugin-linear/tests/plugin.spec.ts
git commit -m "feat(linear-plugin): add Mark Linear Duplicate tool (ID-driven, idempotent)"
```

---

### Task 3: Fire the Paperclip back-link on the webhook Issue.update path

**Files:**
- Modify: `packages/plugins/paperclip-plugin-linear/src/worker.ts` (Issue `update` webhook branch, ~line 1335)
- Test: `packages/plugins/paperclip-plugin-linear/tests/plugin.spec.ts`

Context: `writePaperclipBackLink` (worker.ts:101) already fires on the create path (813) and import path (1608) — verified via `plugin.spec.ts:688`. The gap is the **webhook Issue.update** path (`if (type === "Issue") { if (action === "update") {` at ~1335), where a mirror updated before `paperclipBaseUrl` was configured never gets a back-link. The helper is already idempotent (Linear dedupes the attachment by URL) and already respects `linearBacklinkBestEffort`, so the only change is an additional call.

- [ ] **Step 1: Write the failing test**

In `plugin.spec.ts`, add (mirror the back-link test at 688, but drive the webhook Issue.update handler instead of import; reuse that test's `vi.spyOn(harness.ctx.issues, ...)` + `attachmentLinkURL` module-mock setup):

```ts
describe("webhook Issue.update: Paperclip back-link", () => {
  it("fires attachmentLinkURL on update when paperclipBaseUrl is set and the issue is linked", async () => {
    // 1. harness with paperclipBaseUrl set + linearBacklinkBestEffort:true (as in the import test, 690-701)
    // 2. seed an existing link (sync.createLink or the STATE_KEYS.linkPrefix the import test relies on)
    // 3. clear the attachmentLinkURL mock
    // 4. deliver an Issue/update webhook (same webhook-delivery entrypoint plugin.spec.ts already uses for Issue webhooks)
    // 5. expect(attachmentLinkURL).toHaveBeenCalledOnce() with url https://paperclip.test/issues/<identifier>
  });
});
```

> Fill in steps 1–5 with the concrete harness calls used by the import back-link test (688) and the existing Issue-webhook tests in this file — no placeholder at execution time.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter paperclip-plugin-linear test plugin.spec -t "Issue.update: Paperclip back-link"`
Expected: FAIL — `attachmentLinkURL` not called on the update path.

- [ ] **Step 3: Add the call site**

In `worker.ts`, inside the `type === "Issue"` / `action === "update"` branch (~1335), after the mirror's Paperclip issue is updated and the link is in hand, add (using the same args shape as the create-path call at 813):

```ts
      // Backfill the Paperclip back-link on the update path too: idempotent
      // (Linear dedupes the attachment by URL) and best-effort by config. Covers
      // mirrors that predate paperclipBaseUrl or were only ever updated.
      await writePaperclipBackLink(
        ctx,
        token,
        link.linearIssueId,
        link.linearIdentifier,
        paperclipIdentifier,   // resolve from the updated Paperclip issue, as the create path does
        link.paperclipIssueId,
        paperclipTitle,        // same source the create path uses
      );
```

> Match the exact local variable names already in scope in this branch (e.g. `link`, the resolved Paperclip identifier/title). If `paperclipIdentifier`/`paperclipTitle` aren't already derived here, derive them the same way the create-path call site (around 805–813) does.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter paperclip-plugin-linear test plugin.spec -t "Issue.update: Paperclip back-link"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/paperclip-plugin-linear/src/worker.ts \
        packages/plugins/paperclip-plugin-linear/tests/plugin.spec.ts
git commit -m "feat(linear-plugin): write Paperclip back-link on webhook Issue.update path"
```

---

### Task 4: Bounded, resumable back-link backfill action

**Files:**
- Modify: `packages/plugins/paperclip-plugin-linear/src/constants.ts` (`ACTION_KEYS`, line 46) — add `backfillBackLinks: "backfill-backlinks"`
- Modify: `packages/plugins/paperclip-plugin-linear/src/manifest.ts` — declare the action (mirror an existing `ACTION_KEYS.triggerImport` action entry)
- Modify: `packages/plugins/paperclip-plugin-linear/src/worker.ts` — register the action handler
- Test: `packages/plugins/paperclip-plugin-linear/tests/plugin.spec.ts`

Behavior: page over Paperclip issues that have a `linear_issue_links` row (via `ctx.issues.list`, filtered to linked issues), and for each missing back-link call `writePaperclipBackLink`. Resumable via a state cursor (`STATE_KEYS` `backfill-cursor`); bounded per invocation (`maxPerRun`, default 100) with backoff between pages so Linear rate limits don't trip. Idempotent (the attachment dedupes by URL), so re-runs are safe.

- [ ] **Step 1: Write the failing test**

In `plugin.spec.ts`:

```ts
describe("backfill-backlinks action", () => {
  it("pages linked issues, calls writePaperclipBackLink once per linked issue, and is bounded", async () => {
    // harness with paperclipBaseUrl set; mock ctx.issues.list to return a page of linked issues
    // then an empty page; assert attachmentLinkURL called once per linked issue and the cursor advanced.
  });
  it("resumes from the saved cursor and stops at maxPerRun", async () => {
    // seed STATE_KEYS backfill cursor; assert the run starts after it and processes <= maxPerRun.
  });
});
```

> Fill in bodies using `vi.spyOn(harness.ctx.issues, "list")` (as the import test does at 715) and the `attachmentLinkURL` module-mock; drive via `harness.performAction(ACTION_KEYS.backfillBackLinks, { companyId: "comp-1" })`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter paperclip-plugin-linear test plugin.spec -t "backfill-backlinks"`
Expected: FAIL — action not registered.

- [ ] **Step 3: Add the constant + manifest entry**

`constants.ts` `ACTION_KEYS`: add `backfillBackLinks: "backfill-backlinks",`. In `manifest.ts`, add an action entry mirroring `ACTION_KEYS.triggerImport`'s declaration, with `parametersSchema` accepting optional `{ maxPerRun?: number }`.

- [ ] **Step 4: Implement the action handler**

In `worker.ts`, register the action (mirror the `triggerImport` action registration). Implementation:

```ts
    // Backfill: write the Paperclip back-link attachment for already-linked
    // issues that predate paperclipBaseUrl. Bounded + resumable + idempotent.
    ctx.actions.register(ACTION_KEYS.backfillBackLinks, async (params, runCtx) => {
      const companyId = runCtx.companyId;
      const config = await ctx.config.get();
      if (!(config.paperclipBaseUrl as string | undefined)?.trim()) {
        return { backfilled: 0, skipped: 0, note: "paperclipBaseUrl not set; nothing to do" };
      }
      const token = await resolveToken(ctx);
      const maxPerRun = Math.max(1, Number((params as { maxPerRun?: number })?.maxPerRun ?? 100));

      const cursorKey = { scopeKind: "instance" as const, stateKey: "backfill-cursor" };
      let cursor = (await ctx.state.get(cursorKey)) as string | undefined;

      let backfilled = 0;
      while (backfilled < maxPerRun) {
        const page = await ctx.issues.list({
          companyId,
          // Filter to issues that have a Linear link; page via cursor + a small limit.
          // Use the same list filters the plugin already uses to enumerate linked issues.
          linked: true,
          after: cursor,
          limit: Math.min(25, maxPerRun - backfilled),
        } as Parameters<typeof ctx.issues.list>[0]);
        if (!page.length) { cursor = undefined; break; } // swept clean -> reset cursor

        for (const issue of page) {
          const link = await sync.getLink(ctx, issue.id);
          if (!link) continue;
          await writePaperclipBackLink(
            ctx, token, link.linearIssueId, link.linearIdentifier,
            issue.identifier ?? null, issue.id, issue.title ?? null,
          );
          backfilled++;
          cursor = issue.id; // advance cursor for resumability
          if (backfilled >= maxPerRun) break;
        }
        await ctx.state.set(cursorKey, cursor ?? "");
        await new Promise((r) => setTimeout(r, 250)); // backoff between pages (Linear rate limits)
      }

      return { backfilled, done: cursor === undefined, cursor: cursor ?? null };
    });
```

> Confirm the exact `ctx.issues.list` filter for "has a linear link" against the host-service signature (`server/src/services/plugin-host-services.ts`); if there is no `linked` filter, enumerate all issues and skip those where `sync.getLink` returns null (the loop already guards with `if (!link) continue`). Confirm the action-registration API name (`ctx.actions.register` vs the pattern used by `ACTION_KEYS.triggerImport`) and match it.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter paperclip-plugin-linear test plugin.spec -t "backfill-backlinks"`
Expected: PASS.

- [ ] **Step 6: Run the whole plugin suite + commit**

Run: `pnpm --filter paperclip-plugin-linear test`
Expected: all green.

```bash
git add packages/plugins/paperclip-plugin-linear/
git commit -m "feat(linear-plugin): bounded resumable back-link backfill action"
```

---

## Self-Review

**1. Spec coverage**
- Back-link backfill — extend call sites → **Task 3** (webhook-update; create+import already exist per spec line 25 / test 688). Bounded backfill → **Task 4**. ✅
- `linear.ts: markDuplicate` (idempotent, error-path) → **Task 1**. ✅
- "Mark Linear Duplicate" action (ID-driven, unblocks the 6 twins) → **Task 2**. ✅
- Echo-loop guard [P1] — **verified, no code needed**: `registerWebhook` (linear.ts:125) subscribes to `["Issue","Comment","IssueLabel","Project"]`; `IssueRelation` is not subscribed (same reasoning as the Attachment-safe note at worker.ts:99). Documented here so the finding is closed.
- Best-effort error posture [P2] — Tasks 2 reuse `linearBacklinkBestEffort`. ✅
- **Auto path (spec §2) — NOT in this plan.** Requires (a) a migration to extend `issue_relations` CHECK beyond `'blocks'`, and (b) a server-side relation-create event the plugin can subscribe to (neither exists). Split to a follow-up plan (below). This is the one spec item intentionally deferred, with reasons.

**2. Placeholder scan** — Core implementation code (markDuplicate, the tool handler, the backfill loop, the back-link call) is complete. Three test bodies and two integration points are annotated as "match the existing sibling pattern in this file" with the exact sibling named (test 688, `TOOL_NAMES.link` invocation, `triggerImport` registration, `ctx.issues.list` filter) — the executor confirms the local API name against the named sibling rather than inventing one. These are integration-point confirmations, not logic placeholders.

**3. Type consistency** — `markDuplicate(fetch, token, dupeLinearId, keeperLinearId)` returns `{ success, issueRelationId, alreadyRelated }` and is referenced with that shape in Task 2's handler and tests. `TOOL_NAMES.markDuplicate = "mark-duplicate"` used consistently. `writePaperclipBackLink` arg order matches worker.ts:101 in Tasks 3 & 4.

## Follow-up plan (separate): duplicate auto-path

Create `docs/superpowers/specs/<date>-linear-duplicate-autopath.md` + plan covering the cross-package work:
1. **Migration** — new `packages/db/src/migrations/` file: `ALTER TABLE issue_relations DROP CONSTRAINT issue_relations_type_check; ADD CONSTRAINT ... CHECK (type IN ('blocks','duplicate'));` (+ regen drizzle).
2. **Relation-create API + event** — a server path to create an `issueRelations` row of type `duplicate` and emit an `issueRelation.created` platform event.
3. **Plugin subscription** — `ctx.events.on("issueRelation.created", ...)`: resolve both sides via `ctx.issues.getByLinearIssueId` (`plugin-host-services.ts:1681`), no-op if either lacks a `linear_issue_links` row, else call `linear.markDuplicate`. No title matching (D2).

---

**Plan complete and saved to `docs/superpowers/plans/2026-06-04-linear-paperclip-linkage.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
