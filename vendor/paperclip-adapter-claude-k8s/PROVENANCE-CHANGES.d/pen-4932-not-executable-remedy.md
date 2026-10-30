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

The text now states the cause (the bake delivered the file and dropped its
mode) and the remedy that follows from it (roll the image forward), which is
the same remedy `OFF-MOUNT` and `MASKED` already name. The verdict stays
separate from `MASKED` despite now sharing its remedy, because the two send the
reader to different places to look: `MASKED` means nothing is at either path,
while this means the bake produced a file and lost its mode, which points at
the image build specifically.

The verdict NAME is unchanged, as in the repoint and for the same reason: fleet
greps are written against the shapes, not the prose.

The test previously asserted `toContain("restore +x")`. It now pins the
image-roll remedy positively and the old instruction negatively, so the claim
cannot drift back to one the reader cannot act on. Positive control: reverting
only the verdict string turns exactly one test red, and it is this arm.

No behaviour changes — the arm fires on the same condition and reports the same
marker. This is the advisory text the repoint invalidated and deliberately
carried rather than pushing onto an already-attested head.
