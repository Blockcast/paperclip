# Linear ↔ Paperclip linkage: back-link backfill + duplicate relations

**Date:** 2026-06-04
**Component:** `packages/plugins/paperclip-plugin-linear`
**Status:** design (brainstorming + /plan-eng-review)

## Problem

Two linkage gaps in the existing Linear OAuth plugin:

1. **Mapping back-link is create-only.** `writePaperclipBackLink` (worker.ts:101) writes a structured Linear *attachment* (the "field for Paperclip mapping") only when a Paperclip mirror is first created, and only when `paperclipBaseUrl` is configured. Issues synced before the config was set, or only ever updated, carry no back-link.
2. **No duplicate linkage.** Linear has accumulated same-title twin pairs (one canceled, one open) from a planning double-create — e.g. `BLO-1184` (Canceled) ↔ `BLO-2167` (Done). There is no programmatic way to mark `BLO-1184` as a native Linear "Duplicate of `BLO-2167`"; today the only option is a comment.

Linear has **no user-defined custom fields**, so the idiomatic mapping primitive is the **Attachment API** (already used) and the idiomatic dedupe primitive is the **duplicate issue relation** (`issueRelationCreate type: "duplicate"`, not yet used).

## Decisions (eng review)

- **D1 — Detection is mapping-driven, not blind title-search.** Rejected per-sync `searchIssues(same title)` (an API search per synced issue + same-title false positives, e.g. the real `NOP→NMP` rename). 
- **D2 — Duplicate source is ID-driven, no title heuristics anywhere.** The duplicate relationship originates from IDs we already hold (`linear_issue_links` / `issueRelations`), never inferred from titles.

## Design

### 1. Back-link backfill (always-on when `paperclipBaseUrl` set; safe)

- Extend the existing `writePaperclipBackLink` call sites so it also fires on the **import** and **webhook-update** paths, not just create. Idempotent: Linear dedupes attachments by URL (linear.ts:380-383 already handles duplicate-URL).
- One-time **bounded backfill** action: page over Paperclip issues that have a `linear_issue_links` row, write the mapping attachment where missing. Rate-limit aware (paged + backoff), resumable.

### 2. Duplicate relation (ID-driven)

```
Paperclip side                         Linear side
──────────────                         ───────────
issueRelations (type=duplicate)        issueRelationCreate(type:"duplicate",
  dupePclIssue ──┐                        issueId:     <dupe linear id>,
                 │  linear_issue_links     relatedIssueId: <keeper linear id>)
  keeperPclIssue─┘  (getByLinearIssueId)
        │                                        ▲
        └────── push on relation create ─────────┘
  "Mark Linear Duplicate" action ───────────────┘   (manual, for orphan twins)
```

- **`linear.ts: markDuplicate(dupeLinearId, keeperLinearId)`** → `issueRelationCreate(type:"duplicate")`. **Idempotent**: query existing relations (or catch the "already related" error) → no-op if present. Mirrors the duplicate-URL handling already in `attachmentLinkURL`.
- **New "Mark Linear Duplicate" action** (mirrors the existing `Link`/`Unlink Linear Issue` actions, manifest.ts:202/218, constants.ts:22-23). Input: dupe + keeper (Paperclip or Linear ids). Used to mark the 6 known twins now.
- **Auto path:** when a Paperclip `issueRelations` row of type `duplicate` is created, resolve both sides via `getByLinearIssueId` and push `markDuplicate`. No-op when either side has no `linear_issue_links`. No title matching.
- **Config:** reuse `linearBacklinkBestEffort` semantics (or add `linearDuplicateBestEffort`) so a failed relation push warns rather than failing the sync.

## Eng-review findings (fold into implementation)

- **[P1] Idempotency** — `issueRelationCreate` on an existing relation must no-op, not error/duplicate. Check-then-create or catch "already exists". (confidence 8/10)
- **[P1] Echo-loop guard** — `registerWebhook` (linear.ts) subscribes to `{Issue, Comment, IssueLabel, Project}`. **Verify a relation change does not re-fire an Issue webhook** that loops back. If it can, guard it (the attachment path is safe per worker.ts:99 because Attachment isn't subscribed; relations are not attachments). (confidence 6/10 — must verify)
- **[P2] Error posture** — reuse best-effort flag so linkage failures don't break sync.
- **[P2] Backfill paging** — scope the sweep to issues missing the attachment; page + backoff for Linear rate limits; resumable.
- **Scope/auth** — `write` scope already in `LINEAR_OAUTH` (constants.ts:95). No new scope.

## Test plan

```
linear.ts: markDuplicate
  [GAP] relates dupe→keeper (issueRelationCreate type:duplicate)
  [GAP] idempotent: already-related → no-op, not error
  [GAP] error path → best-effort warn vs throw
worker.ts: writePaperclipBackLink (extended)
  [★★ TESTED create] plugin.spec.ts:688 (paperclipBaseUrl gating)
  [GAP] fires on import path (idempotent / dedupe by URL)
  [GAP] fires on webhook-update path
worker.ts: backfill sweep
  [GAP] pages synced issues, skips ones already attached
  [GAP] rate-limit backoff, resumable
worker.ts: duplicate push (Paperclip issueRelation duplicate → Linear)
  [GAP] resolves both sides via getByLinearIssueId
  [GAP] no-op when either side lacks a linear_issue_link
  [GAP→E2E] Paperclip dup-relation → relation appears in Linear
action: "Mark Linear Duplicate"
  [GAP→E2E] operator marks BLO-1184 dup-of BLO-2167 → relation in Linear
  [GAP] invalid/unknown issue id → clear error
```

## NOT in scope

- Blind same-title Linear search (rejected D1/D2 — false positives).
- Auto-archiving/deleting the canceled twins (the duplicate relation is the linkage; Linear already shows state — we don't delete).
- Content merge between duplicates.
- A Linear custom field (Linear has none; attachment metadata is the mechanism).

## What already exists (reused)

- `writePaperclipBackLink` (worker.ts:101) + `attachmentLinkURL` (linear.ts:385) — back-link with metadata attributes; dedupe by URL.
- `Link`/`Unlink Linear Issue` actions (manifest.ts:202/218) — pattern for the new action.
- `issueRelations` table — Paperclip-side relations (blocker/escalation today; reuse for duplicate).
- `linear_issue_links` / `getByLinearIssueId` (server/src) — the canonical mapping.
- `LINEAR_OAUTH` `write` scope (constants.ts:95).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | N/A |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | skipped (context budget) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 2 arch decisions resolved (D1 mapping-driven, D2 ID-driven); 4 findings folded into spec; 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | N/A (backend plugin) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | N/A |

- **Step 0:** scope reduced — rejected blind same-title auto-detection (D1); ID-driven only (D2).
- **Findings folded into the spec:** [P1] idempotent `issueRelationCreate`; [P1] verify no relation→webhook echo-loop; [P2] best-effort error posture; [P2] paged/rate-limited backfill.
- **NOT in scope / What exists / Test diagram:** written above.
- **UNRESOLVED:** 0.
- **VERDICT:** ENG CLEARED — ready to implement (`/writing-plans`). Outside-voice pass skipped under context budget; recommend running it before merge.

