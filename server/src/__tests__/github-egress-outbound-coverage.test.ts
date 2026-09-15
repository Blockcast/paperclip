import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
 * an outbound control can live. This table requires each one to be classified,
 * and — for the ones claimed as controlled — asserts the launcher actually
 * still execs its egress runtime. Deleting the control from a wrapper fails
 * here.
 *
 * Note that "controlled" covers two different mechanisms, and the `Coverage`
 * union keeps them apart on purpose: `egress-scrubbed` rewrites the payload in
 * flight and the caller still succeeds, while `egress-refused` (PEN-3156's git
 * door) can only stop the publish, because by then the objects are
 * content-addressed. Do not collapse the two kinds to simplify the table.
 *
 * It also enumerates the server-side write set, which is a second family
 * entirely: `paperclip-api` writes to GitHub over HTTP from `server/`, reaching
 * no wrapper and no scrubber.
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

/** The compiled entrypoints that carry a control, as the wrappers name them. */
const CLI_EGRESS_RUNTIME = "github-cli-egress-runtime.js";
const MCP_EGRESS_RUNTIME = "github-mcp-egress-runtime.js";
const GIT_EGRESS_RUNTIME = "github-git-egress-runtime.js";

type Coverage =
  /** Agent-authored text on this path passes through `scrubGitHubEgressText`. */
  | { kind: "egress-scrubbed"; runtime: string }
  /**
   * Agent-authored text on this path is REFUSED, not rewritten, when it carries
   * material `scrubGitHubEgressText` would remove.
   *
   * A deliberately separate `kind` from `egress-scrubbed`, because the two are
   * not interchangeable and collapsing them would overstate the cover. A
   * scrubbed door rewrites a payload in flight and the caller's request still
   * succeeds. This door cannot: the objects are content-addressed by the time
   * they exist, so editing a message or a blob changes every downstream SHA.
   * The only available control is to stop the publish and name the offending
   * object, which means the agent's command FAILS and it must go back and redo
   * the object. Anything reading this table to answer "is this door covered"
   * gets a yes; anything reading it to answer "does authored text reach GitHub
   * unaltered here" needs the distinction.
   */
  | { kind: "egress-refused"; runtime: string; ticket: string; why: string }
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
    kind: "egress-refused",
    runtime: GIT_EGRESS_RUNTIME,
    ticket: "PEN-3156",
    // Still worded to avoid the literal command name, for the SAME reason the
    // `unscrubbed` row this replaces was: scripts/check-no-git-push.mjs scans
    // server/src (see its DEFAULT_SCAN_ROOTS), so this very file is in scope,
    // and the marker that opts a line out asserts an operator-approved publish
    // path exists on it. This is a description of a control, not a path that
    // publishes, so spending that escape hatch here would put a false claim
    // inside a security control. Note the scanner matches `git-push` and
    // `git_push` too, so hyphenating is not a way around it.
    why: "guarded by github-git-egress-runtime.js, which the seed puts on BOTH interposition points: the ${LOCAL_BIN}/git launcher (inside the token wrapper, so credentials still reach it) and a pre-push hook it injects via core.hooksPath. It scans the outgoing commit range — messages, added file content including binary/textconv-laundered paths, and annotated tag messages — and refuses the publish naming the offending object and class, rather than rewriting it, because commit objects are content-addressed and altering one changes every downstream SHA. Failed reads refuse rather than pass unscanned",
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
 * `server/src/services` files that issue a WRITE to GitHub over HTTP.
 *
 * Derived from source at file granularity rather than line, so it stays stable
 * across refactors while still failing when a NEW file starts writing to
 * GitHub. Both entries are unscrubbed: the scrubber lives in
 * `packages/adapter-utils`, is imported only by the two sandbox wrappers, and
 * is not re-exported from that package's `index.ts` — so it is structurally
 * unreachable from `server/`.
 */
