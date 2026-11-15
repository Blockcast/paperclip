/**
 * Read a checkout's LOCAL git config without spawning git (BLO-56438, BLO-57549).
 *
 * Every `git` spawn forks the ~1.6 GB worker and costs it event-loop time, and
 * the hot paths that read local config (origin reconciler, push guard, agent
 * identity) run per checkout per dispatch. This matches `git config --local
 * --get <key>` (last value wins, no includes) and returns `undefined` -- "ask
 * git" -- whenever its answer could differ from git's.
 */
import fs from "node:fs/promises";
import path from "node:path";

/**
 * `undefined` when there is no `.git` at `cwd` (cwd may be a subdirectory or a
 * bare repo) or the file is in a shape the parser declines. A linked worktree's
 * local config is the common dir's `config`, as for `git config --local`.
 */
export async function readLocalGitConfigValue(cwd: string, key: string): Promise<string | null | undefined> {
  const dotGit = path.join(cwd, ".git");
  const stat = await fs.stat(dotGit).catch(() => null);
  if (!stat) return undefined;
  let gitDir = dotGit;
  if (stat.isFile()) {
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(await fs.readFile(dotGit, "utf8"));
    if (!match) return undefined;
    gitDir = path.resolve(cwd, match[1]);
    const commondir = await fs.readFile(path.join(gitDir, "commondir"), "utf8").catch(() => null);
    if (commondir !== null) gitDir = path.resolve(gitDir, commondir.trim());
  }
  const text = await fs.readFile(path.join(gitDir, "config"), "utf8");
  return parseGitConfigValue(text, key);
}

/**
 * `key` is `section.name` or `section.subsection.name`. Section and name compare
 * case-insensitively, the subsection exactly, as git does. Declines (undefined)
 * on `include`/`includeIf`, legacy `[section.sub]` headers, a header sharing its
 * line with a value, a bare boolean `name` line for the key, or a value carrying
 * quotes, escapes or comment characters.
 */
export function parseGitConfigValue(text: string, key: string): string | null | undefined {
  const parts = key.split(".");
  if (parts.length < 2) return undefined;
  const wantSection = parts[0].toLowerCase();
  const wantName = parts[parts.length - 1].toLowerCase();
  const wantSubsection = parts.length > 2 ? parts.slice(1, -1).join(".") : undefined;
  let inSection = false;
  let value: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"([^"\\]*)")?\s*\]$/.exec(line);
      if (!header) return undefined;
      const section = header[1].toLowerCase();
      if (section === "include" || section === "includeif" || section.includes(".")) return undefined;
      inSection = section === wantSection && header[2] === wantSubsection;
      continue;
    }
    if (!inSection) continue;
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!kv || kv[1].toLowerCase() !== wantName) continue;
    if (kv[2] === undefined) return undefined;
    const candidate = kv[2].trim();
    if (/["\\#;]/.test(candidate)) return undefined;
    value = candidate;
  }
  return value;
}
