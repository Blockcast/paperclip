import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * PEN-2370 ask 3, criteria (b1) + (b2).
 *
 * `packages/mcp-gateway/src/response-scrub.ts` strips secret material out of
 * proxied MCP responses, and `server.ts` calls it unconditionally so that every
 * upstream *behind the gateway* is covered without anyone remembering to opt in.
 * That is a good chokepoint. It is also only a chokepoint for traffic that
 * actually traverses the gateway.
 *
 * The agents' shared `.mcp.json` is seeded by the statefulset init script below,
 * and — as of this commit — none of its upstreams go through the gateway. They
 * dial their backing Services directly. So the scrubber protects a path the
 * agents do not use, while reading like fleet-wide coverage. That gap sat
 * unnoticed for five days behind a merged, tested, correct scrubber.
 *
 * This test does not close the gap; moving traffic is operator-tier work tracked
 * on PEN-2429. What it does is make the gap *enumerated* instead of implicit:
 * every seeded upstream must be consciously classified as covered, structurally
 * un-proxyable, or uncovered-with-a-ticket. A new upstream added tomorrow fails
 * here until someone decides which it is — an allowlist, so the unpredicted case
 * fails closed rather than joining the uncovered set in silence.
 *
 * ## ⚠️ Scope boundary — read before citing this file as coverage
 *
 * An agent's *effective* MCP config is not the seed. It is
 *
 *     { ...sharedSeedBaseline, ...adapterConfig.mcpServers }
 *
 * merged in `vendor/paperclip-adapter-claude-k8s/src/server/job-manifest.ts` and
 * shipped to the Job pod with `--strict-mcp-config`. This file audits the **first
 * half only**. The second half is per-agent, lives in the database rather than in
 * this repo, and no static test can enumerate its contents.
 *
 * That half is the *more* dangerous one. Per-agent entries override the baseline
 * by name, and the documented use of the mechanism is precisely to swap the
 * read-only k8s upstream for **ns-rw or admin** (job-manifest.ts:1219-1221). Those
 * are direct `http`/`sse` URLs; nothing routes them through the gateway either.
 * So an unscrubbed, *higher*-privileged agent-facing upstream can be added by
 * editing a DB row, touching no file in this repo and leaving this suite green.
 *
 * Per PEN-2370's "⛔ no fourth scrubber ticket", that axis is not a new row — it
 * is tracked on PEN-2429 alongside the seeded upstreams, and it is named here so
 * it is enumerated rather than invisible. What this file *can* enforce is that the
 * merge topology still matches the sentence above: `assertMergeTopologyUnchanged`
 * fails if the baseline stops being merged, if the override direction flips, or if
 * a gateway hop appears — any of which would make this audit describe a world that
 * no longer exists. Do not read a green run here as "every agent-facing upstream
 * is accounted for". It means: every *seeded* one is, and the per-agent axis is
 * still shaped the way this comment claims.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const statefulSetPath = path.join(repoRoot, "deploy/helm/paperclip/templates/statefulset.yaml");
const jobManifestPath = path.join(
  repoRoot,
  "vendor/paperclip-adapter-claude-k8s/src/server/job-manifest.ts",
);

/**
 * Hosts that terminate inside `paperclip-mcp-gateway`, where `scrubResponseBody`
 * runs. Empty today and that is the finding, not an oversight: keeping the list
 * explicit means the day an upstream is moved behind the gateway, flipping it to
 * `gateway-scrubbed` is a one-line change that this file forces to be deliberate.
 */
const SCRUBBING_GATEWAY_HOSTS: readonly string[] = [];

type Coverage =
  /** Response bodies pass through `scrubResponseBody` in the gateway. */
  | { kind: "gateway-scrubbed" }
  /** stdio transport: no HTTP hop exists for a proxy to sit on. */
  | { kind: "stdio-not-proxied"; why: string }
  /** Direct HTTP to the backing Service. Agent-visible bodies are NOT scrubbed. */
  | { kind: "unscrubbed"; ticket: string; why: string };

/**
 * The classification of every upstream in the seeded `mcpServers` block.
 *
 * Keep this exhaustive. If you are here because the suite failed after you added
 * an MCP server, that is this test working: choose a `kind` for it and say why.
 */
const SEED_COVERAGE: Readonly<Record<string, Coverage>> = {
  paperclip: {
    kind: "stdio-not-proxied",
    why: "in-process stdio bridge to paperclip's own tools; no network hop to interpose on",
  },
  github: {
    kind: "stdio-not-proxied",
    why: "github-mcp-server runs as a local stdio child process",
  },
  prometheus: {
    kind: "unscrubbed",
    ticket: "PEN-2429",
    why: "direct to prometheus-mcp-server; metric bodies are low-risk but still unscrubbed",
  },
  tempo: {
    kind: "unscrubbed",
    ticket: "PEN-2429",
    why: "direct to tempo.monitoring; trace attributes can carry request headers",
  },
  linear: {
    kind: "unscrubbed",
    ticket: "PEN-2429",
    why: "direct to linear-mcp-server; issue bodies are externally authored text",
  },
  gbrain: {
    kind: "unscrubbed",
    ticket: "PEN-2429",
    why: "shell-interpolated entry; both shapes dial gbrain directly, and the admin shape carries a minted Authorization header",
  },
  "k8s-ro": {
    kind: "unscrubbed",
    ticket: "PEN-2429",
    why: "THE PEN-2370 exposure: pods_get/resources_get return spec.containers[].env in the clear, and this dials the readonly Service directly, bypassing the gateway the scrubber lives in",
  },
};

