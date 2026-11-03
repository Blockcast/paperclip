# PEN-5336 — keep the resume-delta gate blind to execution-workspace warnings

Tracking: [PEN-5336](https://paperclip.blockcast.net/PEN/issues/PEN-5336) · PR: [#3313](https://github.com/Blockcast/paperclip/pull/3313)

**Files:** `src/server/job-manifest.ts`, `src/server/job-manifest.test.ts`

PEN-5336 made execution-workspace warnings ride the wake payload so they reach the agent's prompt. That forced a correction everywhere the resume-delta prompt was gated on `renderPaperclipWakePrompt(...).length > 0`: warnings render into that string and are frequently the **only** thing in it, so on a resumed session the old spelling replaces the **entire heartbeat prompt** with the warning. Delivering a warning would cost the run its instructions.

The gate here now strips `executionWorkspace.warnings` from a shallow copy of the payload and renders what is left (`wakePayloadWithoutWorkspaceWarnings`). That is correct under **either** adapter-utils by construction — under one the field is not read at all, under the other the stripped payload is exactly the pre-PEN-5336 input — and it compiles against the published types because it uses only `renderPaperclipWakePrompt`.

A hand-rolled reason/comments predicate (what the `claude_k8s` adapter uses, because that package has its own minimal renderer) was **rejected**: this package uses the SHARED renderer, whose non-emptiness depends on sixteen payload fields — issue, blockers, tree holds, checkbox selections, annotation deltas — so a local predicate would have silently changed this adapter's gate for all of them.

## ⛔ The premise that was wrong, recorded because it is load-bearing and easy to re-derive

The first revision of this PR left the old gate in place, reasoning: *"`package.json` pins a published `@paperclipai/adapter-utils` (`^2026.428.0`), which neither renders warnings nor keeps a warnings-only payload alive, so there is nothing here to suppress."*

**That premise is false for the shipped image, and the Ally review of [#3313](https://github.com/Blockcast/paperclip/pull/3313) caught it.** `Dockerfile:490` runs `npm install --no-save /vendor/adapter-utils.tgz` immediately after `npm ci`, and that tarball is packed from the **in-repo** `packages/adapter-utils` (`Dockerfile:436-463`); `Dockerfile:756` installs the same tarball beside the adapter at runtime. So the production opencode_k8s adapter resolves the new renderer, and the regression the comment said *could not happen here* would have shipped to the fleet's main pod adapter.

**The rule: this package's `package.json` dependency range describes what CI typechecks against, NOT what the image runs.** Check the Dockerfile before reasoning from the pin. The same split applies to `paperclip-adapter-claude-k8s`.

## ⚠️ Why the gate fix is tested through the helper, not through `buildJobManifest`

CI installs the **published** adapter-utils, which does not render warnings at all. A manifest-level *"warning-only resume keeps `heartbeatPromptChars > 0`"* assertion would therefore pass **vacuously** here — for the wrong reason, and it would keep passing if the strip were deleted. That is the same false-confidence shape PEN-5336 exists to remove, so it is not what was written.

`wakePayloadWithoutWorkspaceWarnings` is the part of the fix that behaves identically under either library, so the tests assert on it directly: the strip removes `warnings` and nothing else, a branch pin survives (it *is* a delta), the caller's payload is not mutated (the prompt text still needs the warnings), and non-payload inputs pass through. The claude_k8s package, whose renderer is local and therefore always current, carries the manifest-level assertion.
