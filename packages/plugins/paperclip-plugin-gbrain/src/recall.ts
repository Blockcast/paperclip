// Wave 2.2 recall path.
//
// On `agent.run.started`, traverse the gbrain graph from the issue page
// (depth=2 by default) and cache the result in plugin state keyed by
// runId. The agent reads it back via the `gbrain_recall_cache` tool —
// no second MCP round-trip per agent run.
//
// Why pre-fetch instead of let the agent traverse on-demand: each agent
// run does many MCP calls already; one cached read is much cheaper than
// teaching every agent to call traverse_graph itself, and lets the
// agent get the graph context "for free" at run start without
// remembering to ask.
//
// Tradeoff: stale-by-the-time-it's-read. If the run mutates gbrain
// (e.g. wave 1's retain at run end) and another tool re-reads after,
// the cache is the snapshot from run.started, not whatever the latest
// mutations are. Acceptable for "starting context" use cases; agents
// that need current state should call traverse_graph directly.

import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from "node:zlib";
import type { GbrainCallable } from "./pages.js";
import { agentSlug, issueSlug, projectSlug } from "./identity.js";

export const RECALL_STATE_KEY = "gbrain-context";
export const DEFAULT_RECALL_DEPTH = 2;

export interface PrefetchInput {
  client: GbrainCallable;
  issueIdentifier: string | null;
  companyId?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  projectId?: string | null;
  projectNameOrKey?: string | null;
  depth: number;
  enrichmentFallback?: boolean;
}

export interface PrefetchResult {
  ok: boolean;
  issuePageSlug: string | null;
  graph: unknown | null;
  reason?: string;
}

interface TraversalCandidate {
  slug: string;
  label: string;
}

export type CachedRecallStatus =
  | "ok"
  | "no-issue-page"
  | "empty"
  | "island"
  | "skipped"
  | "error";

/**
 * Fetch a depth-N traversal of the issue page from gbrain, ready to be
 * stashed under the run scope. Returns ok=false (with a reason) when
 * there's nothing useful to cache — caller should still write the
 * result to state so the tool handler can return a meaningful "no
 * context" payload instead of a state-miss surprise.
 */
export async function prefetchRunContext(input: PrefetchInput): Promise<PrefetchResult> {
  const { client, issueIdentifier, depth } = input;
  if (!issueIdentifier) {
    return { ok: false, issuePageSlug: null, graph: null, reason: "no issue identifier on run" };
  }
  const slug = issueSlug(issueIdentifier);
  if (!slug) {
    return { ok: false, issuePageSlug: null, graph: null, reason: "issue identifier did not yield a slug" };
  }
  const safeDepth = Math.max(1, depth);
  try {
    const graph = await traverseGraph(client, slug, safeDepth);
    if (graph === null || graph === undefined) {
      // gbrain returns null for missing pages — first run on a brand-new
      // issue. Not an error; just nothing in the graph yet.
      return await maybeFallback(input, slug, null, "issue page does not exist yet", safeDepth);
    }
    const classification = classifyGraphShape(graph);
    if (classification.status === "ok") {
      return { ok: true, issuePageSlug: slug, graph };
    }
    return await maybeFallback(
      input,
      slug,
      graph,
      classification.note ?? `issue graph classified as ${classification.status}`,
      safeDepth,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, issuePageSlug: slug, graph: null, reason: `traverse_graph failed: ${msg}` };
  }
}

async function traverseGraph(client: GbrainCallable, slug: string, depth: number): Promise<unknown> {
  return await client.call("traverse_graph", { slug, depth });
}

