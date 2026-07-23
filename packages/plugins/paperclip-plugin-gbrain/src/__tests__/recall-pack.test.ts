import { describe, it, expect } from "vitest";
import { brotliCompressSync } from "node:zlib";
import {
  packCacheEntry,
  unpackCacheEntry,
  type CachedRecall,
  type StoredRecall,
} from "../recall.js";

// A representative depth-2 graph: repetitive keys + slug prefixes, the shape
// brotli compresses well and that dominated plugin_state (BLO-17449).
function sampleGraph(nodeCount: number) {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    slug: `paperclip/issues/company-abc/BLO-${1000 + i}`,
    label: `Some issue title number ${i} with a fair bit of descriptive text`,
    kind: "issue",
    body: "lorem ipsum dolor sit amet ".repeat(20),
  }));
  const edges = nodes.slice(1).map((n, i) => ({
    from: nodes[i].slug,
    to: n.slug,
    rel: "relates_to",
  }));
  return { nodes, edges };
}

function okEntry(nodeCount = 50): CachedRecall {
  return {
    fetchedAtIso: "2026-07-22T00:00:00.000Z",
    issuePageSlug: "paperclip/issues/company-abc/BLO-1000",
    depth: 2,
    graph: sampleGraph(nodeCount),
    status: "ok",
    note: "traversed",
  };
}

