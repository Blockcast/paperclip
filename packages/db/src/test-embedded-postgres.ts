import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyPendingMigrations, ensurePostgresDatabase } from "./client.js";
import {
  prepareEmbeddedPostgresNativeRuntime,
  resolveEmbeddedPostgresPackageRoot,
} from "./embedded-postgres-native.js";
import { endTrackedClients, trackTestDatabase } from "./embedded-test-client-registry.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

export type EmbeddedPostgresTestSupport = {
  supported: boolean;
  reason?: string;
};

export type EmbeddedPostgresTestDatabase = {
  connectionString: string;
  cleanup(): Promise<void>;
};

let embeddedPostgresSupportPromise: Promise<EmbeddedPostgresTestSupport> | null = null;
let templateKey: string | undefined;

const DEFAULT_PAPERCLIP_EMBEDDED_POSTGRES_PORT = 54329;
const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

function getReservedTestPorts(): Set<number> {
  const configuredPorts = [
    DEFAULT_PAPERCLIP_EMBEDDED_POSTGRES_PORT,
    Number.parseInt(process.env.PAPERCLIP_EMBEDDED_POSTGRES_PORT ?? "", 10),
    ...String(process.env.PAPERCLIP_TEST_POSTGRES_RESERVED_PORTS ?? "")
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10)),
  ];
  return new Set(configuredPorts.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535));
}

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  await prepareEmbeddedPostgresNativeRuntime();
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  const reservedPorts = getReservedTestPorts();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close(() => reject(new Error("Failed to allocate test port")));
          return;
        }
        const { port } = address;
        server.close((error) => {
          if (error) reject(error);
          else resolve(port);
        });
      });
    });

    if (!reservedPorts.has(port)) return port;
  }

  throw new Error(
    `Failed to allocate embedded Postgres test port outside reserved Paperclip ports: ${[
      ...reservedPorts,
    ].join(", ")}`,
  );
}

// PEN-3381 -- why this startup reports itself, and why it changes no deadline.
//
// `startEmbeddedPostgresTestDatabase` runs in a `beforeAll` riding the package
// `hookTimeout: 120_000` (server/vitest.config.ts, packages/db/vitest.config.ts), and it
// has crossed it: `issue-subtree-diagnostics-routes.test.ts` was killed 99 ms past the
// deadline on merge_group job 132711124139 (2026-11-15T06:12Z) reporting
// `Tests 689 passed | 0 failed` -- a false red under `Failed Suites`, on a queue ref whose
// PR had not touched that file.
//
// The budget is NOT marginal and a bigger one is not the remedy. Measured over 930
// embedded-Postgres file executions across 19 `General tests (server N/6)` logs, whole-file
// elapsed -- an UPPER bound on this function, since it also carries fork spawn, imports, the
// tests themselves and `afterAll` -- runs p50 3.5 s / p95 12.4 s / p99 20.6 s, i.e. 5.8x-33x
// of margin against 120 s. The crossings are EXCURSIONS two orders of magnitude off the mode
// on files whose own median is seconds (`invite-list-route` 1187 / 2809 / 83780 ms; the file
// above 2700 / 6498 / 120099 ms), so no multiple of the healthy cost is a principled cover
// for them, and a ceiling derived from that population would LOWER the budget rather than
// raise it.
//
// What nothing recorded was WHICH PHASE excurses. The EmbeddedPostgres constructor below is
// handed `onLog`/`onError` no-ops and not one of the six steps was timed, so an 83 s or a
// 120 s start left no evidence of its own shape anywhere, ever. This records that and
// asserts nothing: no deadline moves, nothing here can fail a test, and the slow-phase
// watchdog LOGS ONLY -- it never rejects, so a slow start that would have succeeded still
// succeeds. Read the resulting `start ok in N ms` lines to derive a real ceiling; until
// then no number in this file is a measurement of this function.

/**
 * p99 of that 930-execution population, rounded up. It is an upper bound on this function
 * rather than a measurement of it, so a phase still running past it is outside everything
 * the healthy distribution does, by the distribution's own generous reading.
 */
const EMBEDDED_PG_START_P99_CEILING_MS = 21_000;
/**
 * Headroom over that ceiling before a phase is called slow, so an ordinary tail stays quiet.
 * 1.5x is what this repo's other watchdogs-over-a-measured-ceiling use (`FIXTURE_WATCHDOG_HEADROOM`,
 * server/src/__tests__/graceful-shutdown-exit.test.ts). Bounded at the top by the hook budget
 * below: the line's entire value is landing in the job log BEFORE vitest kills the hook, and
 * at 31_500 ms the first tick lands with 88.5 s to spare.
 */
