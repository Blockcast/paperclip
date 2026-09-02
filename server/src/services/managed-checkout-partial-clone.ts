/**
 * Keep managed project checkouts able to serve clones (BLO-31351 / BLO-31338).
 *
 * A `blob:none` partial clone is a perfectly healthy repository to *work* in and
 * a broken one to *clone from*. When an execution workspace clones a managed
 * mirror over `file://`, the mirror's `upload-pack` has to pack every object the
 * client asked for; it will not lazily fetch missing ones from its own promisor
 * remote on the client's behalf, so `git-pack-objects` dies and git reports:
 *
 *     fatal: git upload-pack: aborting due to possible repository corruption
 *            on the remote side.
 *
 * That message is false. Nothing is corrupt -- `git fsck` is clean and
 * `count-objects -v` reports zero garbage. The mechanism that gave up is not the
 * cause, and the remediation the text invites ("re-clone, it's corrupt") happens
 * to work while leaving the actual cause in place, which is exactly how this
 * recurred. Agent runs cloning such a mirror die `exit 128` before reaching
 * their first tool call.
 *
 * The operative condition is **missing objects, not the filter**. A partial
 * clone whose objects all happen to be present serves fine -- measured, exit 0,
 * with `promisor=true` still set. The filter is what *manufactures* missing
 * objects on each later fetch. So a mirror can pass a clone probe today and fail
 * tomorrow with no config change at all, which is why this is a provisioning
 * guard rather than a periodic sweep.
 *
 * Nothing in Paperclip *creates* a partial managed mirror: the only managed
 * clone is a plain `git clone <url> <cwd>` with no `--filter`/`--depth`. What it
 * does do is **adopt** whatever checkout already sits at the managed path,
 * uninspected. This module is that missing inspection.
 *
 * Two outcomes, and the split is the whole design:
 *
 * - **Objects all present** -> clear the partial-clone config so future fetches
 *   stop manufacturing missing objects. Non-fatal, local, and it does not touch
 *   refs, HEAD, the index or the working tree.
 * - **Objects already missing** -> the mirror cannot serve, so fail with the real
 *   reason. A run allowed to proceed dies anyway, just later and mislabelled as
 *   corruption on someone else's ticket.
 *
 * Ordering is deliberate and load-bearing: the config is cleared **only** when
 * nothing is missing. Unsetting `promisor` on a repository that still has
 * missing objects strands it in a state where it can neither serve them nor
 * lazily fetch them -- strictly worse than the trap being closed.
 *
 * Cost on the healthy path is two `git config --get` calls. The object scan runs
 * only when the cheap probe says the checkout is partial, which across the
 * estate is rare (measured 2026-09-02: 0 of 26 default mirrors).
 */

import { spawn } from "node:child_process";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/** Budget for the `git config` reads and unsets. */
export const PARTIAL_CLONE_CONFIG_TIMEOUT_MS = 10_000;

/**
 * Budget for the missing-object scan. Generous because it walks every reachable
 * object (measured ~345k on the mirror that triggered this), and bounded because
 * it sits on a provisioning path -- an inconclusive probe degrades to a warning
 * rather than taking the run down.
 */
export const PARTIAL_CLONE_MISSING_SCAN_TIMEOUT_MS = 120_000;

/**
 * Stop counting past this many missing objects. The remedy does not vary with
 * the exact figure above "enough to be unrepairable", and the count only exists
 * to tell an operator whether a targeted backfill is plausible. Reported counts
 * at the cap are marked truncated rather than presented as exact.
 */
export const PARTIAL_CLONE_MISSING_SCAN_CAP = 10_000;

export const REMOTE_ORIGIN_PARTIAL_CLONE_FILTER_KEY = "remote.origin.partialclonefilter";
export const REMOTE_ORIGIN_PROMISOR_KEY = "remote.origin.promisor";

export type ManagedCheckoutPartialCloneState =
  /** No git metadata at the path -- nothing to inspect. */
  | "not_a_checkout"
  /** Not a partial clone. The overwhelmingly common case. */
  | "not_partial"
  /** Was partial with every object present; the config has been cleared. */
  | "partial_repaired"
  /** Was partial with every object present, but the config could not be cleared. */
  | "partial_repair_failed"
  /** Partial AND missing objects: cannot serve a clone. Fatal. */
  | "partial_cannot_serve"
  /** Partial, but the object scan could not reach a verdict. */
  | "indeterminate";

export type ManagedCheckoutPartialCloneResult = {
  state: ManagedCheckoutPartialCloneState;
  filter: string | null;
  promisor: string | null;
  missingObjectCount: number | null;
  missingObjectCountTruncated: boolean;
  /** Non-fatal operator-facing note, if any. */
  warning: string | null;
  /**
   * Set only for `partial_cannot_serve`. The caller raises this as a workspace
   * validation failure; returning it rather than throwing keeps this module a
   * pure inspector and leaves the failure type to the layer that owns it.
   */
  fatalMessage: string | null;
  /** Structured detail for the failure's `workspaceValidation` payload. */
  evidence: Record<string, unknown>;
};

