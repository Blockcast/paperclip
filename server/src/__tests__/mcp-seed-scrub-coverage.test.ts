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
 *
 * ⚠️ This list is the audit's *oracle*, and it is hand-maintained — which host
 * names actually terminate in the gateway is deployment topology that lives in
 * `Blockcast/onprem-k8s`, not in this repo, so no test here can derive it. What
 * the assertions below give you is a binding between a classification and the
 * host it dials. What they cannot give you is proof that a host is or is not a
 * gateway. Concretely: a migration that adds a host here and forgets to reclassify
 * the upstream fails loudly; a migration that reclassifies nothing *and* never
 * touches this list is invisible to this file. So updating this list is part of
 * doing the migration, not paperwork after it.
 *
 * That obligation is written down on PEN-2370 as a rollout checklist item naming
 * PEN-2429 (the ticket that performs the migration), rather than only here — an
 * operator changing topology in `Blockcast/onprem-k8s` has no reason to be
 * reading a test file in this repo, and a note only they will never see is not a
 * control. The in-repo half is enforced rather than trusted: the rollout's last
 * step flips the `k8s-ro` URL in `statefulset.yaml`, which is in this repo, so it
 * trips the host assertion below and cannot land while this audit still describes
 * the old topology.
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
 *
 * `ticket` is the upstream's *owner*, and one ticket per upstream is deliberate.
 * The first version of this table pointed all five unscrubbed upstreams at
 * PEN-2429; PEN-2429's owner rejected that (2026-08-27) and re-homed three of
 * them, because PEN-2429 is `critical` for the `k8s-ro` credential-escalation
 * shape specifically and parking four upstreams of unassessed severity behind it
 * would have delayed the critical fix behind the others. Do not re-collapse these
 * onto one ticket to make the table tidier — the tidiness is what caused it.
 *
 * Note also what `unscrubbed` claims: it is a statement about the **transport**,
 * not a finding about the **contents**. It means nothing scrubs these bodies, not
 * that anything sensitive is known to be in them. Assessing the contents of
 * `prometheus`/`tempo`/`linear` is PEN-2630's (b1) audit and is still open, so
 * their rationales below say "unassessed" rather than guessing at a severity.
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
    ticket: "PEN-2630",
    why: "direct to prometheus-mcp-server; unassessed — whether any metric label or exemplar in this estate carries secret material is the (b1) audit question, not a settled 'low risk'",
  },
  tempo: {
    kind: "unscrubbed",
    ticket: "PEN-2630",
    why: "direct to tempo.monitoring; unassessed — span attributes can carry request headers, so what these bodies actually disclose needs demonstrating rather than assuming",
  },
  linear: {
    kind: "unscrubbed",
    ticket: "PEN-2630",
    why: "direct to linear-mcp-server; unassessed — issue and comment bodies are agent-authored text, which has historically contained material agents should not have pasted",
  },
  gbrain: {
    kind: "unscrubbed",
    ticket: "PEN-2428",
    why: "shell-interpolated entry; both shapes dial gbrain directly, and the admin shape carries a minted Authorization header for the shared paperclip:Blockcast:CEO OAuth client that PEN-2428 owns",
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
 * Every URL that appears literally in a chunk of the init script, split into the
 * ones we can pin to a host and the ones we cannot.
 *
 * Anything still carrying an unexpanded `${VAR}` / `<shell:VAR>` is reported as
 * *unresolved* rather than guessed at. Callers treat a non-empty `unresolved` as
 * a failure: an upstream whose host is not knowable from this repo cannot be
 * asserted to be off the gateway, and "cannot tell" must not read as "fine".
 */
function urlsIn(text: string): { hosts: string[]; unresolved: string[] } {
  const hosts: string[] = [];
  const unresolved: string[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s"'`\\)]+/g)) {
    const raw = match[0]!;
    if (raw.includes("${") || raw.includes("<shell:")) {
      unresolved.push(raw);
      continue;
    }
    try {
      hosts.push(new URL(raw).hostname);
    } catch {
      unresolved.push(raw);
    }
  }
  return { hosts, unresolved };
}

/**
 * The right-hand side of every `VAR=` assignment in the init script, with shell
 * line-continuations followed so a multi-line `$( ... )` is captured whole.
 *
 * This is a text scan, not a shell parser — deliberately. It only has to be
 * *conservative*: if it under-collects, the caller sees zero resolvable hosts
 * and fails closed. It is never allowed to turn "I did not understand this" into
 * a pass.
 */
function shellAssignmentsOf(varName: string): string[] {
  const lines = readFileSync(statefulSetPath, "utf8").split("\n");
  const assignment = new RegExp(`^\\s*${varName}=`);
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!assignment.test(lines[i]!)) continue;
    let statement = lines[i]!;
    while (/\\\s*$/.test(lines[i]!) && i + 1 < lines.length) {
      i += 1;
      statement += `\n${lines[i]!}`;
    }
    found.push(statement.slice(statement.indexOf("=") + 1));
  }
  return found;
}