const SERVER_WRITE_COVERAGE: Readonly<Record<string, Coverage>> = {
  "github-app-auth.ts": {
    kind: "unscrubbed",
    ticket: "PEN-3157",
    why: "githubPostIssueComment POSTs an arbitrary `body` to /issues/{n}/comments, and githubPostCommitStatusDetailed POSTs a `description`. The comment helper's only caller passes a template today, so the exposure there is latent rather than live — but the helper accepts any string and is one caller away from carrying model output",
  },
  "github-review-gate-authority.ts": {
    kind: "unscrubbed",
    ticket: "PEN-3157",
    why: "POSTs a fixed pending-status description plus a repository_dispatch client_payload of ids; no model-authored free text on either, but it reaches GitHub through the same unscrubbed ghFetch boundary and must be reclassified together with it",
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

function serviceFilesWritingToGitHub(): string[] {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const out: string[] = [];
  for (const entry of readdirSync(servicesDirectory)) {
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    const source = readFileSync(path.join(servicesDirectory, entry), "utf8");
    if (!source.includes("ghFetch(")) continue;
    if (!/method:\s*"(?:POST|PATCH|PUT|DELETE)"/.test(source)) continue;
    out.push(entry);
  }
  return out.sort();
}

describe("outbound GitHub egress coverage", () => {
  describe("sandbox launchers", () => {
    it("classifies every launcher the seed writes", () => {
      const seeded = readWrapperNames().sort();
      const classified = Object.keys(WRAPPER_COVERAGE).sort();
      expect(seeded).toEqual(classified);
    });

    it("every launcher claimed as controlled still execs its egress runtime", () => {
      // This is the regression guard for the control itself. Removing the
      // scrub from a wrapper — the change that would silently reopen
      // PEN-2527's or PEN-3152's gap — fails right here. `egress-refused` is
      // included on the same footing: PEN-3156's guard is reached the same
      // way, by the launcher exec'ing a runtime, so deleting it fails here too.
      for (const [name, coverage] of Object.entries(WRAPPER_COVERAGE)) {
        if (coverage.kind !== "egress-scrubbed" && coverage.kind !== "egress-refused") continue;
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

    it("each controlled door uses its OWN runtime, never a sibling's", () => {
      // argv rewriting, JSON-RPC frame rewriting and commit-range refusal are
      // not interchangeable. Pointing one wrapper at another's runtime would
      // produce a process that runs, controls nothing, and looks correct in
      // this table.
      expect(readWrapperBody("gh")).not.toContain(MCP_EGRESS_RUNTIME);
      expect(readWrapperBody("gh")).not.toContain(GIT_EGRESS_RUNTIME);
      expect(readWrapperBody("github-mcp-server")).not.toContain(CLI_EGRESS_RUNTIME);
      expect(readWrapperBody("github-mcp-server")).not.toContain(GIT_EGRESS_RUNTIME);
      expect(readWrapperBody("git")).not.toContain(CLI_EGRESS_RUNTIME);
      expect(readWrapperBody("git")).not.toContain(MCP_EGRESS_RUNTIME);
    });
  });

  describe("the git publish door (PEN-3156)", () => {
    // This door is the one `egress-refused` case, and unlike the scrubbed
    // doors its control does not live in the launcher alone. The launcher
    // handles the flags that would skip the hook; the hook is what actually
    // sees the outgoing range. Both halves are asserted here because either
    // one alone is not the control.

    it("runs the guard INSIDE the token wrapper, so git keeps its credentials", () => {
      // Same ordering constraint as github-mcp-server, and load-bearing for
      // the same reason: a guard placed outside paperclip-github-token-env
      // would leave git unauthenticated, and an authentication failure is the
      // kind of breakage that gets a security control reverted, not fixed.
      const body = readWrapperBody("git");
      const tokenAt = body.indexOf("paperclip-github-token-env");
      const runtimeAt = body.indexOf(GIT_EGRESS_RUNTIME);
      expect(tokenAt).toBeGreaterThanOrEqual(0);
      expect(runtimeAt).toBeGreaterThan(tokenAt);
    });

    it("seeds a pre-push hook that execs the same runtime", () => {
      // The launcher can only see the argv it was handed. The hook is what
      // git itself invokes with the outgoing ref updates on stdin, so it is
      // the half that reads the range being published. Deleting it would
      // leave a wrapper that still rejects hook-skipping flags while nothing
      // downstream ever inspects a commit.
      const source = readFileSync(statefulSetPath, "utf8");
      const hookAt = source.indexOf('cat > "${GIT_HOOKS_DIR}/pre-push" <<\'EOF\'');
      expect(hookAt, "the seed no longer writes a pre-push hook").toBeGreaterThanOrEqual(0);
      const hookBody = source.slice(hookAt, source.indexOf("\n              EOF", hookAt));
      expect(hookBody).toContain(GIT_EGRESS_RUNTIME);
      expect(hookBody, "the hook must run the runtime in its hook mode").toContain(
        "--pre-push-hook",
      );
    });

    it("publishes the guarded launcher on the default PATH", () => {
      // Without this the guard is decorative, and that is measured rather
      // than theoretical: before PEN-3156, ${LOCAL_BIN}/git existed while a
      // live agent Job pod resolved `command -v git` to /usr/bin/git, because
      // ${LOCAL_BIN} is only prepended to PATH by a LOGIN shell and agent
      // tool harnesses spawn non-login shells. Same defect PEN-2527 fixed for
      // the gh wrapper — a choke point nothing traverses.
      const source = readFileSync(statefulSetPath, "utf8");
      expect(source).toContain('ln -sf "${LOCAL_BIN}/git" "${PATH_BIN}/git"');
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
    it("classifies every service file that writes to GitHub", () => {
      // paperclip-api reaches GitHub over HTTP from server/, touching no
      // wrapper. A new service file that starts writing fails here until it is
      // classified — which is the whole mechanism PEN-3152 asked for.
      expect(serviceFilesWritingToGitHub()).toEqual(Object.keys(SERVER_WRITE_COVERAGE).sort());
    });

    it("records that the scrubber is structurally unreachable from server/", () => {
      // Not a style point: as long as this holds, no server-side write can be
      // scrubbed even by a caller who wants to, and every entry in
      // SERVER_WRITE_COVERAGE must remain `unscrubbed`. PEN-3157 closes it by
      // exporting the core (or relocating it); when that lands this assertion
      // is what tells you the table is now stale.
      const index = readFileSync(
        path.join(repoRoot, "packages/adapter-utils/src/index.ts"),
        "utf8",
      );
      expect(index).not.toContain("github-egress-scrub");

      for (const coverage of Object.values(SERVER_WRITE_COVERAGE)) {
        expect(coverage.kind).toBe("unscrubbed");
      }
    });
  });

  describe("table hygiene", () => {
    it("every door that names a ticket names a real one, with a reason", () => {
      // `egress-refused` is held to this too, not just `unscrubbed`. A refusal
      // door still owes the reader a ticket and an explanation of what it
      // refuses, because "covered" here does not mean "behaves like a
      // scrubbed door" — see the kind's own doc comment.
      for (const coverage of [
        ...Object.values(WRAPPER_COVERAGE),
        ...Object.values(SERVER_WRITE_COVERAGE),
      ]) {
        if (coverage.kind !== "unscrubbed" && coverage.kind !== "egress-refused") continue;
        expect(coverage.ticket).toMatch(/^(PEN|BLO)-\d+$/);
        expect(coverage.why.length).toBeGreaterThan(40);
      }
    });

    it("at least one door is scrubbed, so an empty table cannot read as coverage", () => {
      const scrubbed = Object.values(WRAPPER_COVERAGE).filter(
        (coverage) => coverage.kind === "egress-scrubbed",
      );
      expect(scrubbed.length).toBeGreaterThanOrEqual(2);
    });
  });
});
