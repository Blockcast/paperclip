import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  productionFilesImportingTestHelpers,
  serverFilesWritingToGitHub,
  serverSourceFiles,
} from "./helpers/github-writer-derivation.js";

/**
 * PEN-3152 done-when 2: "the outbound direction gets its own exhaustive
 * coverage assertion, in the shape of `mcp-seed-scrub-coverage.test.ts` — so a
 * future outbound path cannot be added without a classification."
 *
 * ## Why this file exists as a SIBLING of mcp-seed-scrub-coverage.test.ts
 *
 * That file audits the INBOUND leg: MCP tool responses on their way to the
 * agent, where `packages/mcp-gateway/src/response-scrub.ts` is the control. It
 * is deliberately adjacent to this one, because its existence is what made the
 * outbound gap easy to mistake for covered. It classifies
 *
 *     github: { kind: "stdio-not-proxied", why: "...local stdio child process" }
 *
 * which is true, and says nothing whatsoever about whether agent-authored text
 * is scrubbed on the way OUT. PEN-3152 was filed because that row read like a
 * clean bill of health for a door that was wide open. Two directions, two
 * controls, and — now — two tables.
 *
 * ## What this table binds
 *
 * The Helm init script writes a small launcher into `${LOCAL_BIN}` for every
 * GitHub-touching binary in the agent sandbox, and `${LOCAL_BIN}` is first on
 * the PATH of every agent Job. Those launchers are the complete set of
 * interposition points available to us, so they are the complete set of places
 * an outbound scrub can live. This table requires each one to be classified,
 * and — for the ones claimed as scrubbed — asserts the launcher actually still
 * execs its egress runtime. Deleting the scrub from a wrapper fails here.
 *
 * It also enumerates the server-side write set, which is a second family
 * entirely: `paperclip-api` writes to GitHub over HTTP from `server/`, reaching
 * no wrapper. Its scrub is `scrubOutboundGitHubText` in `github-app-auth.ts`,
 * applied inside the write helpers rather than at their call sites (PEN-3157).
 *
 * ## ⚠️ Scope boundary — read before citing this file as coverage
 *
 * 1. **Per-agent MCP overrides are not enforced here.** An agent's effective
 *    MCP config is `{ ...sharedSeedBaseline, ...adapterConfig.mcpServers }`
 *    (`vendor/paperclip-adapter-claude-k8s/src/server/job-manifest.ts`), merged
 *    override-by-name. An `adapterConfig` that defines its own `github` key
 *    replaces the wrapper command and bypasses the MCP scrub entirely. That
 *    write is board-gated (`assertBoard`, `server/src/routes/agents.ts`), so it
 *    is an operator footgun rather than an agent-reachable bypass — but it is a
 *    footgun with no guard rail, and no static test in this repo can enumerate
 *    a DB column. Named here so it is enumerated rather than invisible.
 * 2. **CI and maintainer scripts are out of scope by construction.** The `gh`
 *    invocations in `.github/workflows/*` and `scripts/` run on Actions
 *    runners, not in an agent pod, so they never resolve to the wrapper. They
 *    publish CI-assembled text, not model output.
 * 3. A `kind` here is a statement about whether a SCRUBBER IS ON THE PATH. It
 *    is not a finding that anything sensitive has traversed it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const statefulSetPath = path.join(repoRoot, "deploy/helm/paperclip/templates/statefulset.yaml");
const servicesDirectory = path.join(repoRoot, "server/src/services");
const serverSourceDirectory = path.join(repoRoot, "server/src");

/** The compiled entrypoints that carry a scrub, as the wrappers name them. */
const CLI_EGRESS_RUNTIME = "github-cli-egress-runtime.js";
const MCP_EGRESS_RUNTIME = "github-mcp-egress-runtime.js";
/** The server-side wrapper over `scrubGitHubEgressText`, as the service files name it. */
const SERVER_EGRESS_SCRUB = "scrubOutboundGitHubText";

