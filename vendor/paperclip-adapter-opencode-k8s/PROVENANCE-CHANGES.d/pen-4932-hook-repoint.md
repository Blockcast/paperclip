# PEN-4932 — the pre-push preflight reads the BAKED hook, not the seeded one

Tracking: [PEN-4932](https://paperclip.blockcast.net/PEN/issues/PEN-4932)

**Files:** `src/server/github-git-hooks-path.ts`, `src/server/runtime-pin.ts`,
`src/server/runtime-pin.test.ts`

`BAKED_HOOKS_DIR` (`/usr/local/libexec/paperclip/hooks`) joins the existing
seeded-path constants, and `buildPrePushHookPreflightShell` resolves its
`__pchookrt` from it rather than from `DEFAULT_HOOKS_DIR`. The preflight has to
move in lockstep with the egress runtime it reports on: that runtime's
`hooksDirectory()` now returns the image copy, so a preflight still pointed at
the data volume would report `ok` on a pod whose runtime refuses every push —
the one direction this advisory check must never fail in, since its whole
purpose is time-to-diagnosis.

`__pchookmnt` is unchanged and still derives from `hooksDirForDataMount`, so the
seeded copy remains the diagnostic second path. That is what gives the
`OFF-MOUNT` verdict its new meaning: a hook on the volume and none in the image
is now an IMAGE-AGE fault — a pod running an agent image from before the bake,
or one whose `COPY --from=server` produced an empty directory — and the verdict
text says so rather than sending an operator to `persistence.mountPath`, which
the repoint retired as a cause. `MASKED` likewise now names the image first.
The verdict NAMES are deliberately unchanged: the shapes they report are the
same, and renaming them would break every fleet-wide grep written against them.

The constant is not derived from `DEFAULT_DATA_MOUNT_PATH`, because the point of
this path is that it is not on the data volume — an operator who relocates the
PVC has not relocated the image. The parity test against
`packages/adapter-utils/src/github-git-hooks-path.ts` holds the declaration
byte-identical with the canonical copy, as it does for the others.

Nothing here deletes the seeded hook or its mount; that is the step that drops
`ROOT_TOOLCHAIN_SUBPATHS`, and until it lands both copies exist and the chart
test pins them to the same body.