const EMBEDDED_PG_START_WATCHDOG_HEADROOM = 1.5;
const EMBEDDED_PG_START_SLOW_PHASE_MS =
  EMBEDDED_PG_START_P99_CEILING_MS * EMBEDDED_PG_START_WATCHDOG_HEADROOM;
/**
 * The `hookTimeout` the suites calling this run under. It is duplicated here deliberately and
 * is NOT load-bearing: it bounds only how many lines an abandoned watchdog may write after
 * vitest has given up on the hook. If either vitest config moves, the sole consequence here is
 * a few more or fewer log lines -- never a behaviour change, and never a test outcome.
 */
const EMBEDDED_PG_CALLER_HOOK_TIMEOUT_MS = 120_000;
/** Most recent server lines kept for the slow/failed report. Discarded otherwise. */
const EMBEDDED_PG_RECENT_SERVER_LINES = 5;

export type EmbeddedPostgresStartupDiagnostics = {
  /** Times `run` under `name` and reports it in the summary line. Never alters the result. */
  phase<T>(name: string, run: () => Promise<T> | T): Promise<T>;
  /** Buffers one line of server output; printed only if the start is slow or fails. */
  note(message: unknown): void;
  /** Stops the watchdog and writes the one-line phase breakdown. Idempotent. */
  finish(outcome: "ok" | "failed"): void;
};

export function createEmbeddedPostgresStartupDiagnostics(
  label: string,
  {
    slowPhaseMs = EMBEDDED_PG_START_SLOW_PHASE_MS,
    hookTimeoutMs = EMBEDDED_PG_CALLER_HOOK_TIMEOUT_MS,
    now = Date.now,
    info = (line: string) => console.log(line),
    warn = (line: string) => console.warn(line),
  }: {
    slowPhaseMs?: number;
    hookTimeoutMs?: number;
    now?: () => number;
    info?: (line: string) => void;
    warn?: (line: string) => void;
  } = {},
): EmbeddedPostgresStartupDiagnostics {
  const startedAt = now();
  const completed: string[] = [];
  const recent: string[] = [];
  let current: string | null = null;
  let currentStartedAt = startedAt;
  let finished = false;
  // A hook vitest has killed never reaches finish(), so the interval would otherwise
  // report forever. One tick past the hook budget is enough to name the phase it died in.
  const maxTicks = Math.ceil(hookTimeoutMs / slowPhaseMs) + 1;
  let ticks = 0;

  const breakdown = () =>
    [...completed, current ? `${current}=${now() - currentStartedAt}ms(running)` : null]
      .filter((part): part is string => part !== null)
      .join(" ") || "(no phase started)";

  const watchdog = setInterval(() => {
    ticks += 1;
    if (ticks >= maxTicks) clearInterval(watchdog);
    warn(
      `[test-embedded-postgres] ${label} slow start: ${now() - startedAt} ms so far -- ${breakdown()}` +
        (recent.length > 0 ? ` -- last server output: ${recent.join(" | ")}` : " -- no server output"),
    );
  }, slowPhaseMs);
  // Never hold the worker open on this timer.
  watchdog.unref();

  return {
    async phase(name, run) {
      current = name;
      currentStartedAt = now();
      try {
        return await run();
      } finally {
        completed.push(`${name}=${now() - currentStartedAt}ms`);
        current = null;
      }
    },
    note(message) {
      const text = String(message ?? "").trim();
      if (text.length === 0) return;
      recent.push(text.slice(0, 200));
      if (recent.length > EMBEDDED_PG_RECENT_SERVER_LINES) recent.shift();
    },
    finish(outcome) {
      if (finished) return;
      finished = true;
      clearInterval(watchdog);
      info(
        `[test-embedded-postgres] ${label} start ${outcome} in ${now() - startedAt} ms -- ${breakdown()}`,
      );
    },
  };
}

async function createEmbeddedPostgresTestInstance(
  tempDirPrefix: string,
  diagnostics?: EmbeddedPostgresStartupDiagnostics,
) {
  // Place the throwaway PG data dir under EMBEDDED_POSTGRES_DATA_ROOT when set.
  // The ARC self-hosted runners point this at a tmpfs mount so initdb's fsync
  // storm runs in RAM instead of on the contended shared host disk, which was
  // the dominant cost of the release verify_canary embedded-Postgres timeouts
  // (BLO-17026). Unset elsewhere (local dev, ubuntu-latest) -> os.tmpdir(), so
  // behavior is unchanged there.
  const dataRoot = process.env.EMBEDDED_POSTGRES_DATA_ROOT || os.tmpdir();
  const dataDir = fs.mkdtempSync(path.join(dataRoot, tempDirPrefix));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    // Still discarded when nobody is watching (probe, template build). With a sink the
    // last few lines are buffered and printed only if the start is slow or fails, which
    // is the only evidence of WHY `start` is stalling that exists at all (PEN-3381).
    onLog: (message) => diagnostics?.note(message),
    onError: (message) => diagnostics?.note(message),
  });

  return { dataDir, port, instance };
}