type Coverage =
  /**
   * Agent-authored text on this path passes through `scrubGitHubEgressText`.
   * `runtime` names what carries it: a compiled egress runtime for a launcher,
   * the server-side scrub helper for a service file.
   */
  | { kind: "egress-scrubbed"; runtime: string }
  /** Reaches GitHub carrying authored text, with NO scrubber on the path. */
  | { kind: "unscrubbed"; ticket: string; why: string }
  /** Touches GitHub credentials but is not itself a path authored text travels. */
  | { kind: "not-an-authored-text-path"; why: string };

/**
 * Every launcher the Helm seed writes into `${LOCAL_BIN}`.
 *
 * Keep this exhaustive. If you are here because the suite failed after you
 * added a wrapper, that is this test working: choose a `kind` and say why.
 *
 * One ticket per unscrubbed door, deliberately — PEN-2370's table records that
 * collapsing five upstreams onto one ticket had to be undone, because it parked
 * rows of unassessed severity behind an unrelated critical fix. Do not tidy
 * these onto a single row.
 */
const WRAPPER_COVERAGE: Readonly<Record<string, Coverage>> = {
  gh: {
    kind: "egress-scrubbed",
    runtime: CLI_EGRESS_RUNTIME,
  },
  "github-mcp-server": {
    kind: "egress-scrubbed",
    runtime: MCP_EGRESS_RUNTIME,
  },
  git: {
    kind: "unscrubbed",
    ticket: "PEN-3156",
    // Worded to avoid the literal command name: scripts/check-no-git-push.mjs
    // scans this tree for it, and the marker that opts a line out asserts an
    // operator-approved push path exists. No such path exists here — this is a
    // description of a gap — so spending that escape hatch on a doc string
    // would put a false claim inside a security control.
    why: "token-injection wrapper only; pushing through it publishes commit messages and file contents — a strict superset of what create_or_update_file/push_files carry. Not fixable by in-flight redaction: commit objects are content-addressed, so altering a blob or message after the fact changes every downstream SHA. The fix shape is refusal at push time, which is its own rollout",
  },
  "paperclip-github-token-env": {
    kind: "not-an-authored-text-path",
    why: "exports GH_TOKEN/GITHUB_TOKEN/GITHUB_PERSONAL_ACCESS_TOKEN then execs its argv; it carries the credential, never a payload. It is what the scrubbed wrappers exec THROUGH, so it must stay outside them",
  },
  "github-token-credential-helper": {
    kind: "not-an-authored-text-path",
    why: "emits username/password on stdout for git's credential protocol; no authored text passes through it",
  },
};

/**
 * `server/src` files that issue a WRITE to GitHub over HTTP, keyed by path
 * relative to `server/src` — not by bare filename. The path is deliberate:
 * the walk is recursive, so two files of the same name in different
 * directories must be distinguishable here.
 *
 * Derived from source at file granularity rather than line, so it stays stable
 * across refactors while still failing when a NEW file starts writing to
 * GitHub. Until PEN-3157 both entries were `unscrubbed` by construction: the
 * scrubber was not exported from `packages/adapter-utils`'s `index.ts`, so no
 * server-side write could reach it even by a caller who wanted to. PEN-3157
 * exported it and applied it inside the write helpers; a `kind` here is still
 * only a statement about whether the scrub is on the path (scope boundary 3).
 * Which FIELDS each helper scrubs is pinned per helper in
 * `github-write-egress-scrub.test.ts`, not here.
 */
const SERVER_WRITE_COVERAGE: Readonly<Record<string, Coverage>> = {
  // githubPostCommitStatusDetailed (description, target_url),
  // githubPostIssueComment (body) and githubPostCheckRun (title, summary,
  // details_url) each scrub inside the helper, so every present and future
  // caller inherits it. The installation-token POST in this file carries a JWT
  // and no authored text, and is not scrubbed.
  //
  // The two IDENTITY fields — a status `context` and a check-run `name` — are
  // deliberately not on that list. They are refused rather than redacted
  // (`gitHubIdentityFieldRedaction`, PEN-3391): a redacted name addresses the
  // status to something no lookup and no branch-protection rule can match, so
  // scrubbing them would trade a leak for a silent gate-liveness failure. The
  // refusal keeps the leak closed without that trade.
  "services/github-app-auth.ts": {
    kind: "egress-scrubbed",
    runtime: SERVER_EGRESS_SCRUB,
  },
  // Builds its own requests — a caller-supplied token and an abort signal the
  // shared helper does not model — so it calls the scrub directly on the
  // pending status's description and target_url, and applies the same
  // identity-field refusal to its context. Its repository_dispatch
  // client_payload is ids only (app, installation, delivery, PR number, head
  // SHA) and is not scrubbed: it carries no authored text, and the detectors
  // are tuned for prose, not protocol.
  "services/github-review-gate-authority.ts": {
    kind: "egress-scrubbed",
    runtime: SERVER_EGRESS_SCRUB,
  },
};