async function maybeFallback(
  input: PrefetchInput,
  issuePageSlug: string,
  issueGraph: unknown | null,
  issueReason: string,
  depth: number,
): Promise<PrefetchResult> {
  if (input.enrichmentFallback === false) {
    return { ok: true, issuePageSlug, graph: issueGraph, reason: issueReason };
  }

  for (const candidate of fallbackCandidates(input)) {
    try {
      const fallbackGraph = await traverseGraph(input.client, candidate.slug, depth);
      if (fallbackGraph === null || fallbackGraph === undefined) continue;
      if (classifyGraphShape(fallbackGraph).status !== "ok") continue;
      return {
        ok: true,
        issuePageSlug,
        graph: mergeGraphs(issueGraph, fallbackGraph),
        reason: `${issueReason}; enriched with ${candidate.label} graph ${candidate.slug}`,
      };
    } catch {
      // Fallback enrichment is opportunistic; preserve the original issue-page result.
    }
  }

  return { ok: true, issuePageSlug, graph: issueGraph, reason: issueReason };
}

function fallbackCandidates(input: PrefetchInput): TraversalCandidate[] {
  const seen = new Set<string>();
  const candidates: TraversalCandidate[] = [];
  const add = (slug: string | null | undefined, label: string) => {
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    candidates.push({ slug, label });
  };

  add(agentSlug(input.agentName), "agent");
  if (input.companyId && input.agentId) {
    add(`paperclip/agents/${input.companyId}/${input.agentId}`, "agent");
  }
  add(projectSlug(input.projectNameOrKey), "project");
  if (input.companyId && input.projectId) {
    add(`paperclip/projects/${input.companyId}/${input.projectId}`, "project");
  }
  return candidates;
}

function mergeGraphs(primary: unknown | null, fallback: unknown): unknown {
  if (primary === null || primary === undefined) return fallback;
  if (Array.isArray(primary) && primary.length === 0) return fallback;

  if (Array.isArray(primary) && Array.isArray(fallback)) {
    return dedupeByStableString([...primary, ...fallback]);
  }

  if (isRecord(primary) && isRecord(fallback)) {
    const primaryNodes = Array.isArray(primary.nodes) ? primary.nodes : [];
    const fallbackNodes = Array.isArray(fallback.nodes) ? fallback.nodes : [];
    const primaryEdges = Array.isArray(primary.edges) ? primary.edges : [];
    const fallbackEdges = Array.isArray(fallback.edges) ? fallback.edges : [];
    return {
      ...fallback,
      ...primary,
      nodes: dedupeByStableString([...primaryNodes, ...fallbackNodes]),
      edges: dedupeByStableString([...primaryEdges, ...fallbackEdges]),
    };
  }

  return { issueGraph: primary, enrichmentGraph: fallback };
}