function cleanupEmbeddedPostgresTestDirs(dataDir: string) {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

function formatEmbeddedPostgresError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return "embedded Postgres startup failed";
}

async function probeEmbeddedPostgresSupport(): Promise<EmbeddedPostgresTestSupport> {
  let dataDir: string | null = null;
  let instance: EmbeddedPostgresInstance | null = null;

  try {
    const created = await createEmbeddedPostgresTestInstance(
      "paperclip-embedded-postgres-probe-",
    );
    dataDir = created.dataDir;
    instance = created.instance;
    await instance.initialise();
    await instance.start();
    return { supported: true };
  } catch (error) {
    return {
      supported: false,
      reason: formatEmbeddedPostgresError(error),
    };
  } finally {
    await instance?.stop().catch(() => {});
    if (dataDir) cleanupEmbeddedPostgresTestDirs(dataDir);
  }
}

/**
 * Names the template after what decides its contents: the embedded-postgres
 * version and every file the migrator reads, i.e. the .sql files and the
 * journal (the meta/ snapshots only feed `drizzle-kit generate`).
 */
export function embeddedPostgresTemplateKey(
  migrationsDir = MIGRATIONS_DIR,
  embeddedPostgresVersion = readEmbeddedPostgresVersion(),
): string {
  const hash = createHash("sha256").update(`embedded-postgres ${embeddedPostgresVersion}\n`);
  const sqlFiles = fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
  for (const file of [...sqlFiles, "meta/_journal.json"]) {
    const content = fs.readFileSync(path.join(migrationsDir, file));
    hash.update(`${file} ${content.length}\n`).update(content);
  }
  return hash.digest("hex").slice(0, 16);
}

function readEmbeddedPostgresVersion(): string {
  const packageRoot = resolveEmbeddedPostgresPackageRoot();
  if (!packageRoot) throw new Error("embedded-postgres is not installed");
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  return String(manifest.version);
}

// initdb, the paperclip database and every migration, as each suite used to
// do it, into a stopped cluster under EMBEDDED_POSTGRES_DATA_ROOT.
async function buildMigratedTemplateCluster(): Promise<string> {
  const { dataDir, port, instance } = await createEmbeddedPostgresTestInstance(
    "paperclip-pg-template-build-",
  );
  try {
    await instance.initialise();
    await instance.start();
    await ensurePostgresDatabase(`postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`, "paperclip");
    await applyPendingMigrations(`postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`);
    await instance.stop();
    // stop() resolves when the postmaster exits, however it exits. A clean
    // shutdown removes postmaster.pid; a copy of a crashed cluster is not used.
    if (fs.existsSync(path.join(dataDir, "postmaster.pid"))) {
      throw new Error("template cluster did not shut down cleanly");
    }
    return dataDir;
  } catch (error) {
    await instance.stop().catch(() => {});
    cleanupEmbeddedPostgresTestDirs(dataDir);
    throw error;
  }
}

// The build runs while Vitest collects a suite, which has no timeout, so a
// hung migration would otherwise stall the job until its step timeout. Past
// the deadline the suites take the per-suite path, where hookTimeout applies,
// and a build that finishes late is removed rather than published.
const TEMPLATE_BUILD_TIMEOUT_MS = 5 * 60_000;