describe("packCacheEntry / unpackCacheEntry", () => {
  it("round-trips the graph exactly (compress -> inflate)", () => {
    const entry = okEntry();
    const restored = unpackCacheEntry(packCacheEntry(entry));
    expect(restored).toEqual(entry);
  });

  it("keeps status (and metadata) top-level plaintext for the value_json->>'status' indexes", () => {
    const packed = packCacheEntry(okEntry());
    // status/metadata must be readable without decompressing — the partial
    // indexes and the RAG-health route select value_json->>'status' directly.
    expect(packed.status).toBe("ok");
    expect(packed.issuePageSlug).toBe("paperclip/issues/company-abc/BLO-1000");
    expect(packed.depth).toBe(2);
    // The fat graph must NOT be stored inline once compressed.
    expect(packed.graph).toBeUndefined();
    expect(typeof packed.graphZ).toBe("string");
    expect(packed.graphEnc).toBe("br");
  });

  it("compresses the graph well below the raw JSON size", () => {
    const entry = okEntry(200);
    const rawBytes = Buffer.byteLength(JSON.stringify(entry.graph), "utf8");
    const packed = packCacheEntry(entry);
    const storedBytes = Buffer.byteLength(packed.graphZ ?? "", "utf8");
    // Repetitive graph JSON should shrink dramatically; assert a conservative
    // 3x floor (real fleet data compresses far more).
    expect(storedBytes).toBeLessThan(rawBytes / 3);
  });

  it("stores a null graph inline without a graphZ blob", () => {
    const entry: CachedRecall = {
      fetchedAtIso: "2026-07-22T00:00:00.000Z",
      issuePageSlug: null,
      depth: 2,
      graph: null,
      status: "skipped",
      note: "no issue identifier on run",
    };
    const packed = packCacheEntry(entry);
    expect(packed.graphZ).toBeUndefined();
    expect(packed.graph).toBeNull();
    expect(unpackCacheEntry(packed)).toEqual(entry);
  });

  it("reads legacy rows that stored the graph inline (no graphZ)", () => {
    // A row written before compression shipped: plain CachedRecall shape.
    const legacy: StoredRecall = {
      fetchedAtIso: "2026-07-10T00:00:00.000Z",
      issuePageSlug: "paperclip/issues/company-abc/BLO-42",
      depth: 2,
      status: "ok",
      graph: sampleGraph(10),
    };
    const restored = unpackCacheEntry(legacy);
    expect(restored.graph).toEqual(legacy.graph);
    expect(restored.status).toBe("ok");
  });

  it("omits note when absent rather than emitting note: undefined", () => {
    const entry: CachedRecall = {
      fetchedAtIso: "2026-07-22T00:00:00.000Z",
      issuePageSlug: "paperclip/issues/company-abc/BLO-7",
      depth: 2,
      graph: sampleGraph(5),
      status: "ok",
    };
    const packed = packCacheEntry(entry);
    expect("note" in packed).toBe(false);
    expect("note" in unpackCacheEntry(packed)).toBe(false);
  });

  it("degrades a corrupt graphZ to status:error instead of throwing", () => {
    const packed = packCacheEntry(okEntry());
    // Valid base64 that is not a brotli stream — brotliDecompressSync throws.
    const corrupt: StoredRecall = {
      ...packed,
      graphZ: Buffer.from("not a brotli stream").toString("base64"),
    };
    const restored = unpackCacheEntry(corrupt);
    expect(restored.status).toBe("error");
    expect(restored.graph).toBeNull();
    expect(restored.note).toMatch(/could not be decompressed/);
    // Readable metadata survives.
    expect(restored.issuePageSlug).toBe(packed.issuePageSlug);
    expect(restored.depth).toBe(packed.depth);
  });

  it("degrades an unknown graphZ codec to status:error without decompressing", () => {
    const packed = packCacheEntry(okEntry());
    const future = { ...packed, graphEnc: "zstd" } as unknown as StoredRecall;
    const restored = unpackCacheEntry(future);
    expect(restored.status).toBe("error");
    expect(restored.graph).toBeNull();
    expect(restored.note).toMatch(/unknown graphZ codec/);
  });

  it("degrades a valid brotli stream whose payload isn't JSON to status:error", () => {
    // A realistic corruption case (bit-flip after compression that still inflates):
    // graphZ decompresses fine but JSON.parse throws. Shares the same try as the
    // decompress path but exercises the JSON.parse branch specifically.
    const packed = packCacheEntry(okEntry());
    const notJson: StoredRecall = {
      ...packed,
      graphZ: brotliCompressSync(Buffer.from("not json", "utf8")).toString("base64"),
    };
    const restored = unpackCacheEntry(notJson);
    expect(restored.status).toBe("error");
    expect(restored.graph).toBeNull();
    expect(restored.note).toMatch(/could not be decompressed/);
    expect(restored.issuePageSlug).toBe(packed.issuePageSlug);
  });

  it("degrades an over-cap inflating graphZ to status:error instead of OOMing", () => {
    // Brotli's ratio on repetitive input is extreme: 40MB of zeros compresses to
    // a few dozen bytes but inflates past the 32MB maxOutputLength cap, so
    // brotliDecompressSync throws a catchable ERR_BUFFER_TOO_LARGE rather than
    // allocating unbounded memory and crashing the worker. Guards BLO-17449's
    // never-throw guarantee for the corrupt/hostile-blob case.
    const packed = packCacheEntry(okEntry());
    const bomb: StoredRecall = {
      ...packed,
      graphZ: brotliCompressSync(Buffer.alloc(40 * 1024 * 1024)).toString("base64"),
    };
    const restored = unpackCacheEntry(bomb);
    expect(restored.status).toBe("error");
    expect(restored.graph).toBeNull();
    expect(restored.note).toMatch(/could not be decompressed/);
  });

  it("falls back to inline graph storage when compression throws (circular ref)", () => {
    // The write-side half of the fail-safe story: if JSON.stringify (or brotli)
    // throws, packCacheEntry must persist the graph inline rather than drop a
    // run's context. A circular reference makes JSON.stringify throw.
    const circular: Record<string, unknown> = { nodes: [], edges: [] };
    circular.self = circular;
    const entry = {
      fetchedAtIso: "2026-07-22T00:00:00.000Z",
      issuePageSlug: "paperclip/issues/company-abc/BLO-1000",
      depth: 2,
      graph: circular,
      status: "ok",
      note: "traversed",
    } as unknown as CachedRecall;
    const packed = packCacheEntry(entry);
    // Stored inline, uncompressed — no graphZ/graphEnc, graph preserved.
    expect(packed.graphZ).toBeUndefined();
    expect(packed.graphEnc).toBeUndefined();
    expect(packed.graph).toBe(circular);
    expect(packed.status).toBe("ok");
    // And it round-trips back through the legacy (inline) read path.
    expect(unpackCacheEntry(packed).graph).toBe(circular);
  });
});
