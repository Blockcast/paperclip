# PEN-5336 — comment-only: record why this package keeps the old resume-delta gate

Tracking: [PEN-5336](https://paperclip.blockcast.net/PEN/issues/PEN-5336) · PR: [#3313](https://github.com/Blockcast/paperclip/pull/3313)

**Files:** `src/server/job-manifest.ts`

**No behaviour change — this entry records a deliberate omission so it is not read later as an oversight.**

PEN-5336 made execution-workspace warnings ride the wake payload so they reach the agent prompt, and that forced a correction everywhere the resume-delta prompt was gated on `renderPaperclipWakePrompt(...).length > 0`. Warnings now render into that string and are frequently the only thing in it, so on a resumed session the old spelling would replace the **entire heartbeat prompt** with the warning. Ten in-repo adapters moved onto a new shared predicate, `paperclipWakeHasResumeDeltaContent`.

This package did **not**, for two reasons:

1. **It has nothing to suppress yet.** Unlike `packages/adapters/*`, which resolve `@paperclipai/adapter-utils` by `workspace:*`, this package pins a **published** version (`^2026.428.0`). That build neither renders workspace warnings nor keeps a warnings-only payload alive, so `wakePrompt` here is unchanged by PEN-5336.
2. **Changing it would break this package's own CI.** `paperclipWakeHasResumeDeltaContent` does not exist in the published build; importing it fails `npx --no-install tsc --noEmit` in the `Vendored opencode_k8s adapter` job. This was measured, not assumed — the change was made, the typecheck failed with `TS2305: Module '"@paperclipai/adapter-utils/server-utils"' has no exported member`, and it was reverted to a comment.

⚠️ **The condition for changing it:** when this package's `@paperclipai/adapter-utils` dependency is bumped past the release carrying PEN-5336, change `shouldUseResumeDeltaPrompt` to `isResuming && paperclipWakeHasResumeDeltaContent(context.paperclipWake)`. Left as-is past that bump, a resumed run whose only wake content is a workspace warning silently loses its heartbeat prompt. The comment above the gate in `job-manifest.ts` says the same thing at the site.