/** Injection seam for tests; defaults to a plain `execFile("git", ...)`. */
export type PartialCloneGitRunner = (args: string[], cwd: string) => Promise<string>;

/** Injection seam for tests; defaults to the streaming `git rev-list` scan below. */
export type MissingObjectCounter = (cwd: string) => Promise<{ count: number; truncated: boolean }>;

async function defaultRunGit(args: string[], cwd: string): Promise<string> {
  const result = await execFile("git", args, { cwd, timeout: PARTIAL_CLONE_CONFIG_TIMEOUT_MS });
  return result.stdout;
}

/**
 * Count objects git knows it does not have.
 *
 * Streamed and capped rather than buffered: `--missing=print` on a large
 * repository emits one line per object, which is tens of megabytes and would
 * exceed `execFile`'s default `maxBuffer` on exactly the repositories this
 * matters for. `--no-object-names` drops the path suffixes, leaving `?<oid>`
 * lines for the missing ones.
 */
export async function countMissingObjects(cwd: string): Promise<{ count: number; truncated: boolean }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["rev-list", "--objects", "--all", "--missing=print", "--no-object-names"],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );

    let count = 0;
    let truncated = false;
    let pending = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`git rev-list timed out after ${PARTIAL_CLONE_MISSING_SCAN_TIMEOUT_MS}ms`));
    }, PARTIAL_CLONE_MISSING_SCAN_TIMEOUT_MS);

    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ count, truncated });
    };

    const consume = (line: string) => {
      // `--missing=print` marks a missing object by prefixing its OID with "?".
      if (!line.startsWith("?")) return;
      count += 1;
      if (count >= PARTIAL_CLONE_MISSING_SCAN_CAP) {
        truncated = true;
        // The verdict cannot change past the cap, so stop paying for the walk.
        child.kill("SIGTERM");
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4_000) stderr += chunk;
    });

    // Once the cap is hit the answer is settled, and we killed the process
    // ourselves to stop paying for the walk. Both the kill and the resulting
    // write-to-closed-stdout can surface as an `error` event, and racing `close`
    // it would otherwise turn a decided "missing objects, cannot serve" into
    // `indeterminate` -- i.e. warn-and-proceed on the very worst repository,
    // which then dies later reporting fake corruption. Truncation wins over any
    // error, in both handlers.
    child.on("error", (error) => {
      if (truncated) return finish(null);
      finish(error instanceof Error ? error : new Error(String(error)));
    });
    child.stdout.on("error", () => {
      if (truncated) finish(null);
    });
    child.on("close", (code, signal) => {
      if (pending.length > 0) consume(pending);
      if (truncated) return finish(null);
      if (code === 0) return finish(null);
      // A genuine non-zero exit is reported, never swallowed as a low count: the
      // caller turns it into `indeterminate` and leaves the checkout alone
      // rather than "repairing" a repo whose object state is unknown.
      finish(new Error(`git rev-list exited ${code ?? signal ?? "unknown"}: ${stderr.trim()}`));
    });
  });
}