/** One concrete form a seeded entry can take once the pod has booted. */
type EntryShape = {
  label: string;
  hosts: string[];
  unresolved: string[];
  declaresCommand: boolean;
};

/**
 * Expand a seeded entry into every concrete shape it can have at runtime.
 *
 * The seed is not static: `"gbrain": ${GBRAIN_ENTRY}` is one JSON key with *two*
 * possible expansions (a bridge fallback and a minted-Bearer admin URL), and the
 * heredoc normaliser above collapses both to a single `<shell:GBRAIN_ENTRY>`
 * sentinel. Any check that reads a host straight off the sentinel gets `null` and
 * then *passes vacuously* — which is how a shell-interpolated upstream could be
 * moved behind the gateway with this audit none the wiser. So resolve the
 * sentinel back through the init script's own assignments and return one shape
 * per assignment, so each is asserted on separately.
 */
function resolveEntryShapes(
  name: string,
  entry: SeedEntry | string,
  /**
   * Seam for the regression tests below. Production callers use the real scan;
   * the tests inject assignment sets the current seed does not happen to contain,
   * so this resolver's fail-closed behaviour is pinned by construction rather
   * than by whatever shapes the init script has today.
   */
  assignmentsOf: (varName: string) => string[] = shellAssignmentsOf,
): EntryShape[] {
  const wholeEntrySentinel =
    typeof entry === "string" ? /^<shell:([A-Za-z_][A-Za-z0-9_]*)>$/.exec(entry) : null;

  if (wholeEntrySentinel) {
    const varName = wholeEntrySentinel[1]!;
    const assignments = assignmentsOf(varName);
    if (assignments.length === 0) {
      throw new Error(
        `Upstream '${name}' is seeded as the shell variable ${varName}, but no '${varName}=' ` +
          `assignment could be found in ${path.relative(repoRoot, statefulSetPath)}. Its runtime ` +
          "host is therefore unknown, so this audit cannot claim it is off the gateway. Re-point " +
          "this resolver at wherever the value is now built rather than deleting the check.",
      );
    }
    return assignments.map((rhs, index) => ({
      label: `${name} (${varName} assignment ${index + 1} of ${assignments.length})`,
      declaresCommand: /"command"\s*:/.test(rhs),
      ...urlsIn(rhs),
    }));
  }

  const object = typeof entry === "string" ? {} : entry;
  const declaresCommand = Boolean(object.command);
  const url = object.url ?? "";
  if (!url) return [{ label: name, hosts: [], unresolved: [], declaresCommand }];

  const direct = urlsIn(url);
  const sentinels = [
    ...new Set(Array.from(url.matchAll(/<shell:([A-Za-z_][A-Za-z0-9_]*)>/g), (m) => m[1]!)),
  ];
  if (sentinels.length === 0) {
    return [{ label: name, hosts: direct.hosts, unresolved: direct.unresolved, declaresCommand }];
  }

  // A url with a sentinel *inside* it (`http://<shell:SVC>:8080/mcp`) resolves
  // through the same assignment scan as the whole-entry case above — and, like it,
  // fans out to one shape per assignment.
  //
  // Fanning out is the load-bearing part, not a tidiness choice. The first version
  // merged every assignment into a single shape and cleared the unresolved list
  // whenever *any* host had been pinned (`hosts.length > 0 ? [] : unresolved`).
  // That let one resolvable assignment vouch for an unresolvable sibling: a var
  // with a concrete fallback and a computed admin form reported `unresolved: []`,
  // so the fail-closed assertion downstream passed while half of what the pod can
  // actually boot as had an unknown host. A merged shape cannot express "pinned
  // here, unknown there" — it can only report the optimistic half, which is the
  // fail-open this file exists to reject. Found in review of #1530 by reading the
  // resolver for the shape it was written to catch (PEN-2370 ask 3's method
  // clause: audit the fix's own blind spots).
  //
  // So each assignment carries its own evidence: the unresolved urls found in that
  // assignment, plus the seed url itself when that assignment pinned no host at
  // all. Evidence is never dropped on account of a *different* shape resolving.
  const shapes: EntryShape[] = [];
  for (const varName of sentinels) {
    const assignments = assignmentsOf(varName);
    if (assignments.length === 0) {
      // Unknowable from this repo. Not an error as it is for a whole-entry
      // sentinel (there, nothing at all is known about the upstream); here the
      // url is reported unresolved and the caller fails closed on it.
      shapes.push({
        label: `${name} (${varName}, no assignment found)`,
        hosts: [],
        unresolved: [url],
        declaresCommand,
      });
      continue;
    }
    assignments.forEach((rhs, index) => {
      const resolved = urlsIn(rhs);
      shapes.push({
        label: `${name} (${varName} assignment ${index + 1} of ${assignments.length})`,
        hosts: resolved.hosts,
        unresolved: [...resolved.unresolved, ...(resolved.hosts.length === 0 ? [url] : [])],
        declaresCommand,
      });
    });
  }
  // Any concrete url sitting alongside the sentinel is still audited on its own.
  if (direct.hosts.length > 0) {
    shapes.push({ label: name, hosts: direct.hosts, unresolved: [], declaresCommand });
  }
  return shapes;
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

  it("anything claimed 'unscrubbed' really is direct HTTP, and really is not behind the gateway", () => {
    // The ticket check above is bookkeeping: it proves someone wrote a plausible
    // sentence, not that the sentence is still true of the deployment. Without a
    // topology assertion, moving an upstream behind the gateway leaves it marked
    // `unscrubbed` and this suite stays green — the classification silently
    // becomes a description of a world that no longer exists. That is the same
    // fail-open shape as the scrubber that kept passing while the traffic moved
    // out from under it, which is the whole reason PEN-2370 exists.
    //
    // `gateway-scrubbed` and `stdio-not-proxied` were already held to their
    // topology. This holds the third classification to its own claim: direct HTTP
    // (so not stdio), to a host that is not a scrubbing gateway.
    for (const [name, coverage] of Object.entries(SEED_COVERAGE)) {
      if (coverage.kind !== "unscrubbed") continue;

      for (const shape of resolveEntryShapes(name, seeded[name]!)) {
        expect(
          shape.declaresCommand,
          `Upstream '${shape.label}' is classified unscrubbed — which means direct HTTP — but declares a stdio command. ` +
            "If it no longer has an HTTP hop, reclassify it as stdio-not-proxied.",
        ).toBe(false);

        expect(
          shape.unresolved,
          `Upstream '${shape.label}' declares URL(s) whose host cannot be resolved from this repo: ${shape.unresolved.join(", ")}. ` +
            "An upstream whose host is unknown cannot be asserted to be off the gateway. Fail closed rather than assume.",
        ).toEqual([]);

        expect(
          shape.hosts.length,
          `Upstream '${shape.label}' is classified unscrubbed but no concrete host could be resolved for it. ` +
            "That makes the gateway check below vacuous, so it is a failure, not a pass — teach resolveEntryShapes " +
            "how to expand this entry, or reclassify it.",
        ).toBeGreaterThan(0);

        for (const host of shape.hosts) {
          expect(
            SCRUBBING_GATEWAY_HOSTS,
            `Upstream '${shape.label}' dials '${host}', which IS a scrubbing gateway host — but it is still classified ` +
              "unscrubbed. Its responses are now scrubbed: reclassify it as gateway-scrubbed. Leaving it here " +
              "understates coverage and keeps a closed hole on the books as open.",
          ).not.toContain(host);
        }
      }
    }
  });

  it("shell-interpolated entries are expanded to every shape they can boot as", () => {
    // Guards the resolver that the test above depends on. `"gbrain": ${GBRAIN_ENTRY}`
    // normalises to a bare sentinel, so `hostOf` returns null for it; a host check
    // written against that would pass vacuously forever. Pin the expansion so that
    // if the resolver ever silently stops resolving, it fails HERE — loudly and at
    // the person who broke it — rather than quietly draining the assertions above.
    const shapes = resolveEntryShapes("gbrain", seeded.gbrain!);
    expect(
      shapes.length,
      "GBRAIN_ENTRY has a bridge fallback and a minted-Bearer admin form; both are agent-facing and both must be audited.",
    ).toBeGreaterThanOrEqual(2);

    const hosts = shapes.flatMap((s) => s.hosts);
    expect(hosts).toContain("gbrain-mcp-internal.paperclip.svc.cluster.local");
    expect(hosts).toContain("gbrain-mcp-admin.paperclip.svc.cluster.local");
    expect(shapes.flatMap((s) => s.unresolved)).toEqual([]);
  });

  it("a resolvable shape never vouches for an unresolvable one", () => {
    // The regression for the fail-open this resolver shipped with: unresolved
    // evidence was discarded whenever *any* host had been pinned, so a var with
    // one concrete assignment and one computed assignment reported a clean bill
    // and the fail-closed check downstream passed on a half-unknown topology.
    //
    // The seed has no url-embedded sentinel today, so this drives the resolver
    // through its injection seam. That is deliberate: the shapes this must fail
    // closed on are the ones nobody has written into the init script *yet*, and a
    // test that only exercises today's seed would go quiet the moment it mattered.
    const url = "http://<shell:SVC>:8080/mcp";
    const entry: SeedEntry = { type: "http", url };

    const mixed = resolveEntryShapes("probe", entry, (v) =>
      v === "SVC" ? ["http://pinned.svc.cluster.local:8080", "${LATE_BOUND_AT_BOOT}"] : [],
    );

    // The contract every assertion in this file leans on: a shape may only report
    // "nothing unresolved" if it actually pinned a host. Anything else is the
    // resolver saying "I cannot tell" in a voice that reads as "fine".
    for (const shape of mixed) {
      if (shape.unresolved.length === 0) {
        expect(
          shape.hosts.length,
          `Shape '${shape.label}' claims a clean bill of health while pinning no host. ` +
            "That is the vacuous pass this resolver exists to prevent.",
        ).toBeGreaterThan(0);
      }
    }

    expect(
      mixed.flatMap((s) => s.unresolved),
      "The computed assignment cannot be pinned to a host, so the url must survive as unresolved " +
        "evidence. A sibling assignment resolving says nothing about this one.",
    ).toContain(url);
    expect(mixed.flatMap((s) => s.hosts)).toContain("pinned.svc.cluster.local");

    // Same rule one level down: unresolved urls found *inside* an assignment are
    // evidence too, and were previously dropped on the floor because only the
    // assignment's hosts were collected.
    const withinOneAssignment = resolveEntryShapes("probe", entry, (v) =>
      v === "SVC" ? ["http://pinned.svc.cluster.local:8080 http://${TENANT}.svc.cluster.local"] : [],
    );
    expect(
      withinOneAssignment.flatMap((s) => s.unresolved),
      "An assignment that names one pinnable host and one interpolated host is half-unknown, " +
        "and the half that is unknown must be reported.",
    ).toContain("http://${TENANT}.svc.cluster.local");

    // And the floor case: a sentinel with no assignment at all is unknowable from
    // this repo, so the url is unresolved rather than silently host-less.
    const unassigned = resolveEntryShapes("probe", entry, () => []);
    expect(unassigned.flatMap((s) => s.hosts)).toEqual([]);
    expect(unassigned.flatMap((s) => s.unresolved)).toContain(url);
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
