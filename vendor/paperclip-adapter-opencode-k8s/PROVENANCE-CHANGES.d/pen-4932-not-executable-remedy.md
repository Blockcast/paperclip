# PEN-4932 — NOT-EXECUTABLE names a remedy the reader can actually carry out

Tracking: [PEN-4932](https://paperclip.blockcast.net/PEN/issues/PEN-4932)

**Files:** `src/server/runtime-pin.ts`, `src/server/runtime-pin.test.ts`

The `NOT-EXECUTABLE` verdict told its reader to *"restore +x on the seeded hook
— the mount is fine"*. The hook repoint is what made that false, and it made it
false in both halves of the sentence.

That arm fires on `$__pchookrt`, which is now `BAKED_HOOKS_DIR` rather than
`DEFAULT_HOOKS_DIR`. So the file it is talking about is the copy inside the
agent image — `root:root 0755`, laid down by `COPY --chmod=0755` — and not the
seeded copy at all. It names the wrong file, and it prescribes an action no
process in the pod can perform: the agent runs as uid 1000 and cannot `chmod` a
root-owned path in an image layer. "The mount is fine" is no longer a
distinction worth drawing either, because this verdict is now decided entirely
inside the image and says nothing about the mount in either direction.

This is the same defect class as the `OFF-MOUNT` text corrected in the repoint
itself, found by the reviewer on that PR rather than by me: a verdict naming a
remedy that cannot be performed. For a check whose only product is
time-to-diagnosis, sending the reader to a file they cannot change spends an
incident and returns nothing — the failure is quieter than a wrong verdict
name, which is why it survived the repoint.

The text now states what the pod can observe (the image carries the file
without an executable mode) and the remedy that follows from it (roll the image
forward), which is the remedy `OFF-MOUNT` already names. It cross-references
`OFF-MOUNT` alone, because `MASKED` names a diagnostic order rather than a
remedy — "the same one `MASKED` names" would have sent the reader to a line
where no remedy is written, which is a smaller instance of the defect this
change exists to remove. The verdict stays separate from `MASKED` because the
two send the reader to different places to look: `MASKED` means nothing is at
either path, while this means a file is there without its mode, which points at
the image build specifically.

The wording also stops short of naming the bake as the cause. `Dockerfile:695`
lays the hook down with `COPY --chmod=0755`, so a file arriving without `+x` is
more likely a bake from a different stage than a mode lost in this one. The
remedy is the same under either, so the verdict states the observation and
leaves the reader to tell them apart.

A third origin — a non-executable mount over the hooks directory — was
considered and is ruled out by measurement rather than by argument. Read from a
live agent pod on 2026-10-30: `findmnt -T /usr/local/libexec/paperclip/hooks`
resolves to `/` on `overlay`, and no mount target in the pod is at or under
that path, so nothing is mounted over `BAKED_HOOKS_DIR`. The only
hooks-related mount is the seeded `DEFAULT_HOOKS_DIR` copy at
`/paperclip/.local/share/paperclip-git-hooks`, which this arm no longer reads;
it is `ro`, and neither it nor the overlay root carries `noexec`. So "the image
build" is not a guess that happens to exclude the mount — it is what is left
once the mount is checked.

The verdict NAME is unchanged, as in the repoint and for the same reason: fleet
greps are written against the shapes, not the prose.

The test previously asserted `toContain("restore +x")`. It now pins the
image-roll remedy positively and the old instruction negatively, so the claim
cannot drift back to one the reader cannot act on. Positive control: reverting
only the verdict string turns exactly one test red, and it is this arm.

No behaviour changes — the arm fires on the same condition and reports the same
marker. This is the advisory text the repoint invalidated and deliberately
carried rather than pushing onto an already-attested head.