/** The init-script region that writes the sandbox launchers. */
function readWrapperNames(): string[] {
  const source = readFileSync(statefulSetPath, "utf8");
  const names = [...source.matchAll(/cat > "\$\{LOCAL_BIN\}\/([A-Za-z0-9._-]+)" <<'EOF'/g)].map(
    (match) => match[1] as string,
  );
  if (names.length === 0) {
    throw new Error(
      `Found no \${LOCAL_BIN} launchers in ${statefulSetPath}. If the seed moved, point this ` +
        "test at its new home rather than deleting it — PEN-3152 exists because an outbound " +
        "egress door went unenumerated behind a table that only covered the inbound leg.",
    );
  }
  return names;
}

/** The body of one launcher heredoc, so its exec line can be asserted. */
function readWrapperBody(name: string): string {
  const source = readFileSync(statefulSetPath, "utf8");
  const marker = `cat > "\${LOCAL_BIN}/${name}" <<'EOF'`;
  const markerAt = source.indexOf(marker);
  expect(markerAt, `launcher ${name} not found in the seed`).toBeGreaterThanOrEqual(0);
  const bodyStart = source.indexOf("\n", markerAt) + 1;
  const bodyEnd = source.indexOf("\n              EOF", bodyStart);
  expect(bodyEnd, `launcher ${name} heredoc is not terminated as expected`).toBeGreaterThan(
    bodyStart,
  );
  return source.slice(bodyStart, bodyEnd);
}

function readSeededGitHubMcpCommand(): string {
  const source = readFileSync(statefulSetPath, "utf8");
  const match = /"github":\s*\{\s*"command":\s*"([^"]+)"/.exec(source);
  expect(match, "the seeded mcpServers block no longer has a github command").not.toBeNull();
  return (match as RegExpExecArray)[1] as string;
}

/**
 * Every non-test TypeScript file under `server/src`, and the subset of them
 * this scan cannot prove is read-only.
 *
 * Both derivations now live in `helpers/github-writer-derivation.ts` and are
 * shared with `github-write-egress-scrub.test.ts`. They used to be duplicated
 * byte-for-byte here, which is how the walk came to be widened by hand in two
 * places at once on #1754 — one copy away from diverging (PEN-3391).
 *
 * The walk is recursive, and that is the load-bearing part. It listed
 * `server/src/services` one level deep until Ally caught the scope on #1754:
 * `server/src/routes/` (which holds `github-webhook.ts`) and
 * `server/src/services/recovery/` were both invisible to it, so a new
 * `ghFetch`-based write added in either would have shipped unscrubbed with this
 * table green. No live leak existed — widening the walk finds exactly the same
 * two writers today — but the table is the mechanism meant to catch the NEXT
 * one, and it could not see two directories that already hold GitHub code.
 *
 * That is the third repeat of one shape: PEN-2527 enumerated `gh` and missed
 * the MCP server, PEN-3152 enumerated both wrappers and missed `server/`, and
 * this enumerated `services/` and missed its own siblings. Each time the
 * derivation was correct over a set that was quietly too small. PEN-3391 is the
 * fourth, one level further down: the predicate itself enumerated a single
 * spelling of a write (`ghFetch(` plus an inline double-quoted upper-case
 * method) and missed aliased calls, quoted variants and non-literal methods. It
 * is now fail-closed — see the helper for what that costs and what still
 * escapes it.
 */
