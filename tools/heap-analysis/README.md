# heap-analysis — reading a worker `.heapsnapshot`

Offline tooling for the snapshots written by `server/src/services/heap-snapshot.ts`
(PEN-3631). Nothing here runs in production or is imported by the server; it is
run by hand against a file on the shared claim.

**Read `doc/DEVELOPING.md` → "A snapshot is a credential, not a diagnostic" first.**
These files are secret-bearing, and so is anything you derive from them.

```sh
node --max-old-space-size=4096 summarize.mjs <file.heapsnapshot> > summary.json
node report.mjs summary.json                 # baseline view of one snapshot
node report.mjs snapA.json snapB.json        # A -> B diff (growers / shrinkers)
node --max-old-space-size=6144 retainers.mjs <file.heapsnapshot> --list
node --max-old-space-size=6144 retainers.mjs <file.heapsnapshot> \
     --select "closure|native_bind" --samples 150 --depth 6 --top 5
```

| file | what it answers |
|---|---|
| `redact.mjs` | the one redaction contract — import it, do not re-implement it |
| `summarize.mjs` | streams the file (far too large for `JSON.parse`) and aggregates count + `self_size` per `(node type, constructor name)` |
| `report.mjs` | **what** is on the heap, or what grew between two summaries |
| `retainers.mjs` | **what retains it** — builds the reverse edge index and walks sampled nodes upward |

`--select "<type>|<name>"`; for string-ish nodes pass the `#hash8` that
`report.mjs` prints, e.g. `--select "string|#f4cd7070"`. Lower `--depth` (2–3)
aggregates the sample into fewer, coarser paths; raise it to see the full owning
structure.

`retainers.mjs` is a GREEDY upward walk, not a BFS to a GC root, and that is
deliberate: measured on a real snapshot, one module's `code` node carried 25,207
retainers, so a BFS explodes into the shared script graph and every sampled node
comes back unresolved. Attribution needs the owning container, not the root. The
walk stops and prints `(shared: N retainers)` rather than inventing a path.

## Reading the output

`<string, 1024ch, #hash>` — **1024ch is V8's own truncation cap on string names
in the snapshot format, NOT the real length and NOT the redaction.** One observed
snapshot held a single such string whose `self_size` was 25.1 MB (it was the
source text of a bundled module, held by an `internal source` edge — a fixed
module-load cost, not an accumulation). **Judge size by `self_size`, never by the
`ch` count.**

A single snapshot names *what is on the heap*; it cannot name *what is
accumulating*. Only a diff of two can, and only if both come from the same
process generation — see the pid caveat below.

## Security

In a `.heapsnapshot` a string node's **name is its contents**. `redact.mjs`
reduces every string payload to `<type, Nch, #sha256-8>`, and any non-string name
over 256 chars to `<redacted, Nch, #sha256-8>` — an over-long "identifier" is the
shape a payload arrives in. Constructor names below that are program identifiers
and are kept, because they are what makes a path legible.

**Edge names are the exception, and `redactEdgeName()` is a separate test for
them.** A `property` edge on a dictionary-mode object carries the *key string*,
not an identifier, so a DSN or a token keyed into a plain object is short enough
to pass every rule above — the measured `postgres://` URIs were 19–58 chars.
`retainers.mjs` therefore runs `property` and `context` edge names through an
identifier-shape test and hashes anything that fails it. That costs legibility on
legitimate non-identifier keys (`content-type`); the hash still separates
distinct paths. Every *other* edge type names a V8 slot (`internal source`,
`bindings`) and is kept verbatim — those are what make a retainer path readable.

**`summarize.mjs` applies it before anything reaches disk, and that placement is
the fix for a real defect, not a style preference.** The original version redacted
at *report* time, so its `summary.json` carried every string payload verbatim —
45 JWTs and 3 credentialed `postgres://` URIs in one 30 MB file — in a directory
the worker's retention sweep does not govern. `doc/DEVELOPING.md` carries the
measurement. `redactName()` is idempotent, so `report.mjs` prints identical bytes
for a redacted summary and a pre-fix raw one.

Do not remove it, do not publish raw names, and do not copy snapshots off the
claim.

## ⛔ Check the generation before you diff

Two snapshots from different process lifetimes produce a clean, confident,
meaningless diff. `restartCount` **will not** tell you — a replaced *pod* reads
`restartCount: 0`, and this has fired twice. The free check is the **pid stamped
into the snapshot filename**; corroborate with the pod uid, the `deployed-commit`
annotation, or two disjoint Prometheus `instance` series for the same pod name.

## ⛔ What this instrument cannot see

`v8.writeHeapSnapshot()` profiles the **V8 heap only**. On the generation measured
2026-10-13 the container working set was 2481.5 MB against
`nodejs_heap_size_total_bytes` 773.9 MB and `nodejs_external_memory_bytes`
60.7 MB — roughly **981 MB of native / off-heap retention that no snapshot can
reach**, and the snapshot itself measured 585.9 MB of self size, about 24% of the
footprint.

That is why PEN-3314's growth investigation moved off this instrument (PEN-3314 §5,
2026-10-12). Before reaching for a heap pair, check `process_resident_memory_bytes`
minus `nodejs_heap_size_total_bytes` minus `nodejs_external_memory_bytes`: if the
growth lives there, a heap diff will measure the wrong megabytes very precisely.
