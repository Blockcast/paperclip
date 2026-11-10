# `claudeCodeVersion` config field: no schema default

**Files:** `src/server/config-schema.ts`, `src/server/config-schema.test.ts`.

The field carried `default: DEFAULT_CLAUDE_CODE_VERSION`. The UI create form copies every field
default into `adapterSchemaValues` (`ui/src/adapters/schema-config-fields.tsx`), and those values
are saved into the agent's `adapterConfig`. So each `claude_k8s` agent hired through the UI was
saved with an explicit pin. Every later bump of `DEFAULT_CLAUDE_CODE_VERSION` then passed it by,
though `runtime-pin.ts` documents unset as "adapter-managed". The field now has no default. Its
hint names the current pin and says that leaving the field empty follows it.

No live agent needs a backfill: on 2026-11-10, 25 of the 26 `claude_k8s` agents had the field
unset, and one had it blank, which also resolves to the pin.