type SeedEntry = { type?: string; url?: string; command?: string; args?: string[] };

/**
 * Extract the `mcpServers` JSON the init script heredocs into `.mcp.json`.
 *
 * The heredoc is shell, not JSON: it interpolates `${MCP_BRIDGE_JS}` inside a
 * string and `${GBRAIN_ENTRY}` in bare value position. Both are replaced with a
 * `<shell:NAME>` sentinel so the block parses, which keeps this test honest about
 * entries whose concrete value is only known at pod boot — they still have to be
 * classified.
 */
function readSeededMcpServers(): Record<string, SeedEntry | string> {
  const source = readFileSync(statefulSetPath, "utf8");
  const marker = 'cat > "${MCP_FILE}" <<EOF';
  const markerAt = source.indexOf(marker);
  if (markerAt < 0) {
    throw new Error(
      `Could not find the shared MCP seed heredoc (${marker}) in ${statefulSetPath}. ` +
        "If the seed moved, point this test at its new home rather than deleting it — " +
        "PEN-2370 exists because this coverage gap was invisible.",
    );
  }
  const bodyStart = source.indexOf("\n", markerAt) + 1;
  const bodyEnd = source.indexOf("\n              EOF", bodyStart);
  if (bodyEnd < 0) throw new Error("shared MCP seed heredoc is not terminated as expected");

  const normalised = source
    .slice(bodyStart, bodyEnd)
    // bare value position: `"gbrain": ${GBRAIN_ENTRY}` -> a quoted sentinel
    .replace(/:\s*\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ': "<shell:$1>"')
    // remaining interpolations are already inside quotes
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, "<shell:$1>");

  const parsed = JSON.parse(normalised) as { mcpServers?: Record<string, SeedEntry | string> };
  if (!parsed.mcpServers) throw new Error("shared MCP seed has no mcpServers block");
  return parsed.mcpServers;
}

function hostOf(entry: SeedEntry | string): string | null {
  if (typeof entry === "string" || !entry.url) return null;
  if (entry.url.startsWith("<shell:")) return null;
  return new URL(entry.url).hostname;
}

/**
 * The seed is only half of what an agent actually gets. Pin the other half's
 * *shape* — not its contents, which are per-agent DB rows this test cannot see.
 *
 * Each probe encodes one clause of the scope-boundary comment at the top of this
 * file. If a clause stops being true, the comment has become a lie about the
 * system and the classification table below may be auditing the wrong surface —
 * so fail loudly and directly at the reader who changed it, rather than staying
 * green while describing a world that no longer exists.
 */
function assertMergeTopologyUnchanged(): void {
  let source: string;
  try {
    source = readFileSync(jobManifestPath, "utf8");
  } catch {
    throw new Error(
      `Could not read ${jobManifestPath}. This audit's scope boundary is stated in terms of the ` +
        "per-agent MCP merge that lives there. If the adapter moved, re-point this probe and " +
        "re-check whether adapterConfig.mcpServers can still add an unscrubbed agent-facing upstream.",
    );
  }

  const probes: readonly { needle: RegExp; clause: string }[] = [
    {
      needle: /\{\s*\.\.\.baselineMcpServers,\s*\.\.\.perAgentMcpServers\s*\}/,
      clause:
        "the shared seed is merged as the baseline and per-agent entries override it by name " +
        "(so auditing the seed alone is a partial audit, and per-agent entries can replace a " +
        "seeded upstream with a higher-privileged one)",
    },
    {
      needle: /--strict-mcp-config/,
      clause:
        "the merged file is the only MCP config the agent reads, so this seed is genuinely " +
        "load-bearing rather than shadowed by something else on disk",
    },
  ];

  for (const { needle, clause } of probes) {
    if (!needle.test(source)) {
      throw new Error(
        `The per-agent MCP merge in ${path.relative(repoRoot, jobManifestPath)} no longer matches ` +
          `this audit's stated scope boundary. Expected to find evidence that ${clause}.\n` +
          "Update the scope-boundary comment at the top of this file to describe what is now true, " +
          "and re-check whether the classification table still covers the right surface. " +
          "PEN-2370 exists because a scrubber kept passing while the traffic moved out from under it.",
      );
    }
  }

  // The per-agent axis must stay ungatewayed for the boundary comment to hold. If
  // a gateway hop appears here, that is good news — but this file then understates
  // coverage, and SEED_COVERAGE/SCRUBBING_GATEWAY_HOSTS need revisiting.
  //
  // Matched case-insensitively and across separator styles, because the first
  // draft of this check looked for the literal `mcp-gateway` and sailed straight
  // past a mutation that introduced `routeThroughMcpGateway(...)`. A detector that
  // only catches one spelling is the denylist shape PEN-2370 (b2) exists to reject.
  const gatewayReference = /mcp[-_ ]?gateway|scrubResponseBody/i;
  if (gatewayReference.test(source)) {
    throw new Error(
      `${path.relative(repoRoot, jobManifestPath)} now references the MCP gateway or the scrubber. ` +
        "This audit assumes per-agent upstreams are dialed directly and unscrubbed. Re-derive the " +
        "classifications above before assuming the assumption still holds.",
    );
  }
}