function scannedServerSourceFiles(): string[] {
  return serverSourceFiles(serverSourceDirectory);
}

function scannedServerFilesWritingToGitHub(): string[] {
  return serverFilesWritingToGitHub(serverSourceDirectory);
}

describe("outbound GitHub egress coverage", () => {
  describe("sandbox launchers", () => {
    it("classifies every launcher the seed writes", () => {
      const seeded = readWrapperNames().sort();
      const classified = Object.keys(WRAPPER_COVERAGE).sort();
      expect(seeded).toEqual(classified);
    });

    it("every launcher claimed as scrubbed still execs its egress runtime", () => {
      // This is the regression guard for the control itself. Removing the
      // scrub from a wrapper — the change that would silently reopen
      // PEN-2527's or PEN-3152's gap — fails right here.
      for (const [name, coverage] of Object.entries(WRAPPER_COVERAGE)) {
        if (coverage.kind !== "egress-scrubbed") continue;
        const body = readWrapperBody(name);
        expect(body, `${name} no longer execs ${coverage.runtime}`).toContain(coverage.runtime);
        expect(body, `${name} must exec its target, not merely mention the runtime`).toMatch(
          /^\s*exec\s/m,
        );
      }
    });

    it("the MCP scrub runs INSIDE the token wrapper, so the server keeps its credential", () => {
      // Ordering is load-bearing: paperclip-github-token-env must be the outer
      // process so the real server inherits GITHUB_PERSONAL_ACCESS_TOKEN. If
      // the scrub runtime were placed outside it, the server would start
      // unauthenticated and every tool call would fail — the kind of breakage
      // that gets a security control reverted rather than fixed.
      const body = readWrapperBody("github-mcp-server");
      const tokenAt = body.indexOf("paperclip-github-token-env");
      const runtimeAt = body.indexOf(MCP_EGRESS_RUNTIME);
      expect(tokenAt).toBeGreaterThanOrEqual(0);
      expect(runtimeAt).toBeGreaterThan(tokenAt);
    });

    it("the two scrubbed doors use DIFFERENT runtimes for their two transports", () => {
      // argv rewriting and JSON-RPC frame rewriting are not interchangeable.
      // Pointing one wrapper at the other's runtime would produce a process
      // that runs, scrubs nothing, and looks correct in this table.
      expect(readWrapperBody("gh")).not.toContain(MCP_EGRESS_RUNTIME);
      expect(readWrapperBody("github-mcp-server")).not.toContain(CLI_EGRESS_RUNTIME);
    });
  });

  describe("the seeded github MCP upstream", () => {
    it("dials the wrapper, not the real server", () => {
      // The whole control rests on this indirection. A seed that pointed
      // `github` straight at /usr/local/bin/github-mcp-server would bypass the
      // scrub while leaving every wrapper assertion above green.
      expect(readSeededGitHubMcpCommand()).toBe("/paperclip/.local/bin/github-mcp-server");
    });

    it("is a wrapper the seed actually writes", () => {
      const command = readSeededGitHubMcpCommand();
      expect(readWrapperNames()).toContain(path.basename(command));
    });
  });

  describe("server-side GitHub writes", () => {
    it("classifies every server file that writes to GitHub", () => {
      // paperclip-api reaches GitHub over HTTP from server/, touching no
      // wrapper. A new file that starts writing fails here until it is
      // classified — which is the whole mechanism PEN-3152 asked for.
      expect(scannedServerFilesWritingToGitHub()).toEqual(
        Object.keys(SERVER_WRITE_COVERAGE).sort(),
      );
    });

    it("derives that set from a walk that actually descends below server/src", () => {
      // Scope control for the assertion above, not a style point. The walk it
      // replaced listed `server/src/services` one level deep, so a writer added
      // under `routes/` or `services/recovery/` was not merely unclassified —
      // it was invisible, and the table stayed green while missing it. A
      // non-recursive regression would still pass the check above (the two
      // known writers both sit directly in `services/`), so the blind spot has
      // to be pinned by naming files only a descending walk can reach.
      //
      // `routes/github-webhook.ts` is the specific file Ally named on #1754:
      // it imports `githubPostIssueComment` and so is one edit away from being
      // a direct writer itself.
      const scanned = scannedServerSourceFiles();
      expect(scanned).toContain("routes/github-webhook.ts");
      expect(
        scanned.filter((entry) => entry.startsWith("services/recovery/")),
        "services/recovery/ is no longer reachable from the walk",
      ).not.toHaveLength(0);

      // The walk skips `__tests__/` so the shared derivation helper cannot
      // classify itself as an unscrubbed writer by quoting its own regexes.
      // That exclusion only excludes TEST code while nothing in the running
      // server imports from there — checked, not assumed (PEN-3391).
      expect(
        productionFilesImportingTestHelpers(serverSourceDirectory),
        "a production file imports from __tests__/, so skipping it no longer excludes only test code",
      ).toEqual([]);
    });

    it("the scrubber is reachable from server/, and the server wrapper still delegates to it", () => {
      // The inverse of the assertion this replaced. Before PEN-3157 the barrel
      // did NOT export the core, so no server-side write could be scrubbed and
      // every entry above had to be `unscrubbed`; that test was written to
      // fail the day the export landed, and it did. This is the regression
      // guard for the mechanism it turned on: drop the barrel export, or hollow
      // out `scrubOutboundGitHubText` so it no longer calls the shared core,
      // and every "egress-scrubbed" row above becomes a false claim — here.
      const index = readFileSync(
        path.join(repoRoot, "packages/adapter-utils/src/index.ts"),
        "utf8",
      );
      expect(index).toContain("github-egress-scrub");
      expect(index).toContain("scrubGitHubEgressText");

      const appAuth = readFileSync(path.join(servicesDirectory, "github-app-auth.ts"), "utf8");
      expect(appAuth).toMatch(
        /import\s*\{[^}]*\bscrubGitHubEgressText\b[^}]*\}\s*from\s*"@paperclipai\/adapter-utils"/,
      );
      const wrapper = appAuth.slice(appAuth.indexOf(`export function ${SERVER_EGRESS_SCRUB}(`));
      expect(wrapper, `${SERVER_EGRESS_SCRUB} is no longer defined in github-app-auth.ts`).not.toBe("");
      expect(wrapper).toContain("scrubGitHubEgressText(");
    });

    it("every classified writer claimed as scrubbed still calls the scrub", () => {
      // Mirror of the launcher check above. A writer that only imports or
      // mentions the helper is not covered; it has to CALL it.
      for (const [name, coverage] of Object.entries(SERVER_WRITE_COVERAGE)) {
        if (coverage.kind !== "egress-scrubbed") continue;
        const source = readFileSync(path.join(serverSourceDirectory, name), "utf8");
        expect(source, `${name} no longer calls ${coverage.runtime}`).toContain(
          `${coverage.runtime}(`,
        );
      }
    });
  });

  describe("table hygiene", () => {
    it("every unscrubbed door names a ticket that owns it", () => {
      for (const coverage of [
        ...Object.values(WRAPPER_COVERAGE),
        ...Object.values(SERVER_WRITE_COVERAGE),
      ]) {
        if (coverage.kind !== "unscrubbed") continue;
        expect(coverage.ticket).toMatch(/^(PEN|BLO)-\d+$/);
        expect(coverage.why.length).toBeGreaterThan(40);
      }
    });

    it("at least one door is scrubbed, so an empty table cannot read as coverage", () => {
      const scrubbed = Object.values(WRAPPER_COVERAGE).filter(
        (coverage) => coverage.kind === "egress-scrubbed",
      );
      expect(scrubbed.length).toBeGreaterThanOrEqual(2);
      // Same guard for the server family: after PEN-3157, a table with no
      // scrubbed server write is a regression, not a neutral starting state.
      const serverScrubbed = Object.values(SERVER_WRITE_COVERAGE).filter(
        (coverage) => coverage.kind === "egress-scrubbed",
      );
      expect(serverScrubbed.length).toBeGreaterThanOrEqual(1);
    });
  });
});