async function withBuildDeadline(build: Promise<string>, timeoutMs: number): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void build.then(cleanupEmbeddedPostgresTestDirs, () => {});
      reject(new Error(`template build did not finish within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([build, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One migrated template cluster per CI job, copied for each suite.
 *
 * Every DB suite used to run initdb and all migrations in its own cluster,
 * after a throwaway probe cluster: a 7.7-10.9 s floor even for a one-test file,
 * paid per file because the server suites fork per file. A suite now copies a
 * stopped, migrated cluster and starts it; applyPendingMigrations still runs
 * and returns at its up-to-date check.
 *
 * Only under EMBEDDED_POSTGRES_DATA_ROOT, the ARC runner's per-pod tmpfs, which
 * goes away with the job. Not under os.tmpdir(): run-vitest-stable.mjs points
 * TMPDIR at a new /tmp/pcvt-* directory for every Vitest invocation and never
 * removes it, so a template there would be rebuilt per invocation and left
 * behind. PAPERCLIP_TEST_PG_TEMPLATE=0 restores a fresh cluster per suite.
 */
export async function ensureEmbeddedPostgresTemplate(
  buildCluster: () => Promise<string> = buildMigratedTemplateCluster,
  buildTimeoutMs = TEMPLATE_BUILD_TIMEOUT_MS,
): Promise<string | null> {
  const dataRoot = process.env.EMBEDDED_POSTGRES_DATA_ROOT;
  if (!dataRoot || process.env.PAPERCLIP_TEST_PG_TEMPLATE === "0") return null;
  let builtDir: string | null = null;
  try {
    templateKey ??= embeddedPostgresTemplateKey();
    const templateDir = path.join(dataRoot, `paperclip-pg-template-${templateKey}`);
    if (fs.existsSync(templateDir)) return templateDir;
    // mkdir is the atomic claim: one process per job builds the template. It is
    // never released, so after a failed or killed build every suite keeps the
    // per-suite path: nobody waits on it, and a broken migration is not built
    // twice per suite.
    try {
      fs.mkdirSync(`${templateDir}.lock`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }
    const startedAt = Date.now();
    builtDir = await withBuildDeadline(buildCluster(), buildTimeoutMs);
    // rename is atomic, so a reader sees the whole template or none of it.
    fs.renameSync(builtDir, templateDir);
    console.log(
      `[test-embedded-postgres] built migrated template ${templateDir} in ${Date.now() - startedAt} ms`,
    );
    return templateDir;
  } catch (error) {
    if (builtDir) cleanupEmbeddedPostgresTestDirs(builtDir);
    console.warn(
      `[test-embedded-postgres] no migrated template, each suite builds its own cluster: ${formatEmbeddedPostgresError(error)}`,
    );
    return null;
  }
}

export function copyEmbeddedPostgresTemplate(templateDir: string, dataDir: string): void {
  // dataDir already exists (mkdtemp, 0700), so cpSync copies the template's
  // contents into it and leaves its mode alone. Postgres refuses a data
  // directory that is not 0700 or 0750; the chmod only makes that explicit.
  fs.cpSync(templateDir, dataDir, { recursive: true });
  fs.chmodSync(dataDir, 0o700);
}

export async function getEmbeddedPostgresTestSupport(): Promise<EmbeddedPostgresTestSupport> {
  if (!embeddedPostgresSupportPromise) {
    // A template on disk means initdb and start already work on this host, so
    // the throwaway probe cluster is skipped.
    embeddedPostgresSupportPromise = ensureEmbeddedPostgresTemplate().then((templateDir) =>
      templateDir ? { supported: true } : probeEmbeddedPostgresSupport(),
    );
  }
  return await embeddedPostgresSupportPromise;
}

export async function startEmbeddedPostgresTestDatabase(
  tempDirPrefix: string,
): Promise<EmbeddedPostgresTestDatabase> {
  let dataDir: string | null = null;
  let instance: EmbeddedPostgresInstance | null = null;
  const diagnostics = createEmbeddedPostgresStartupDiagnostics(tempDirPrefix);

  try {
    const templateDir = await diagnostics.phase("ensure-template", () =>
      ensureEmbeddedPostgresTemplate(),
    );
    // Port allocation, the embedded-postgres import and the native-runtime symlinks are
    // timed together: if `create-instance` ever reads hot, split it then rather than now.
    const created = await diagnostics.phase("create-instance", () =>
      createEmbeddedPostgresTestInstance(tempDirPrefix, diagnostics),
    );
    dataDir = created.dataDir;
    instance = created.instance;
    const { port } = created;
    if (templateDir) {
      const target = created.dataDir;
      await diagnostics.phase("copy-template", () =>
        copyEmbeddedPostgresTemplate(templateDir, target),
      );
    } else {
      await diagnostics.phase("initdb", () => created.instance.initialise());
    }
    await diagnostics.phase("start", () => created.instance.start());

    const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await diagnostics.phase("ensure-database", () =>
      ensurePostgresDatabase(adminConnectionString, "paperclip"),
    );
    const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    trackTestDatabase(connectionString);
    await diagnostics.phase("apply-migrations", () => applyPendingMigrations(connectionString));
    diagnostics.finish("ok");

    return {
      connectionString,
      cleanup: async () => {
        // Close any createDb() client pools opened against this database BEFORE
        // stopping the server, so postgres.js doesn't emit an unhandled
        // `write CONNECTION_CLOSED` rejection when the socket is torn down
        // (which fails the whole vitest process despite all tests passing).
        await endTrackedClients(connectionString);
        await instance?.stop().catch(() => {});
        if (dataDir) cleanupEmbeddedPostgresTestDirs(dataDir);
      },
    };
  } catch (error) {
    // Before the teardown, which has its own unbounded cost on a contended runner.
    diagnostics.finish("failed");
    await instance?.stop().catch(() => {});
    if (dataDir) cleanupEmbeddedPostgresTestDirs(dataDir);
    throw new Error(
      `Failed to start embedded PostgreSQL test database: ${formatEmbeddedPostgresError(error)}`,
    );
  }
}