describe("agent-facing MCP seed is audited for scrub coverage (PEN-2370 b1/b2)", () => {
  const seeded = readSeededMcpServers();

  it("classifies every seeded upstream — a new one fails closed until it is triaged", () => {
    const seededNames = Object.keys(seeded).sort();
    const classifiedNames = Object.keys(SEED_COVERAGE).sort();

    const unclassified = seededNames.filter((n) => !(n in SEED_COVERAGE));
    const stale = classifiedNames.filter((n) => !(n in seeded));

    expect(
      unclassified,
      `New MCP upstream(s) in the shared seed with no scrub classification: ${unclassified.join(", ")}.\n` +
        "Add each to SEED_COVERAGE in this file. Pick one:\n" +
        "  - gateway-scrubbed   : it is routed through paperclip-mcp-gateway (also add the host to SCRUBBING_GATEWAY_HOSTS)\n" +
        "  - stdio-not-proxied  : stdio transport, so no HTTP hop exists to interpose on\n" +
        "  - unscrubbed         : direct HTTP; agent-visible bodies are NOT scrubbed. Name the ticket tracking it.\n" +
        "This is PEN-2370 ask 3: the point is that nobody adds an unscrubbed agent-facing upstream by accident.",
    ).toEqual([]);

    expect(
      stale,
      `SEED_COVERAGE classifies upstream(s) that are no longer seeded: ${stale.join(", ")}. Remove them so this audit cannot rot.`,
    ).toEqual([]);
  });

  it("every 'unscrubbed' classification names a real tracking ticket", () => {
    for (const [name, coverage] of Object.entries(SEED_COVERAGE)) {
      if (coverage.kind !== "unscrubbed") continue;
      expect(
        coverage.ticket,
        `Upstream '${name}' is classified unscrubbed but its ticket '${coverage.ticket}' is not a PEN-/BLO- id. ` +
          "An uncovered agent-facing upstream must be tracked somewhere, or it is just an untracked hole.",
      ).toMatch(/^(PEN|BLO)-\d+$/);
      expect(coverage.why.length, `Upstream '${name}' needs a non-trivial rationale`).toBeGreaterThan(20);
    }
  });

  it("anything claimed as gateway-scrubbed actually resolves to a scrubbing gateway host", () => {
    for (const [name, coverage] of Object.entries(SEED_COVERAGE)) {
      if (coverage.kind !== "gateway-scrubbed") continue;
      const host = hostOf(seeded[name]!);
      expect(
        host && SCRUBBING_GATEWAY_HOSTS.includes(host),
        `Upstream '${name}' is classified gateway-scrubbed but dials '${host}', which is not in SCRUBBING_GATEWAY_HOSTS. ` +
          "A response scrubber that is not on the path scrubs nothing — that is exactly the PEN-2370 failure.",
      ).toBe(true);
    }
  });

  it("anything claimed as stdio-not-proxied really has no HTTP hop", () => {
    for (const [name, coverage] of Object.entries(SEED_COVERAGE)) {
      if (coverage.kind !== "stdio-not-proxied") continue;
      const entry = seeded[name]!;
      expect(typeof entry === "string" ? undefined : entry.url, `Upstream '${name}' claims stdio but declares a url`).toBeUndefined();
      expect(typeof entry === "string" ? undefined : entry.command, `Upstream '${name}' claims stdio but declares no command`).toBeDefined();
    }
  });

  it("records that the k8s-ro exposure is still open, so closing it must update this file", () => {
    // Pins the specific instance PEN-2370 was filed for. When PEN-2429 moves this
    // traffic behind the scrubber, this assertion fails and forces the
    // classification to be corrected in the same change that fixes the topology.
    const k8sRo = SEED_COVERAGE["k8s-ro"];
    expect(k8sRo.kind).toBe("unscrubbed");
    expect(hostOf(seeded["k8s-ro"]!)).toBe("kubernetes-mcp-server-readonly.paperclip.svc.cluster.local");
  });

  it("the per-agent override axis this audit does NOT cover is still shaped as documented", () => {
    // Guards the scope-boundary comment at the top of the file. The seed is half
    // of what an agent gets; the other half is per-agent adapterConfig.mcpServers,
    // which can swap k8s readonly for ns-rw/admin without touching this repo.
    // We cannot enumerate that half — but we can make its shape a tested claim, so
    // a topology change trips here instead of silently invalidating the audit.
    expect(() => assertMergeTopologyUnchanged()).not.toThrow();
  });
});
