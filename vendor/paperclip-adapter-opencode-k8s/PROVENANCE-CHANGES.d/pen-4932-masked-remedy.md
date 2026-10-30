# PEN-4932 — MASKED stops sending the reader to a mount that is absent by design

Tracking: [PEN-4932](https://paperclip.blockcast.net/PEN/issues/PEN-4932) · raised by review on
`Blockcast/paperclip#3139` at `ad2cdc6d`

**Files:** `src/server/runtime-pin.ts`, `src/server/runtime-pin.test.ts`

The `MASKED` verdict told its reader that

> a narrowed Job pod sees an overlay over the PVC so `ROOT_TOOLCHAIN_SUBPATHS` against
> `/proc/mounts` is the check, not the seed log

and its doc block opened by asserting the verdict means *"both planes are broken at once"*. Both
statements are false here, and they were false in this adapter before #3139 rather than because of
it: `opencode_k8s`'s `job-manifest.ts` contains no `ROOT_TOOLCHAIN_SUBPATHS` and has never bound the
git-hooks dir, so an opencode pod's seeded copy was already unreachable. The text was carried over
from `claude_k8s`, where the constant does exist, and it named a check this adapter cannot perform.

This is the `NOT-EXECUTABLE` defect of `pen-4932-not-executable-remedy.md` in the adjacent verdict:
*a verdict naming a remedy the reader cannot act on*. The cost is the same and it is the only thing
this preflight sells — time-to-diagnosis. An operator who follows the old line inspects
`/proc/mounts`, finds no hooks bind, and reasonably concludes that the missing bind is the fault.
It is not; it is the intended state, and the real fault — an agent image from before the bake — is
in the one place the line never sent them.

The string now names the image build first, states that the seeded copy is unreachable by design,
says that hunting the bind in `/proc/mounts` leads nowhere, and gives the remedy `OFF-MOUNT` and
`NOT-EXECUTABLE` already give: roll the image forward. Because one fault now suffices to produce the
verdict, the doc block's "both planes are broken at once" is dropped too.

**Kept byte-identical with `claude_k8s`.** Both adapters emit the same `MASKED` and `NOT-EXECUTABLE`
strings and both preflights read the same `BAKED_HOOKS_DIR`; the hashes matched before this edit and
match after it. The replacement is worded to be true in both — "since PEN-4932 none is created"
rather than "since PEN-4932 emptied `ROOT_TOOLCHAIN_SUBPATHS`", which would be accurate for the
claude adapter and false for this one.

**Pinned, with a stated positive control.** The MASKED test asserted
`toContain("ROOT_TOOLCHAIN_SUBPATHS")` under a comment reading "it must send the reader at the
mount" — it defended the defect. It now pins `check the image build`, `unreachable BY DESIGN` and
`roll the image forward`, and asserts the old directive is absent. Restoring the previous string
turns exactly that test red and nothing else.

**Re-verified after this edit:** `tsc --noEmit` clean; vendored opencode suite **750/750** on the
pinned `vitest ^4.1.5` (`runtime-pin.test.ts` included).