async function readConfigValue(
  runGit: PartialCloneGitRunner,
  cwd: string,
  key: string,
): Promise<string | null> {
  // Exit 1 with no output is git's "key is not set" -- a normal read outcome,
  // hence catch-to-null rather than rethrow.
  const raw = await runGit(["config", "--get", key], cwd).catch(() => null);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function describePartialCloneConfig(filter: string | null, promisor: string | null) {
  const parts: string[] = [];
  if (filter) parts.push(`${REMOTE_ORIGIN_PARTIAL_CLONE_FILTER_KEY}=${filter}`);
  if (promisor) parts.push(`${REMOTE_ORIGIN_PROMISOR_KEY}=${promisor}`);
  return parts.join(", ");
}

/**
 * Inspect the managed checkout at `cwd`, clearing a safe partial-clone config
 * and reporting an unservable one.
 *
 * Safe to call unconditionally on any managed-workspace path. A repo-less
 * directory is a no-op -- and that is not a nicety: `git config` walks *up* from
 * its cwd, so probing a plain directory nested under any ancestor repository
 * would read (and unset) that ancestor's config instead. This is the same hazard
 * `ensureCheckoutGitIdentity` documents.
 *
 * Only `partial_cannot_serve` is fatal, and the caller decides how to raise it.
 * Every other failure mode -- unreadable config, an unset that is refused, a
 * scan that stalls -- comes back as a warning, because none of them makes the
 * checkout less usable than leaving it alone would.
 */
export async function ensureManagedCheckoutCanServeClones(input: {
  cwd: string | null | undefined;
  runGit?: PartialCloneGitRunner;
  countMissing?: MissingObjectCounter;
}): Promise<ManagedCheckoutPartialCloneResult> {
  const cwd = typeof input.cwd === "string" && input.cwd.trim().length > 0 ? input.cwd : null;
  const base = {
    filter: null,
    promisor: null,
    missingObjectCount: null,
    missingObjectCountTruncated: false,
    warning: null,
    fatalMessage: null,
    evidence: {} as Record<string, unknown>,
  };
  if (!cwd) return { ...base, state: "not_a_checkout" };

  // lstat + isDirectory()||isFile(): a linked worktree records `.git` as a FILE
  // (a gitdir pointer), so an isDirectory()-only probe would skip a real
  // checkout.
  const hasGitMetadata = await fs
    .lstat(path.resolve(cwd, ".git"))
    .then((entry) => entry.isDirectory() || entry.isFile())
    .catch(() => false);
  if (!hasGitMetadata) return { ...base, state: "not_a_checkout" };

  const runGit = input.runGit ?? defaultRunGit;
  const filter = await readConfigValue(runGit, cwd, REMOTE_ORIGIN_PARTIAL_CLONE_FILTER_KEY);
  const promisor = await readConfigValue(runGit, cwd, REMOTE_ORIGIN_PROMISOR_KEY);
  // Either key alone is enough to make this a partial clone whose later fetches
  // manufacture missing objects, so this is a union rather than a conjunction.
  if (!filter && !promisor) return { ...base, state: "not_partial" };

  const configDescription = describePartialCloneConfig(filter, promisor);
  const evidence: Record<string, unknown> = {
    cwd,
    partialCloneFilter: filter,
    partialClonePromisor: promisor,
  };

  const countMissing = input.countMissing ?? countMissingObjects;
  let missing: { count: number; truncated: boolean };
  try {
    missing = await countMissing(cwd);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      state: "indeterminate",
      filter,
      promisor,
      warning:
        `Managed checkout "${cwd}" is a partial clone (${configDescription}), and Paperclip could not ` +
        `determine whether it is missing objects: ${reason}. Leaving it untouched. If a later clone from ` +
        `this path fails with "possible repository corruption on the remote side", the cause is the ` +
        `partial-clone config recorded here and not a damaged repository.`,
      evidence: { ...evidence, missingObjectScanError: reason },
    };
  }

  evidence.missingObjectCount = missing.count;
  evidence.missingObjectCountTruncated = missing.truncated;

  if (missing.count > 0) {
    const countLabel = missing.truncated ? `at least ${missing.count}` : `${missing.count}`;
    return {
      ...base,
      state: "partial_cannot_serve",
      filter,
      promisor,
      missingObjectCount: missing.count,
      missingObjectCountTruncated: missing.truncated,
      evidence,
      fatalMessage:
        `Managed checkout "${cwd}" is a partial clone (${configDescription}) missing ${countLabel} objects, ` +
        `so it cannot serve a clone to an execution workspace. Git reports this as "possible repository ` +
        `corruption on the remote side", which is false -- the repository is intact and \`git fsck\` is clean; ` +
        `\`upload-pack\` simply will not lazily fetch the objects it lacks on a client's behalf. ` +
        `Re-cloning this path as a full clone fixes it; so does backfilling the missing objects ` +
        `(\`git fetch origin\`, then unset ${REMOTE_ORIGIN_PARTIAL_CLONE_FILTER_KEY} and ` +
        `${REMOTE_ORIGIN_PROMISOR_KEY} in that order) when they are still reachable on the remote.`,
    };
  }

  // Nothing missing, so the filter is a latent trap rather than a live fault:
  // clearing it now is safe and stops the next fetch from re-arming it.
  const unsetFailures: string[] = [];
  for (const key of [REMOTE_ORIGIN_PARTIAL_CLONE_FILTER_KEY, REMOTE_ORIGIN_PROMISOR_KEY]) {
    const present = key === REMOTE_ORIGIN_PARTIAL_CLONE_FILTER_KEY ? filter : promisor;
    if (!present) continue;
    const failure = await runGit(["config", "--unset", key], cwd).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    if (failure) unsetFailures.push(`${key}: ${failure}`);
  }

  if (unsetFailures.length > 0) {
    return {
      ...base,
      state: "partial_repair_failed",
      filter,
      promisor,
      missingObjectCount: 0,
      evidence: { ...evidence, unsetFailures },
      warning:
        `Managed checkout "${cwd}" is a partial clone (${configDescription}) with no missing objects, so it ` +
        `still serves clones today, but Paperclip could not clear the partial-clone config: ` +
        `${unsetFailures.join("; ")}. Every later fetch can reintroduce missing objects and break clones ` +
        `from this path.`,
    };
  }

  return {
    ...base,
    state: "partial_repaired",
    filter,
    promisor,
    missingObjectCount: 0,
    evidence,
    warning:
      `Managed checkout "${cwd}" was a partial clone (${configDescription}) with no missing objects. Cleared ` +
      `${REMOTE_ORIGIN_PARTIAL_CLONE_FILTER_KEY} and ${REMOTE_ORIGIN_PROMISOR_KEY} so later fetches cannot ` +
      `reintroduce missing objects and break execution-workspace clones from this path.`,
  };
}
