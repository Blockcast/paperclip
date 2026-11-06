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

async function createEmbeddedPostgresTestInstance(tempDirPrefix: string) {
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
    onLog: () => {},
    onError: () => {},
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

  try {
    const templateDir = await ensureEmbeddedPostgresTemplate();
    const created = await createEmbeddedPostgresTestInstance(tempDirPrefix);
    dataDir = created.dataDir;
    instance = created.instance;
    const { port } = created;
    if (templateDir) {
      copyEmbeddedPostgresTemplate(templateDir, dataDir);
    } else {
      await instance.initialise();
    }
    await instance.start();

    const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminConnectionString, "paperclip");
    const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    trackTestDatabase(connectionString);
    await applyPendingMigrations(connectionString);

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
    await instance?.stop().catch(() => {});
    if (dataDir) cleanupEmbeddedPostgresTestDirs(dataDir);
    throw new Error(
      `Failed to start embedded PostgreSQL test database: ${formatEmbeddedPostgresError(error)}`,
    );
  }
}
