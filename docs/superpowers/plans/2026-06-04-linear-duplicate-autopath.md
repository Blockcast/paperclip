# Linear Duplicate Auto-Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When a Paperclip `issueRelations` row of type `duplicate` is created, automatically push a native Linear duplicate relation (via the already-shipped `markDuplicate`) — ID-driven, no title matching.

**Architecture:** This is the cross-package server-side half of the linkage feature (the plugin-side manual path shipped in PR #301). Three layers: (1) a DB migration so `issue_relations.type` accepts `'duplicate'`; (2) a server path that creates a duplicate relation and emits a plugin event through the existing `plugin-event-bus`; (3) a plugin subscription that resolves both Paperclip issues → Linear ids via `sync.getLink` and calls `linear.markDuplicate`, no-op when either side isn't linked.

**Tech Stack:** Drizzle migrations (`packages/db`), the server plugin-event-bus (`server/src/services/plugin-event-bus.ts`), the Linear plugin (`packages/plugins/paperclip-plugin-linear`), Vitest.

**Prereqs already shipped (PR #301):** `linear.markDuplicate(fetch, token, dupeLinearId, keeperLinearId)` (idempotent), the `Mark Linear Duplicate` tool, and `sync.getLink(ctx, paperclipIssueId)` → `{ linearIssueId, linearIdentifier, ... } | null`.

---

## Key correction vs. the original spec

The design sketch said "resolve both sides via `getByLinearIssueId`." That's the **wrong direction** for a Paperclip-originated relation: the relation row holds **Paperclip** issue ids, so each side resolves **Paperclip → Linear** via `sync.getLink(ctx, paperclipIssueId)` (`getByLinearIssueId` is Linear → Paperclip). This plan uses `sync.getLink`.

## File Structure

| File | Change |
|---|---|
| `packages/db/src/migrations/00NN_*.sql` (+ snapshot) | **Create** — extend `issue_relations_type_check` to `IN ('blocks','duplicate')` |
| `packages/db/src/schema/issue_relations.(ts|js)` | **Modify** if the type/check is encoded in the schema (keep drizzle + SQL in sync) |
| `server/src/routes/issues.ts` | **Modify** — duplicate-relation create path + emit a plugin event (model on the `issue.updated` emit at ~2431 and the blocks-relation query at ~2376) |
| `server/src/services/plugin-event-bus.ts` | **Modify if needed** — register/allow the new `issueRelation.created` event type |
| `packages/plugins/paperclip-plugin-linear/src/worker.ts` | **Modify** — `ctx.events.on("issueRelation.created", ...)` handler |
| tests (server route test + `plugin.spec.ts`) | **Add** |

---

### Task 1: Migration — allow `issue_relations.type = 'duplicate'`

**Files:** new `packages/db/src/migrations/00NN_<name>.sql` (+ regenerate the drizzle snapshot/journal); `packages/db/src/schema/issue_relations.*` if the CHECK is declared there.

- [ ] **Step 1:** Inspect the current constraint + schema.
  Run: `grep -rn "issue_relations_type_check\|type.*blocks" packages/db/src` — confirm migration `0049_flawless_abomination.sql:13` has `CHECK ("type" IN ('blocks'))` and find how `schema/issue_relations` declares `type`.
- [ ] **Step 2:** Generate the migration the project's way (do NOT hand-author if drizzle-kit is used). If the schema's `type` column carries the check, update it to allow `'duplicate'`, then run the repo's migration-generate script (e.g. `pnpm --filter @paperclipai/db generate` — confirm the exact script in `packages/db/package.json`). The generated SQL must be equivalent to:
  ```sql
  ALTER TABLE "issue_relations" DROP CONSTRAINT "issue_relations_type_check";
  ALTER TABLE "issue_relations" ADD CONSTRAINT "issue_relations_type_check" CHECK ("type" IN ('blocks','duplicate'));
  ```
- [ ] **Step 3:** Apply to a scratch/test DB and confirm a `duplicate` row inserts and an invalid type still rejects. Run the repo's migrate command (confirm in package.json).
- [ ] **Step 4:** Commit.
  ```bash
  git add packages/db/src/migrations packages/db/src/schema/issue_relations.*
  git commit -s -m "feat(db): allow issue_relations.type='duplicate'"
  ```
  > Note: magma-style DCO isn't enforced here, but `-s` is harmless. Match this repo's convention.

---

### Task 2: Server — create duplicate relation + emit `issueRelation.created`

**Files:** `server/src/routes/issues.ts` (+ `plugin-event-bus.ts` if the event type must be registered); server route test.

Confirm-points before coding (read these):
- The `issue.updated` **emit** call at `server/src/routes/issues.ts:2431` — copy its event-emit helper + payload shape for the new event.
- The blocks-relation **query** at `issues.ts:2376-2382` — copy its `issueRelations` table-op style + company scoping.
- `server/src/services/plugin-event-bus.ts` — confirm whether new event `action` values need registration/allow-listing, and the exact event envelope (`{ action, entityId, payload, companyId, ... }`).

- [ ] **Step 1 (test-first):** Add a server route test: creating a `duplicate` relation between two issues in a company (a) inserts the `issueRelations` row (`type:"duplicate"`, idempotent on the (company, issue, relatedIssue, type) tuple) and (b) emits a plugin event `{ action: "issueRelation.created", payload: { issueId, relatedIssueId, type: "duplicate" } }`. Assert via the same harness existing issues-route tests use to capture emitted plugin events.
- [ ] **Step 2:** Run → fails.
- [ ] **Step 3:** Implement the create-or-reuse of the `duplicate` relation row + the emit, mirroring the `issue.updated` emit at :2431 and the relation query at :2376. Idempotent: skip insert if the (company, issueId, relatedIssueId, type) row exists; still emit (or skip emit on no-op — pick the behavior the plugin handler tolerates; the plugin push is itself idempotent so emitting on no-op is safe). Expose it via the route shape the codebase uses for relations (confirm whether to extend an existing relations endpoint or add one).
- [ ] **Step 4:** Run → passes. **Echo-loop check:** confirm emitting `issueRelation.created` does not re-enter a path that re-creates the relation (the plugin only pushes to Linear; it must not write back a Paperclip relation).
- [ ] **Step 5:** Commit (`feat(server): create duplicate issue relation + emit issueRelation.created`).

---

### Task 3: Plugin — subscribe and push `markDuplicate`

**Files:** `packages/plugins/paperclip-plugin-linear/src/worker.ts`; `tests/plugin.spec.ts`.

- [ ] **Step 1 (test-first):** In `plugin.spec.ts`, add a test that delivers an `issueRelation.created` event (`payload: { issueId: dupePclId, relatedIssueId: keeperPclId, type: "duplicate" }`) and asserts: `sync.getLink` resolves both Paperclip ids → linear ids, then `linear.markDuplicate` is called with `(dupeLinearId, keeperLinearId)`. Add a second test: when either side's `getLink` is null → `markDuplicate` NOT called (no-op). Mirror the webhook/event test setup already in the file; `markDuplicate` is module-mocked (already in the `vi.mock("../src/linear.js")` factory from PR #301).
- [ ] **Step 2:** Run → fails (no handler).
- [ ] **Step 3:** Implement, near the other `ctx.events.on(...)` handlers (e.g. after the `issue.updated` handler ~worker.ts:926):
  ```ts
  ctx.events.on("issueRelation.created", async (event) => {
    const payload = event.payload as { issueId?: string; relatedIssueId?: string; type?: string } | undefined;
    if (!payload || payload.type !== "duplicate") return;
    if (payload.source === "linear") return; // guard: never echo a Linear-originated change
    const dupePclId = payload.issueId;
    const keeperPclId = payload.relatedIssueId;
    if (!dupePclId || !keeperPclId) return;

    const dupeLink = await sync.getLink(ctx, dupePclId);
    const keeperLink = await sync.getLink(ctx, keeperPclId);
    if (!dupeLink || !keeperLink) return; // no-op when either side isn't linked to Linear

    const config = await ctx.config.get();
    const bestEffort = config.linearBacklinkBestEffort === true;
    try {
      const token = await resolveToken(ctx);
      await linear.markDuplicate(
        ctx.http.fetch.bind(ctx.http), token,
        dupeLink.linearIssueId, keeperLink.linearIssueId,
      );
    } catch (err) {
      if (bestEffort) {
        ctx.logger.warn("auto markDuplicate push failed", { dupePclId, keeperPclId, error: String(err) });
      } else {
        throw err;
      }
    }
  });
  ```
  > Confirm the event payload field names against what Task 2 emits (align `issueId`/`relatedIssueId`). Confirm `sync.getLink` arg + the link field `linearIssueId`. Match the `payload.source` guard convention used by the existing `issue.updated`/`issue.created` handlers (worker.ts:932/965).
- [ ] **Step 4:** Run → passes; full plugin suite green.
- [ ] **Step 5:** Commit (`feat(linear-plugin): auto-push markDuplicate on issueRelation.created`).

---

## Self-Review checklist (run after implementing)
- Migration is generated the repo's way (not hand-authored) and round-trips (`duplicate` inserts, invalid rejects).
- Event field names match between Task 2 (emit) and Task 3 (consume).
- Idempotency holds end-to-end: duplicate relation row is dedup'd; `markDuplicate` is idempotent; re-emitting is safe.
- Echo-loop: a Linear-originated duplicate (if a webhook path ever creates one) does not loop back into a Paperclip relation create → re-emit. The `payload.source === "linear"` guard + the fact that the plugin only pushes (never writes a Paperclip relation) closes this.
- No title matching anywhere (D2).

## Then
Once all three tasks land + the plugin redeploys, marking a Paperclip duplicate relation auto-creates the Linear duplicate — the manual `Mark Linear Duplicate` tool (PR #301) remains for orphan twins with no Paperclip relation.