function dedupeByStableString(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const value of values) {
    const key = stableString(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function stableString(value: unknown): string {
  if (value === undefined) return "undefined";
  if (!isRecord(value)) return JSON.stringify(value);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = value[key];
  return JSON.stringify(sorted);
}

export interface CachedRecall {
  fetchedAtIso: string;
  issuePageSlug: string | null;
  depth: number;
  /** Non-null when prefetch reached an existing page. */
  graph: unknown | null;
  /** "ok" only when the traversal found a real neighborhood. */
  status: CachedRecallStatus;
  /** Free-form context for the agent reading the cache. */
  note?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayPropLength(value: Record<string, unknown>, key: string): number | null {
  const prop = value[key];
  return Array.isArray(prop) ? prop.length : null;
}

function classifyGraphShape(graph: unknown): { status: CachedRecallStatus; note?: string } {
  if (Array.isArray(graph)) {
    if (graph.length === 0) {
      return { status: "empty", note: "traverse_graph returned an empty graph" };
    }
    if (graph.length === 1) {
      return { status: "island", note: "traverse_graph returned only the issue page" };
    }
    return { status: "ok" };
  }

  if (!isRecord(graph)) {
    return {
      status: "empty",
      note: "traverse_graph returned an unrecognized empty graph shape",
    };
  }

  const nodeCount = arrayPropLength(graph, "nodes");
  const edgeCount = arrayPropLength(graph, "edges");
  if (nodeCount !== null) {
    if (nodeCount === 0) {
      return { status: "empty", note: "traverse_graph returned zero nodes" };
    }
    if (nodeCount === 1 || edgeCount === 0) {
      return { status: "island", note: "traverse_graph returned no edges from the issue page" };
    }
    return { status: "ok" };
  }

  if (edgeCount !== null) {
    if (edgeCount === 0) {
      return { status: "island", note: "traverse_graph returned no edges" };
    }
    return { status: "ok" };
  }

  return { status: "empty", note: "traverse_graph returned an unrecognized graph shape" };
}

export function buildCacheEntry(input: {
  result: PrefetchResult;
  depth: number;
  nowIso?: string;
}): CachedRecall {
  const fetchedAtIso = input.nowIso ?? new Date().toISOString();
  if (!input.result.ok) {
    const status = input.result.issuePageSlug ? "error" : "skipped";
    return {
      fetchedAtIso,
      issuePageSlug: input.result.issuePageSlug,
      depth: input.depth,
      graph: null,
      status,
      note: input.result.reason,
    };
  }
  if (input.result.graph === null || input.result.graph === undefined) {
    return {
      fetchedAtIso,
      issuePageSlug: input.result.issuePageSlug,
      depth: input.depth,
      graph: null,
      status: "no-issue-page",
      note: input.result.reason,
    };
  }
  const classification = classifyGraphShape(input.result.graph);
  return {
    fetchedAtIso,
    issuePageSlug: input.result.issuePageSlug,
    depth: input.depth,
    graph: input.result.graph,
    status: classification.status,
    note: input.result.reason ?? classification.note,
  };
}

// --- On-disk compression (BLO-17449) -------------------------------------
//
// The cached `graph` neighborhood is by far the largest thing this plugin
// persists: ~640KB of JSON on average, up to ~6MB, one row per agent run. At
// fleet volume that made `gbrain-context` ~9.5GB — the dominant consumer of
// the control-plane Postgres and thus of the nightly pg_dump (BLO-17421).
//
// Postgres only pglz-compresses the TOASTed value (~2x on this JSON). Brotli
// does far better on the repetitive graph shape (repeated keys, slug prefixes,
// edge structure), so we brotli+base64 the graph into `graphZ` before writing
// and inflate it on read. Everything else stays top-level PLAINTEXT — in
// particular `status`, which both the five `value_json->>'status'` partial
// indexes and the RAG-health aggregation route read directly; compressing it
// would break those. Shrinking the stored value also speeds that health
// aggregation, which must detoast each row just to read `status`.
//
// Base64 costs ~33% over the raw brotli bytes, but JSONB cannot hold binary and
// a bytea column would mean a framework/schema change for one plugin; net win is
// still ~70-80% vs the pglz-stored size.

/** Brotli quality for graph compression. 6 keeps even a 6MB graph fast on the
 *  run-start path while capturing nearly all of brotli's ratio on JSON. */
const GRAPH_BROTLI_QUALITY = 6;
/** Codec tag on graphZ; gates future codec changes (only brotli today). */
const GRAPH_CODEC = "br" as const;
/** Hard cap on the inflated graph size on the read path. Brotli's ratio on the
 *  repetitive graph shape is extreme (50MB of zeros -> 89 bytes), so a corrupt,
 *  truncated, or bit-flipped graphZ could otherwise force brotliDecompressSync
 *  to allocate arbitrarily much and OOM-kill the worker *before* the try/catch
 *  below can run — defeating unpackCacheEntry's never-throw guarantee. Sized at
 *  ~5x the documented ~6MB max graph so every legitimate row inflates cleanly
 *  while a hostile blob throws a catchable ERR_BUFFER_TOO_LARGE instead. */
const GRAPH_MAX_INFLATED_BYTES = 32 * 1024 * 1024;

/**
 * On-disk form of {@link CachedRecall}: identical metadata, but the fat `graph`
 * is replaced by `graphZ` (brotli+base64). Legacy rows written before this
 * change carry an inline `graph` and no `graphZ`; {@link unpackCacheEntry}
 * reads both. `status` is always present and top-level for the indexes.
 */
export interface StoredRecall {
  fetchedAtIso: string;
  issuePageSlug: string | null;
  depth: number;
  status: CachedRecallStatus;
  note?: string;
  /** Non-null only in legacy (pre-compression) rows, or when graph was null. */
  graph?: unknown | null;
  /** brotli+base64 of JSON.stringify(graph); present when a graph was cached. */
  graphZ?: string;
  /** Codec for graphZ. */
  graphEnc?: typeof GRAPH_CODEC;
}

/**
 * Compress a CachedRecall for persistence. A null/undefined graph is stored
 * inline as `graph: null` (nothing to compress). If compression unexpectedly
 * throws, fall back to storing the graph inline so a run never loses its
 * context to a codec error.
 */
export function packCacheEntry(entry: CachedRecall): StoredRecall {
  const base: StoredRecall = {
    fetchedAtIso: entry.fetchedAtIso,
    issuePageSlug: entry.issuePageSlug,
    depth: entry.depth,
    status: entry.status,
    ...(entry.note !== undefined ? { note: entry.note } : {}),
  };
  if (entry.graph === null || entry.graph === undefined) {
    return { ...base, graph: null };
  }
  try {
    const json = JSON.stringify(entry.graph);
    const graphZ = brotliCompressSync(Buffer.from(json, "utf8"), {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: GRAPH_BROTLI_QUALITY },
    }).toString("base64");
    return { ...base, graphZ, graphEnc: GRAPH_CODEC };
  } catch {
    // Never drop context over a compression failure — persist it uncompressed.
    return { ...base, graph: entry.graph };
  }
}

/**
 * Inverse of {@link packCacheEntry}. Handles both compressed rows (graphZ) and
 * legacy inline-graph rows, so it is safe to deploy before old rows age out.
 *
 * Fails safe symmetrically with packCacheEntry: an unreadable graphZ — corrupt
 * or truncated bytes (bad restore, partial write) or a codec a future writer
 * introduced that this reader doesn't recognize — degrades to a status:"error"
 * entry carrying the still-readable metadata, rather than throwing synchronously
 * out of the gbrain_recall_cache tool handler.
 */
export function unpackCacheEntry(stored: StoredRecall | CachedRecall): CachedRecall {
  const s = stored as StoredRecall;
  const meta = {
    fetchedAtIso: s.fetchedAtIso,
    issuePageSlug: s.issuePageSlug,
    depth: s.depth,
    status: s.status,
    ...(s.note !== undefined ? { note: s.note } : {}),
  };
  if (s.graphZ === undefined) {
    // Legacy / null-graph row: graph (if any) is stored inline.
    return { ...meta, graph: (s as CachedRecall).graph ?? null };
  }
  // graphEnc actually gates the codec: only brotli is understood today, so an
  // unrecognized value means a newer writer used a codec this reader can't
  // inflate — degrade instead of feeding foreign bytes to brotliDecompressSync.
  if (s.graphEnc !== undefined && s.graphEnc !== GRAPH_CODEC) {
    return degradedRecall(s, `unknown graphZ codec "${String(s.graphEnc)}"`);
  }
  try {
    const json = brotliDecompressSync(Buffer.from(s.graphZ, "base64"), {
      maxOutputLength: GRAPH_MAX_INFLATED_BYTES,
    }).toString("utf8");
    return { ...meta, graph: JSON.parse(json) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return degradedRecall(s, `cached gbrain-context graph could not be decompressed: ${msg}`);
  }
}

/** A read-side failure result: keep the readable metadata, drop the graph, and
 *  mark status "error" with the reason so the tool consumer sees a meaningful
 *  "no context" payload instead of a thrown exception. */
function degradedRecall(s: StoredRecall, reason: string): CachedRecall {
  return {
    fetchedAtIso: s.fetchedAtIso,
    issuePageSlug: s.issuePageSlug,
    depth: s.depth,
    graph: null,
    status: "error",
    note: reason,
  };
}
