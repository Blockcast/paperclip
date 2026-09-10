import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

const { logActivity } = await import("../services/activity-log.js");
const {
  findMissingHookCommandPaths,
  auditHookCommands,
  auditConfiguredHookCommandsOnBoot,
  describeHookCommandFinding,
  LIFECYCLE_HOOK_COMMAND_SETTINGS,
  LIFECYCLE_HOOK_COMMAND_UNRESOLVED_ACTION,
} = await import("../services/lifecycle-hook-command-audit.js");

const fakeDb = {} as unknown as Db;

/** Only the paths listed here "exist"; everything else is missing. */
function fsWith(...present: string[]) {
  const set = new Set(present);
  return { fileExists: (p: string) => set.has(p) };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("findMissingHookCommandPaths", () => {
  it("bounds the number of filesystem stats regardless of command length", () => {
    // `fileExists` is a *synchronous* stat and the write path runs this inline
    // in an HTTP handler, so token count is a direct multiplier on how long the
    // API event loop blocks. Before the cap, a 10 MB body measured ~4 s of
    // blocking (BLO-28872 review). Assert the ceiling, not just "it returns".
    //
    // Note the shape that exercises the cap changed with BLO-29505: 5000
    // space-separated tokens are now *one* simple command, so only argv[0] is
    // ever stat'd. The chained form below is the one the cap still binds.
    const calls: string[] = [];
    const command = Array.from({ length: 5000 }, (_, i) => `/x${i}.sh`).join(" ");
    findMissingHookCommandPaths(command, {
      fileExists: (p) => {
        calls.push(p);
        return false;
      },
    });
    expect(calls.length).toBeLessThanOrEqual(64);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("bounds stats when every token is its own simple command", () => {
    // The mutation-verified case for MAX_AUDITED_TOKENS after BLO-29505: 5000
    // `&&`-chained commands are 5000 argv[0]s, so without the word cap this
    // would be 5000 synchronous stats on the API event loop.
    const calls: string[] = [];
    const command = Array.from({ length: 5000 }, (_, i) => `node /x${i}.js`).join(" && ");
    findMissingHookCommandPaths(command, {
      fileExists: (p) => {
        calls.push(p);
        return false;
      },
    });
    expect(calls.length).toBeLessThanOrEqual(64);
    // Non-vacuous: without the cap this would be 5000.
    expect(calls.length).toBeGreaterThan(1);
  });

  it("flags the exact BLO-28782 production command", () => {
    // The literal string that was stored in instance_settings.general and
    // produced 500/500 MODULE_NOT_FOUND fires between 2026-07-05 and
    // 2026-08-18 across 11 agents.
    const missing = findMissingHookCommandPaths(
      "node /app/server/dist/cli/ccrotate-relogin-trigger.js",
      fsWith("/app/server/dist/cli/ccrotate-state-hook.js"),
    );
    expect(missing).toEqual(["/app/server/dist/cli/ccrotate-relogin-trigger.js"]);
  });

  it("passes a command whose script does exist", () => {
    const missing = findMissingHookCommandPaths(
      "node /app/server/dist/cli/ccrotate-state-hook.js export",
      fsWith("/app/server/dist/cli/ccrotate-state-hook.js"),
    );
    expect(missing).toEqual([]);
  });

  it("treats an unset or blank command as configured-off, not broken", () => {
    expect(findMissingHookCommandPaths(null, fsWith())).toEqual([]);
    expect(findMissingHookCommandPaths(undefined, fsWith())).toEqual([]);
    expect(findMissingHookCommandPaths("   ", fsWith())).toEqual([]);
  });

  it("does not flag bare argv[0] resolved via PATH", () => {
    // `ccrotate` is on PATH inside the runtime image; we cannot and must not
    // decide its existence from here.
    expect(findMissingHookCommandPaths("ccrotate refresh-one", fsWith())).toEqual([]);
  });

  it("does not flag relative paths (cwd-dependent at spawn time)", () => {
    expect(findMissingHookCommandPaths("node ./scripts/hook.js", fsWith())).toEqual([]);
  });

  it("does not flag shell-interpolated paths", () => {
    expect(
      findMissingHookCommandPaths("node $PAPERCLIP_HOME/cli/hook.js", fsWith()),
    ).toEqual([]);
  });

  it("does not flag absolute non-script arguments", () => {
    // /var/log/hook.log is created by the command, not required to pre-exist.
    expect(
      findMissingHookCommandPaths(
        "node /app/hook.js --log /var/log/hook.log",
        fsWith("/app/hook.js"),
      ),
    ).toEqual([]);
  });

  it("unquotes paths and reports each missing path once", () => {
    const missing = findMissingHookCommandPaths(
      `node "/app/a.js" && node '/app/a.js' && node /app/b.sh`,
      fsWith(),
    );
    expect(missing).toEqual(["/app/a.js", "/app/b.sh"]);
  });
});

// BLO-29505 Part A. Every row here was a *false positive* before the fix: the
// audit flagged any absolute script-extension token regardless of argv
// position, so a command that legitimately *creates* its `--out` target warned
// on a correct configuration. The assertion is `[]` in both filesystem states —
// whether or not the output path exists is irrelevant, because an output path
// is never stat'd.
describe("findMissingHookCommandPaths — argument-position paths are not commands", () => {
  const argumentPositionCases: {
    command: string;
    /** The real script, which exists. */
    script: string;
    /** The argument-position path that must never be stat'd. */
    argument: string;
  }[] = [
    {
      command: "python3 /app/hook.py --out /var/run/state.py",
      script: "/app/hook.py",
      argument: "/var/run/state.py",
    },
    {
      command: "node /app/build.js --emit /app/dist/bundle.js",
      script: "/app/build.js",
      argument: "/app/dist/bundle.js",
    },
    {
      command: "bash /app/run.sh --template /srv/tpl/new.sh",
      script: "/app/run.sh",
      argument: "/srv/tpl/new.sh",
    },
  ];

  for (const { command, script, argument } of argumentPositionCases) {
    it(`yields no finding for \`${command}\``, () => {
      expect(findMissingHookCommandPaths(command, fsWith(script))).toEqual([]);
      // …and identically when the output path happens to exist already.
      expect(findMissingHookCommandPaths(command, fsWith(script, argument))).toEqual([]);
    });

    it(`never stats the argument-position path of \`${command}\``, () => {
      const stated: string[] = [];
      findMissingHookCommandPaths(command, {
        fileExists: (p) => {
          stated.push(p);
          return true;
        },
      });
      expect(stated).toEqual([script]);
      expect(stated).not.toContain(argument);
    });
  }

  it("still flags the script when it is the missing one", () => {
    // Non-vacuous control for the rows above: narrowing to command position
    // must not make the check silent on the case it exists to catch.
    expect(
      findMissingHookCommandPaths(
        "python3 /app/hook.py --out /var/run/state.py",
        fsWith("/var/run/state.py"),
      ),
    ).toEqual(["/app/hook.py"]);
  });
});

// BLO-29505 Part B. All ten rows passed *silently* before the fix — no warning
// at all. Two root causes: `split(/\s+/)` shredded a quoted path containing a
// space, and shell metacharacters disqualified the token they were glued to
// instead of splitting it. Each row now asserts an explicit expectation; no row
// is left implicitly silent.
describe("findMissingHookCommandPaths — previously silent recall gaps", () => {
  const recallCases: { label: string; command: string; expected: string[] }[] = [
    {
      label: "quoted path containing a space",
      command: `bash "/paperclip/my scripts/relogin.sh"`,
      expected: ["/paperclip/my scripts/relogin.sh"],
    },
    {
      label: "case-variant extension",
      command: "node /app/GONE.JS",
      expected: ["/app/GONE.JS"],
    },
    {
      label: "extensionless wrapper binary",
      command: "exec /app/bin/relogin",
      expected: ["/app/bin/relogin"],
    },
    {
      label: "interpreters outside the old extension list",
      command: "ruby /app/gone.rb && perl /app/gone.pl",
      expected: ["/app/gone.rb", "/app/gone.pl"],
    },
    {
      label: "semicolon glued to the token",
      command: "node /app/gone.js; echo done",
      expected: ["/app/gone.js"],
    },
    {
      label: "&& glued to the token",
      command: "node /app/gone.js&&echo ok",
      expected: ["/app/gone.js"],
    },
    {
      label: "wrapped in a subshell",
      command: "(node /app/gone.js)",
      expected: ["/app/gone.js"],
    },
    {
      label: "piped into another command",
      command: "bash /app/gone.sh|tee /tmp/x",
      expected: ["/app/gone.sh"],
    },
    {
      label: "redirect glued to the token",
      command: "node /app/gone.js>/tmp/out",
      expected: ["/app/gone.js"],
    },
    {
      label: "literal ~ mid-path behind an env assignment",
      command: "FOO=1 bash /app/my~dir/gone.sh",
      expected: ["/app/my~dir/gone.sh"],
    },
  ];

  for (const { label, command, expected } of recallCases) {
    it(`flags ${label}: \`${command}\``, () => {
      expect(findMissingHookCommandPaths(command, fsWith())).toEqual(expected);
    });
  }

  it("does not treat a redirect target as a command", () => {
    // `>/tmp/out` is written by the command, so its absence is not a finding —
    // the row above must be flagging the script and nothing else.
    expect(findMissingHookCommandPaths("node /app/gone.js>/tmp/out", fsWith())).not.toContain(
      "/tmp/out",
    );
  });

  it("resolves the script behind an absolute env wrapper", () => {
    expect(
      findMissingHookCommandPaths("/usr/bin/env node /app/gone.js", fsWith("/usr/bin/env")),
    ).toEqual(["/app/gone.js"]);
  });
});

// BLO-29505 independent review (native-codex). Before this, every `-flag` was
// skipped and the *next* word was taken as the script, so an option that
// consumes a separate operand shadowed the real script: `python3 -X utf8
// /app/hook.py` resolved `utf8`, found no absolute path, and stopped — leaving
// a dead hook silently unaudited, which is the exact BLO-28782 failure this
// module exists to catch.
describe("findMissingHookCommandPaths — options that consume a separate operand", () => {
  it("reaches the script behind a node preload option, and audits both", () => {
    expect(
      findMissingHookCommandPaths("node --require /missing-preload.js /app/hook.js", fsWith()),
    ).toEqual(["/missing-preload.js", "/app/hook.js"]);
  });

  it("flags the script when only the script is missing", () => {
    // Non-vacuous control: the row above must not be passing because the
    // preload happens to absorb the finding.
    expect(
      findMissingHookCommandPaths(
        "node --require /app/pre.js /app/hook.js",
        fsWith("/app/pre.js"),
      ),
    ).toEqual(["/app/hook.js"]);
    expect(
      findMissingHookCommandPaths(
        "node -r /app/pre.js /app/hook.js",
        fsWith("/app/pre.js"),
      ),
    ).toEqual(["/app/hook.js"]);
  });

  it("reaches the script behind a python value option", () => {
    // `utf8` is a value, not a filename — it must be consumed and never stat'd.
    const stated: string[] = [];
    expect(
      findMissingHookCommandPaths("python3 -X utf8 /app/hook.py", {
        fileExists: (p) => {
          stated.push(p);
          return false;
        },
      }),
    ).toEqual(["/app/hook.py"]);
    expect(stated).toEqual(["/app/hook.py"]);
  });

  const operandCases: { label: string; command: string; expected: string[] }[] = [
    {
      label: "node --import",
      command: "node --import /app/reg.js /app/hook.js",
      expected: ["/app/reg.js", "/app/hook.js"],
    },
    {
      label: "node --loader",
      command: "node --loader /app/loader.mjs /app/hook.js",
      expected: ["/app/loader.mjs", "/app/hook.js"],
    },
    {
      label: "node --require= attached form",
      command: "node --require=/app/pre.js /app/hook.js",
      expected: ["/app/pre.js", "/app/hook.js"],
    },
    {
      label: "python -W filter",
      command: "python3 -W ignore /app/hook.py",
      expected: ["/app/hook.py"],
    },
    {
      label: "python -X then -W",
      command: "python3 -X utf8 -W ignore /app/hook.py",
      expected: ["/app/hook.py"],
    },
    {
      label: "perl -I include dir",
      command: "perl -I /opt/lib /app/hook.pl",
      expected: ["/app/hook.pl"],
    },
    {
      label: "ruby -I include dir",
      command: "ruby -I /opt/lib /app/hook.rb",
      expected: ["/app/hook.rb"],
    },
  ];

  for (const { label, command, expected } of operandCases) {
    it(`resolves the script past ${label}: \`${command}\``, () => {
      expect(findMissingHookCommandPaths(command, fsWith())).toEqual(expected);
    });
  }

  it("never stats a value operand", () => {
    // perl tolerates a missing `-I` directory silently, so flagging it would be
    // a false positive on a working command.
    const stated: string[] = [];
    findMissingHookCommandPaths("perl -I /opt/gone /app/hook.pl", {
      fileExists: (p) => {
        stated.push(p);
        return true;
      },
    });
    expect(stated).toEqual(["/app/hook.pl"]);
    expect(stated).not.toContain("/opt/gone");
  });

  it("keeps option meaning interpreter-scoped", () => {
    // The same spelling means opposite things per binary, and guessing either
    // way is a defect:
    //   php -r  is *code*   -> stop, never stat the command string
    //   node -r is a *path* -> audit it, then continue to the script
    expect(findMissingHookCommandPaths(`php -r "/app/gone.php"`, fsWith())).toEqual([]);
    //   python -I is isolated mode and takes no operand, so the very next word
    //   is still the script; perl's -I takes a directory.
    expect(findMissingHookCommandPaths("python3 -I /app/hook.py", fsWith())).toEqual([
      "/app/hook.py",
    ]);
  });
});

// Documented skips: these stay silent on purpose. Asserting them keeps the
// module header's stated limits honest — if a later change starts flagging one,
// a test fails rather than an operator getting a warning we cannot stand behind.
describe("findMissingHookCommandPaths — documented deliberate skips", () => {
  const skipCases: { label: string; command: string }[] = [
    { label: "bare argv[0] resolved via PATH", command: "ccrotate refresh-one" },
    { label: "relative path (cwd-dependent)", command: "node ./scripts/hook.js" },
    { label: "unquoted $VAR interpolation", command: "node $PAPERCLIP_HOME/cli/hook.js" },
    { label: "leading ~ (tilde expansion)", command: "bash ~/scripts/hook.sh" },
    { label: "glob in the path", command: "bash /app/*/hook.sh" },
    { label: "brace expansion", command: "bash /app/{a,b}/hook.sh" },
    { label: "command substitution", command: "bash $(which hook.sh)" },
    { label: "inner command of bash -c", command: `bash -c "node /app/gone.js"` },
    // An absolute path inside a `-c` string is a *command string*, not a
    // filename. Statting it would report `/app/gone.sh --force` missing — a
    // path with a space and a flag in it, which is a false positive of exactly
    // the kind this change removes.
    { label: "absolute path inside a bash -c string", command: `bash -c "/app/gone.sh --force"` },
    { label: "absolute path inside a sh -c string", command: `sh -c '/app/gone.sh && echo ok'` },
    { label: "node -e inline code", command: `node -e "require('/app/gone.js')"` },
    { label: "python3 -m module", command: "python3 -m /app/gone.py" },
    { label: "perl -e inline code", command: `perl -e '/app/gone.pl'` },
    { label: "--eval= attached form", command: `node --eval="/app/gone.js"` },
    { label: "second operand of an interpreter", command: "node /app/ok.js /app/gone.js" },
  ];

  for (const { label, command } of skipCases) {
    it(`stays silent for ${label}: \`${command}\``, () => {
      expect(findMissingHookCommandPaths(command, fsWith("/app/ok.js"))).toEqual([]);
    });
  }
});

describe("auditHookCommands", () => {
  it("audits all three hook settings", () => {
    expect(LIFECYCLE_HOOK_COMMAND_SETTINGS).toEqual([
      "preRunCmd",
      "postRunCmd",
      "quotaExhaustedCmd",
    ]);

    const findings = auditHookCommands(
      {
        preRunCmd: "node /app/server/dist/cli/ccrotate-state-hook.js import",
        postRunCmd: "node /app/server/dist/cli/ccrotate-state-hook.js export",
        quotaExhaustedCmd: "node /app/server/dist/cli/ccrotate-relogin-trigger.js",
      },
      fsWith("/app/server/dist/cli/ccrotate-state-hook.js"),
    );

    expect(findings).toEqual([
      {
        setting: "quotaExhaustedCmd",
        command: "node /app/server/dist/cli/ccrotate-relogin-trigger.js",
        missingPaths: ["/app/server/dist/cli/ccrotate-relogin-trigger.js"],
      },
    ]);
    expect(describeHookCommandFinding(findings[0])).toContain(
      "ccrotate-relogin-trigger.js",
    );
  });

  it("returns no findings when every hook resolves", () => {
    expect(
      auditHookCommands(
        {
          preRunCmd: "node /app/ok.js",
          postRunCmd: null,
          quotaExhaustedCmd: null,
        },
        fsWith("/app/ok.js"),
      ),
    ).toEqual([]);
  });
});

describe("auditConfiguredHookCommandsOnBoot", () => {
  it("records one activity row per company per finding", async () => {
    const findings = await auditConfiguredHookCommandsOnBoot({
      db: fakeDb,
      getGeneral: async () => ({
        preRunCmd: null,
        postRunCmd: null,
        quotaExhaustedCmd: "node /app/server/dist/cli/ccrotate-relogin-trigger.js",
      }),
      listCompanyIds: async () => ["company-a", "company-b"],
      deps: fsWith(),
    });

    expect(findings).toHaveLength(1);
    expect(vi.mocked(logActivity)).toHaveBeenCalledTimes(2);
    const [, payload] = vi.mocked(logActivity).mock.calls[0];
    expect(payload).toMatchObject({
      companyId: "company-a",
      action: LIFECYCLE_HOOK_COMMAND_UNRESOLVED_ACTION,
      entityType: "instance_settings",
      entityId: "quotaExhaustedCmd",
      details: {
        setting: "quotaExhaustedCmd",
        missingPaths: ["/app/server/dist/cli/ccrotate-relogin-trigger.js"],
        detectedAt: "boot",
      },
    });
  });

  it("stays quiet when hooks resolve", async () => {
    const findings = await auditConfiguredHookCommandsOnBoot({
      db: fakeDb,
      getGeneral: async () => ({
        preRunCmd: "node /app/ok.js",
        postRunCmd: null,
        quotaExhaustedCmd: null,
      }),
      listCompanyIds: async () => ["company-a"],
      deps: fsWith("/app/ok.js"),
    });

    expect(findings).toEqual([]);
    expect(vi.mocked(logActivity)).not.toHaveBeenCalled();
  });

  it("never throws when instance settings cannot be read", async () => {
    await expect(
      auditConfiguredHookCommandsOnBoot({
        db: fakeDb,
        getGeneral: async () => {
          throw new Error("db down");
        },
        listCompanyIds: async () => [],
      }),
    ).resolves.toEqual([]);
  });

  it("still returns findings when activity persistence fails", async () => {
    vi.mocked(logActivity).mockRejectedValueOnce(new Error("write failed"));
    const findings = await auditConfiguredHookCommandsOnBoot({
      db: fakeDb,
      getGeneral: async () => ({
        preRunCmd: null,
        postRunCmd: null,
        quotaExhaustedCmd: "node /app/gone.js",
      }),
      listCompanyIds: async () => ["company-a"],
      deps: fsWith(),
    });
    expect(findings).toHaveLength(1);
  });
});
