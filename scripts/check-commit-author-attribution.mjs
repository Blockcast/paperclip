#!/usr/bin/env node
/**
 * check-commit-author-attribution.mjs (BLO-21416)
 *
 * GitHub REST commit-creation endpoints (contents/merge API, MCP
 * `create_or_update_file`/`push_files`) default `commit.author` to the
 * authenticated identity when none is supplied. Every agent pod shares one
 * credential — the `allyblockcast[bot]` GitHub App installation (id
 * 290875700) — so any agent writing via that path gets stamped with the App,
 * not the acting agent. `git push` is NOT subject to that server-side
 * default: it takes its identity from the per-run `GIT_AUTHOR_*` /
 * `GIT_COMMITTER_*` environment overlay applied to every adapter process
 * (`applyAgentGitIdentityToRuntimeConfig`, BLO-29050), which outranks the
 * local, global and system config files. So a `git push` commit is
 * correctly attributed regardless of what the checkout's config holds, and
 * `git config user.email` is NOT a useful diagnostic for a failure here —
 * read the commit itself (`git log -1 --pretty='%an <%ae>'`). The
 * 2026-08-10 sweep of 71 checkouts (BLO-23894) that found 11 App-stamped
 * and 18 identity-less local configs predates that overlay and is now
 * historical. See AGENTS.md §9 and the BLO-21416 issue for the full
 * writeup.
 *
 * Two independent modes, one shared assertion (`findAttributionOffenses`):
 *
 *   1. Local range mode (default; no network; used as a per-PR CI gate).
 *      Reads non-merge commits already present in a local checkout across a
 *      base..head range via `git log --no-merges`. `--no-merges` excludes
 *      TWO-PARENT merge commits, which are legitimately App-attributed
 *      because they carry no authored content (BLO-21416's scope boundary).
 *
 *      It does NOT exclude a squash-merge commit: a squash has exactly ONE
 *      parent, so `--no-merges` keeps it. This docblock previously claimed
 *      "merge/squash-merge commits" were both excluded here and both
 *      legitimate; that was wrong on the mechanism (BLO-39345). The reason
 *      mode 1 never rejects a squash commit is not that it is excluded —
 *      it is that the commit DOES NOT EXIST YET when this gate runs. GitHub
 *      creates it at merge time, after the last `pull_request` run. Nothing
 *      re-evaluates it afterwards, which is what mode 3 below is for.
 *
 *   2. `--audit-merged` mode (network via `gh`; the AC's "automated
 *      verifying signal"). Selects PRs by MERGE TIME — every PR merged on or
 *      after `--since` (default 7d) across one or more repos — fetches each
 *      PR's own commit list and applies the same assertion. A PR's `/commits`
 *      entries are pre-squash source commits, each with exactly one parent
 *      unless the branch merged another ref in (multi-parent → excluded, same
 *      merge-commit exception as mode 1).
 *
 *      The window is a claim the tool can prove: it either audits every PR
 *      merged since that date, or reports INCOMPLETE. It deliberately does not
 *      offer a "last N merged PRs" mode — `gh pr list` orders by creation, so
 *      no count-based window can establish which PRs merged most recently.
 *
 *   3. Merge-produced commit check, folded into mode 2 (BLO-39345). Modes 1
 *      and 2 both read a PR's OWN commits, so neither can see the commit
 *      GitHub creates AT merge time. A squash-merge of a PR whose commits
 *      have two or more distinct authors is stamped with the PR author —
 *      the shared App, for every agent PR — and because that commit is born
 *      after the last `pull_request` run, no workflow ever evaluates it.
 *
 *      Measured 2026-10-02 over the 300 most recently updated merged PRs
 *      (merged 2026-09-14 .. 2026-10-02), merge method classified from the
 *      full commit message:
 *
 *        squash,  >=2 distinct commit authors    2 PRs   2 re-stamped (100%)
 *        squash,  1 author                       1 PR    0
 *        rebase,  >=2 distinct commit authors    82 PRs  0
 *        rebase,  1 author                      213 PRs  0
 *
 *      The 82 multi-author rebases are the control: multi-authorship alone
 *      does not cause it, and the master queue's REBASE path is clean. The
 *      two instances are c3020290b (PR #1953, master) and 0c1a89128
 *      (PR #1701, base `track-a-landing-log` — so this is NOT master-only).
 *
 *      `findMergeAttributionOffense` deliberately does NOT classify the merge
 *      method. A rebase merge preserves the original author, so a rebased
 *      merge commit is App-attributed only when its source commit already
 *      was — which the head-side check already reports. Keying on
 *      "merge commit is App-attributed AND the PR's own commits were not"
 *      isolates re-stamping on any merge method, including ones GitHub has
 *      not shipped yet, without a message-shape heuristic that would rot.
 *
 *      Severity note, so nobody over-reads a finding: GitHub puts every
 *      original author in `Co-authored-by:` trailers on the squash commit
 *      (3/3 and 2/2 on the two instances above). Attribution is DEMOTED out
 *      of the author field, not erased as in BLO-21416, so the finding
 *      reports whether the trailers still cover the lost authors.
 *
 * Both modes are read-only: this script never posts, comments, or writes.
 *
 * ## Grandfathered pre-cutoff commits use patch-id plus author, not raw SHA (BLO-23894)
 *
 * The local-range gate (mode 1, the one that actually blocks a PR) clears a
 * commit if its stable patch-id and exact author email are in
 * `GRANDFATHERED_OFFENSE_SHAS` — an explicit, enumerated allowlist of the
 * specific pre-existing App-attributed commits
 * that predate the gate itself (`e7162b906` / `3fa6e41d8`, landed
 * `ATTRIBUTION_GATE_CUTOFF`). Those commits cannot be brought into
 * compliance: the App stamp already erased the acting agent's identity, so
 * there is no correct author to rewrite them to, and guessing one would
 * write a false attribution — the exact harm this gate exists to prevent.
 * Squashing or force-pushing to "fix" one is worse still: it relabels other
 * contributors' correctly-attributed commits, or rewrites/orphans history
 * that predates the rule.
 *
 * This grandfathering used to key on `authorDate < cutoff` instead of a SHA
 * allowlist. That was reverted: `authorDate` is caller-controlled
 * (`GIT_AUTHOR_DATE`, `git commit --date`) on the `git push` write path this
 * gate also has to police (see AGENTS.md §9 — 11-of-71 sampled checkouts
 * already carry a misconfigured local identity), so a date cutoff can be
 * defeated by backdating a brand-new, otherwise-non-compliant commit straight
 * past the gate. A patch-id is derived from the patch content, not its parent,
 * so it survives a queue rebase while remaining finite and enumerated. The
 * allowlist was built by
 * enumerating every commit meeting the App-identity/non-merge/pre-cutoff
 * predicate across every open `Blockcast/paperclip` PR as of the audit below;
 * it is not a standing exemption; it does not grow.
 *
 * The master queue's ruleset 20487141 sets `merge_queue.merge_method: REBASE`.
 * The queue therefore rewrites the SHA but preserves patch-id and author email,
 * so the grandfathered PR stays clear across queue staging without any
 * date-keyed fallback that would reopen the backdating hole.
 *
 * `--audit-merged` mode deliberately does NOT apply this allowlist — it is
 * advisory only (never blocks a merge) and stays a complete historical
 * record, including pre-cutoff violations, so `findAttributionOffenses` only
 * filters by allowlist when a caller opts in via `{ allowlist }`.
 *
 * Patch-id keying is rebase-safe but deliberately NOT scope-change-safe: a
 * grandfathered PR that is *edited* — a conflict resolution that drops a hunk,
 * a review fixup — changes its patch and falls off the list by design. That is
 * correct. The exemption was granted to one specific unrecoverable patch, not
 * to a PR number, so it should not follow the patch as it becomes different
 * work. The remedy for a dropped-off commit is the re-attribution check below,
 * not a re-pin.
 *
 * ### Before treating an App-attributed commit as unfixable, look the author up
 *
 * The grandfather clause is for commits whose author is genuinely lost — NOT
 * for commits nobody looked up. Query the Paperclip run record first: find the
 * run whose comments describe this commit's work within minutes of its author
 * date (runs routinely name the SHA they just created, so this is usually a
 * citation rather than timestamp inference). If the author is recoverable,
 * re-attribute the commit — `git commit --amend --author=…`, preserving the
 * author date, proving the content is unchanged with `git patch-id --stable`
 * on both sides — and do NOT request an allowlist entry. That path shrinks
 * this list instead of growing it and touches no security control; it is how
 * PRs #1126 and #1161 were landed (BLO-27142).
 *
 * ## The App stamps its noreply address in more than one spelling (BLO-26647)
 *
 * This predicate used to be a single `!==` against the one
 * `290875700+allyblockcast[bot]@users.noreply.github.com` literal, so it
 * measured SPELLING rather than identity. Confirmed against
 * `GET /repos/{owner}/{repo}/commits/{sha}` (`author.login`, `author.id`,
 * `author.type` all resolving to the App, id `290875700`), the same
 * installation also lands commits under a bare `allyblockcast[bot]@…` with no
 * numeric prefix, and once under a WRONG numeric prefix
 * (`220200645+allyblockcast[bot]@…`). The numeric prefix is caller-supplied at
 * commit time — whatever `git config user.email` or the REST payload said — not
 * a verified property of the write, so it varies by write path even though
 * every one of these is the same shared credential.
 * `APP_NOREPLY_EMAIL_PATTERN` therefore matches the `allyblockcast[bot]`
 * local-part on the `users.noreply.github.com` domain with an OPTIONAL numeric
 * prefix of ANY digits, an OPTIONAL `+tag` subaddress, and case-insensitively.
 *
 * Measured on `origin/master`, non-merge commits since 2026-07-01: 192 caught
 * by the old literal, 15 missed purely on spelling (13 bare, 1 wrong-prefix,
 * 1 no-`[bot]`), 2 of the missed landing AFTER this gate's own cutoff.
 *
 * ### `220200645+allyblockcast[bot]@…` is NOT a second installation — it is a
 * ### malformed stamp, and it IS matched
 *
 * The one commit carrying it (`d41030016`, merged 2026-08-10) has NO `author`
 * object at all in `GET /repos/{owner}/{repo}/commits/{sha}` — only `committer`
 * (a human, `kkroo`). GitHub could not resolve `220200645` to any account, App
 * or user. It reads as a hand-typed or copy-paste-mangled `--author` override
 * that got the prefix wrong, and it erases the true author exactly as badly
 * (worse — it does not even resolve), so the any-digits prefix catches it
 * deliberately. If a genuinely second App installation ever appears, name it
 * here explicitly rather than leaning on this catch-all.
 *
 * ### `allyblockcast@users.noreply.github.com` (no `[bot]`) is a DIFFERENT real
 * ### account — deliberately NOT matched
 *
 * Commits carrying that exact no-`[bot]` address resolve to
 * `author.login: "allyblockcast"`, `author.id: 296676656` — a distinct GitHub
 * account from the App (`allyblockcast[bot]`, id `290875700`). It has its own
 * version of the shared-identity problem BLO-21416 describes, but not the one
 * this gate is chartered to catch. Recorded rather than silently matched
 * (which would misattribute it to the wrong installation) or silently dropped
 * (which would hide a real second instance of the underlying problem).
 *
 * ## The bare spelling is shared with one non-agent process, so the carve-out
 * ## is name-scoped AND path-scoped — the author name alone is forgeable
 *
 * Widening the match to the bare form catches the `graphify-reindex` bot, a
 * scheduled knowledge-graph refresh (`origin/bot/graphify-reindex`) that pushes
 * under `graphify-reindex (allyblockcast)
 * <allyblockcast[bot]@users.noreply.github.com>`. It is not a per-agent write
 * path and there is no agent behind it to recover, so it is genuinely exempt.
 *
 * But BOTH halves of a git author are caller-controlled, so exempting on the
 * name alone would hand every agent a one-line bypass of this entire gate:
 * set `user.name` to the bot's name, keep the bare email, done. The exemption
 * in `NON_AGENT_PROCESS_EXEMPTIONS` therefore also pins the PATHS the process
 * is allowed to touch: every file in the commit must be under
 * `server/src/graphify-out/`, anchored at the repo root (measured: both
 * graphify-authored commits in this repo's history, `514aefa72` and
 * `206d6edaf`, touch only that directory). The anchor matters: a forger can
 * create a NEW `graphify-out/` directory anywhere, so an unanchored
 * `graphify-out/` match would let `server/src/services/graphify-out/x.ts`
 * through. A commit wearing the bot's name that changes anything else is still
 * an offense, which is what makes the forgery useless: it can only smuggle in
 * generated graph data, never work.
 *
 * The anchor also depends on `pathsForCommit` passing `core.quotePath=false`:
 * git's default quotes non-ASCII paths (`"server/src/graphify-out/\303\251.json"`),
 * and the leading `"` would false-reject a real graphify commit.
 *
 * The path set is fail-closed — a caller that supplies no `paths` gets no
 * exemption. So `--audit-merged` (which has no cheap path source) reports
 * graphify commits as advisory findings; that is deliberate, the audit is a
 * complete historical record and already declines to apply the allowlist for
 * the same reason.
 *
 * `pr.yml` deliberately does not exempt by BRANCH name instead: `head_ref` is
 * a fork bypass (it carries no repository identity, so any fork can name a
 * branch `bot/graphify-reindex`) and is empty on `merge_group`, which would
 * false-reject the whole queue.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const APP_NOREPLY_EMAIL = "290875700+allyblockcast[bot]@users.noreply.github.com";

/**
 * Every observed spelling of the shared App noreply address (BLO-26647): an
 * optional numeric prefix of ANY digits, the literal `allyblockcast[bot]`
 * local-part, an optional `+tag` subaddress, on the `users.noreply.github.com`
 * domain, case-insensitive. Each relaxation is load-bearing and argued in the
 * module docblock — in particular this deliberately does NOT match
 * `allyblockcast@users.noreply.github.com` (no `[bot]`), which is a different
 * real account (id 296676656), so the `[bot]` boundary is the one part that
 * must stay exact.
 */
export const APP_NOREPLY_EMAIL_PATTERN =
  /^(?:\d+\+)?allyblockcast\[bot\](?:\+[^@]*)?@users\.noreply\.github\.com$/i;

/**
 * Non-agent automated processes that share the App's bare noreply email and
 * so cannot be told apart from a genuine agent commit by email alone.
 *
 * Keyed by author name, but a name is caller-controlled and therefore NOT
 * sufficient on its own — each entry also pins the paths that process is
 * allowed to touch, and a commit touching anything outside them stays an
 * offense however it is named. See the module docblock. Add a new entry with
 * the real commit/branch that justifies it and the narrowest path scope that
 * covers its output; never widen `APP_NOREPLY_EMAIL_PATTERN` to exclude one.
 */
export const NON_AGENT_PROCESS_EXEMPTIONS = new Map([
  // origin/bot/graphify-reindex — scheduled knowledge-graph refresh.
  // Both graphify-authored commits in this repo's history (514aefa72,
  // 206d6edaf) touch only server/src/graphify-out/. Anchored at the repo
  // root: an unanchored `graphify-out/` is a directory the forger can create.
  ["graphify-reindex (allyblockcast)", /^server\/src\/graphify-out\//],
]);

/**
 * True when `commit` is one of the `NON_AGENT_PROCESS_EXEMPTIONS` processes
 * AND every path it touches is inside that process's pinned scope.
 *
 * Fail-closed on purpose: a commit with no `paths` (an unknown or absent file
 * list) is never exempt, so a caller that cannot supply paths — `--audit-merged`
 * — reports these rather than waving them through on the strength of a
 * forgeable name.
 */
export function isExemptNonAgentProcessCommit(commit) {
  const scope = NON_AGENT_PROCESS_EXEMPTIONS.get(commit.authorName ?? "");
  if (scope === undefined) return false;
  const paths = commit.paths;
  if (!Array.isArray(paths) || paths.length === 0) return false;
  return paths.every((filePath) => scope.test(filePath));
}

export const DEFAULT_AUDIT_REPOS = ["Blockcast/trafficcontrol", "Blockcast/paperclip"];

/** Default lookback for `--audit-merged`, in days. */
export const DEFAULT_AUDIT_SINCE_DAYS = 7;

/**
 * The audit selects PRs by MERGE TIME, not by a count.
 *
 * A count-based window cannot be honest here: `gh pr list --state merged`
 * orders by creation, so "the last N merged PRs" is unknowable from the first
 * N (or 5N) rows — a long-running PR created outside the bound can merge most
 * recently and be silently skipped. Filtering on `merged:>=<date>` asks the
 * search API the question we actually mean, and the answer is complete for
 * that window as long as it fits under this cap.
 *
 * If a repo returns exactly this many PRs, the window did not fit and the
 * audit reports INCOMPLETE rather than claiming coverage it cannot prove.
 * Narrow `--since` in that case.
 */
export const AUDIT_PR_LIST_MAX = 300;

/**
 * `GET /pulls/{number}/commits` is hard-capped at 250 entries; `--paginate`
 * cannot reach past it. Beyond the cap the list is silently short, so an
 * offense at commit 251+ would read as a pass. Detect and fail closed instead.
 */
export const COMMITS_API_MAX = 250;

/**
 * The moment this gate itself became knowable: when `e7162b906` /
 * `3fa6e41d8` landed on master (committer date of the latter — both were
 * merged in the same rebase-merge). Retained for provenance and as the
 * predicate used to build `GRANDFATHERED_OFFENSE_SHAS` below — it is no
 * longer read at enforcement time (see "Grandfathered pre-cutoff commits use
 * patch-id plus author" in the module docblock, BLO-23894).
 */
export const ATTRIBUTION_GATE_CUTOFF = "2026-08-09T01:38:20Z";
export const ATTRIBUTION_GATE_CUTOFF_MS = Date.parse(ATTRIBUTION_GATE_CUTOFF);

/**
 * Explicit, enumerated allowlist of pre-cutoff App-attributed non-merge
 * commits (BLO-23894). Built by scanning every commit on every OPEN
 * `Blockcast/paperclip` PR (168 as of 2026-08-11, via
 * `GET /pulls/{n}/commits` per PR) for the same predicate `policy` enforces
 * — App-authored, non-merge, `authorDate < ATTRIBUTION_GATE_CUTOFF` — a
 * superset of the ≥13-PR sample in BLO-23894's own blast-radius scan (which
 * covered only the 100 most-recently-created open PRs and so missed #927,
 * #1019, #1036, and #1049, all outside that window). Two commits found in
 * the same scan were deliberately EXCLUDED because their `authorDate` is
 * *after* the cutoff (PR #1125 `aafae6d5b`, PR #1220 `d656a840b`/`28bee6a6c`)
 * — those are live, real violations the gate is correctly enforcing on, not
 * grandfather candidates; their authors need to fix them via `git push` from
 * a correctly-configured checkout per AGENTS.md §9.
 *
 * This list only ever needs new entries for commits that predate the cutoff
 * above (a closed, non-growing condition) or for a grandfathered commit
 * whose SHA changed because it was rebased (see
 * the docblock trade-off) — never for an ordinary new PR.
 *
 * It SHRINKS, though, and should: an entry whose patch is on no ref any more
 * is a standing exemption nobody needs on a security control. Two came out in
 * BLO-26647 — `b22bed3ac5…` (keyed #1126's `cb120b0e3`) and `437abe8653…`
 * (keyed #1161's `b54c3bc26`). Both PRs landed by RE-ATTRIBUTION instead, so
 * the patches they keyed exist nowhere. Before removing one, verify no open PR
 * still carries it: compute `git patch-id --stable` for every App-attributed
 * non-merge commit across all open PRs and check membership. Done 2026-09-29
 * over all 142 open PRs and all 13 such commits — neither key appeared.
 */
export const GRANDFATHERED_OFFENSE_SHAS = new Set([
  "63b58b5df729db30d26325d3cb3349d6d07750ef",
  "87724aca1ceecc93d9a430029dd92362171650f0",
  "73661f1e600a5f4b71e993cb2933cea97564009e",
  "03734ab59c8e39175e3b48894516410bc358253b",
  "47dabdd37f43a48532e94e79d7e9ba2d174e59f2",
  "df1cfbe845b065af254d850764c16cc9b4609815",
  "ac25b54d4cba6a44781c7dcacb3a4b7d083180cc",
  "3ea4c9dd6345d45b507de15ec005ed3927f314f4",
  "970a912cae282b129222fa524497f520a4c2fa0e",
  "11d7a79790aa8fc658cb164ce2f2b372e98bce07",
  "5d1fb094eb82d0f83fcd1f7d47a615936b68f273",
  "e6e8c25ae37b161b062ae67c95970c958f89198a",
  "8b7e81fde79203be6342c70c010928f154b1e2a0",
].map((patchId) => `${patchId}|${APP_NOREPLY_EMAIL}`));

/**
 * The same clause, for pre-cutoff commits carrying the BARE spelling of the
 * App address. Before BLO-26647 widened `APP_NOREPLY_EMAIL_PATTERN` these
 * were not offenses at all — they passed on a matcher bug, not on merit — so
 * registering them is the same retro-break protection BLO-23894 exists to
 * provide, applied to the cohort that tightening the matcher newly exposes.
 *
 * Enumerated by scanning the commits of all 142 open `Blockcast/paperclip`
 * PRs on 2026-09-29 for the widened predicate, and keeping only those with
 * `authorDate < ATTRIBUTION_GATE_CUTOFF`. It is closed for the same reason
 * the list above is: the cutoff is in the past.
 *
 * ONE commit in that scan was deliberately left OFF — `7d8070c83` on #1278
 * (`0f54e7c58624243b66149833ec3d5f7cd9947879`, authored 2026-08-18T16:58:55Z,
 * nine days AFTER the cutoff). It is a live violation the gate is correctly
 * enforcing on, not a grandfather candidate; its author re-attributes it per
 * AGENTS.md §9.
 */
const BARE_APP_NOREPLY_EMAIL = "allyblockcast[bot]@users.noreply.github.com";
for (const patchId of [
  "3203ee89e7bbeef3cc7d34bc3fa0a84e26788387", // #1076 6e7440da2, 2026-08-07T04:47:38Z (BLO-26647)
  "102821942f40ec00b8ad6caef30fdcf06d3d10a2", // #1140 cace65cf3, 2026-08-07T15:42:01Z
  "6f68b4dc6658bff45a895cf4b917e64af4f76e9e", // #1183 47d44df5c, 2026-08-09T00:36:48Z
  "4e5c4ab103c22ab8aa27ab6563219bb80061e00b", // #891  538563689, 2026-07-31T22:21:19Z
  "c9ceb199c4c43b8ed690e53f16c699fb5fd8a343", // #891  8a7b9fe12, 2026-08-01T15:42:44Z
  "6300049f135f0bda6f93cf2966563efe708328ed", // #929  2a97e098c, 2026-08-02T04:54:09Z
]) {
  GRANDFATHERED_OFFENSE_SHAS.add(`${patchId}|${BARE_APP_NOREPLY_EMAIL}`);
}

const UNIT_SEPARATOR = "\u001f";
const RECORD_SEPARATOR = "\u001e";

/**
 * Shared assertion: given normalized non-merge-or-merge-tagged commit
 * records, return the ones stamped with the shared App identity.
 * `commits` entries: { sha, authorEmail, authorName, authorDate, parentCount,
 * message, paths?, patchId?, context? }. A `parentCount` of 2+ is a merge
 * commit and is always out of scope, independent of which mode produced the
 * record (defensive — mode 1 already excludes these via `--no-merges`).
 *
 * `authorEmail` is matched against `APP_NOREPLY_EMAIL_PATTERN`, not one
 * literal — the App stamps several spellings of the same address (BLO-26647).
 *
 * `authorName` plus `paths` clear the one non-agent process that shares the
 * bare spelling (`isExemptNonAgentProcessCommit`); the name alone never does,
 * because a name is caller-controlled.
 *
 * `allowlist`, if given (a `Set` of `${patchId}|${authorEmail}` keys), clears
 * only an enumerated patch and author pair — BLO-23894's grandfather clause.
 * A missing patch-id cannot match and stays an offense. Omitting `allowlist` preserves the
 * historical, unfiltered assertion; `--audit-merged` relies on that default
 * so it keeps reporting pre-cutoff violations as advisory record.
 */
export function findAttributionOffenses(commits, { allowlist } = {}) {
  return commits.filter((commit) => {
    if ((commit.parentCount ?? 1) > 1) return false;
    const authorEmail = String(commit.authorEmail ?? "");
    if (!APP_NOREPLY_EMAIL_PATTERN.test(authorEmail)) return false;
    if (isExemptNonAgentProcessCommit(commit)) return false;
    if (allowlist === undefined) return true;
    const key = `${String(commit.patchId ?? "").toLowerCase()}|${authorEmail.toLowerCase()}`;
    return !allowlist.has(key);
  });
}

/**
 * Every email in a `Co-authored-by: Name <email>` trailer, lowercased.
 *
 * Used only to REPORT whether a re-stamped merge commit still carries the
 * authors it displaced — never to clear a finding. A trailer is part of the
 * commit message and so is author-controlled; it is evidence about
 * recoverability, not an attestation.
 */
export function parseCoAuthorEmails(message) {
  const out = new Set();
  for (const line of String(message ?? "").split("\n")) {
    const match = /^\s*co-authored-by:\s*.*<([^>]+)>\s*$/i.exec(line);
    if (match) out.add(match[1].trim().toLowerCase());
  }
  return out;
}

/**
 * The merge-time re-attribution check (BLO-39345). Returns an offense object
 * when `mergeCommit` — the commit GitHub creates AT merge, which no
 * `pull_request` workflow can ever see — carries the shared App identity
 * while the PR's own commits did not, i.e. authorship was lost at merge.
 *
 * `mergeCommit`: { sha, authorEmail, authorName, parentCount, message }.
 * `prCommits`: the same normalized records mode 2 already builds.
 *
 * Deliberately method-agnostic — see the module docblock. Three guards:
 *
 *   - `parentCount > 1` is a true merge commit: no authored content, out of
 *     scope, same boundary as `findAttributionOffenses`.
 *   - If EVERY PR commit was already App-attributed there is nothing to lose
 *     at merge; the head-side check owns that case and reporting it here
 *     would double-count the same violation. This is also what keeps the
 *     graphify-reindex process (App-stamped on both sides) from being
 *     reported twice.
 *   - An EMPTY `prCommits` fails CLOSED: with no head-side authorship to
 *     compare against, an App-stamped content commit is exactly the shape
 *     this check polices and "I could not look" is not "clean".
 */
export function findMergeAttributionOffense({ mergeCommit, prCommits = [] } = {}) {
  if (!mergeCommit) return null;
  if ((mergeCommit.parentCount ?? 1) > 1) return null;
  const authorEmail = String(mergeCommit.authorEmail ?? "");
  if (!APP_NOREPLY_EMAIL_PATTERN.test(authorEmail)) return null;

  const headEmails = [...new Set(prCommits.map((c) => String(c.authorEmail ?? "")).filter(Boolean))];
  if (headEmails.length > 0 && headEmails.every((e) => APP_NOREPLY_EMAIL_PATTERN.test(e))) return null;

  const trailerEmails = parseCoAuthorEmails(mergeCommit.message);
  const displaced = headEmails.filter((e) => !APP_NOREPLY_EMAIL_PATTERN.test(e));
  return {
    sha: mergeCommit.sha,
    authorEmail,
    authorName: mergeCommit.authorName ?? null,
    message: String(mergeCommit.message ?? "").split("\n")[0],
    displacedAuthors: displaced,
    // Reported, never exculpatory: see parseCoAuthorEmails.
    recoverableFromTrailers:
      displaced.length > 0 && displaced.every((e) => trailerEmails.has(e.toLowerCase())),
  };
}

/**
 * Flatten `gh api --paginate` output: each page is a complete top-level JSON
 * array and the pages are concatenated back-to-back, not merged.
 *
 * Scans for the page boundary with a depth counter that is aware of strings
 * and backslash escapes, rather than splitting on a `]`-then-`[` regex. The
 * regex form was wrong and had been live since the audit mode was written:
 * ANY commit message containing `] [` — `"fix: handle arr[0] [BLO-123]"` is
 * the shape, and this repo has them — splits a page in the middle of a string
 * and the audit dies with `Unterminated string in JSON`.
 *
 * It had never been caught because nothing ran `--audit-merged` on a
 * schedule; found 2026-10-02 (BLO-39345) the first time it was run over a
 * window wide enough to contain one. It fails loudly rather than silently,
 * but a guard that crashes on ordinary input is a guard nobody keeps.
 *
 * `gh --slurp` would do this server-side and is NOT available here (gh 2.46.0
 * rejects the flag), so the scan stays.
 */
export function parseConcatenatedJsonArrays(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  const out = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") {
      if (depth === 0 && ch === "[") start = i;
      depth += 1;
    } else if (ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        out.push(...JSON.parse(text.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  if (depth !== 0) throw new Error("truncated JSON in paginated gh output");
  return out;
}

function parseLocalGitLog(rawOutput) {
  return rawOutput
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, authorEmail, authorName, authorDate, subject] = record.split(UNIT_SEPARATOR);
      return { sha, authorEmail, authorName, authorDate, parentCount: 1, message: subject ?? "" };
    });
}

function patchIdForCommit(repoRoot, sha, execFile = execFileSync) {
  const patch = execFile("git", ["show", "--format=", "--no-ext-diff", "--no-renames", sha], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return execFile("git", ["patch-id", "--stable"], {
    cwd: repoRoot,
    input: patch,
    encoding: "utf8",
  }).trim().split(/\s+/)[0] ?? "";
}

function pathsForCommit(repoRoot, sha, execFile = execFileSync) {
  // core.quotePath=false: the exemption scope is `^`-anchored, and git's
  // default quoting of non-ASCII paths would prefix them with `"`.
  const raw = execFile("git", ["-c", "core.quotePath=false", "show", "--format=", "--name-only", "--no-renames", sha], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return raw.split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * Local mode: non-merge commits in `base..head` of a checked-out repo.
 * `execFileSync` (argv array, no shell) — `base`/`head` are refs/SHAs from
 * trusted CI-provided env, but this avoids any shell-injection surface either way.
 * Applies the BLO-23894 grandfather allowlist by default — this is the gate
 * that actually blocks a PR, so pre-cutoff, allowlisted commits are out of
 * scope.
 *
 * The per-commit `git show` calls that produce `patchId` and `paths` run ONLY
 * for commits whose author email already matches the App pattern: they exist
 * to decide grandfathering and the non-agent-process exemption, and neither
 * question arises otherwise. On an ordinary PR that is zero extra git
 * invocations rather than two per commit.
 */
export function findLocalRangeOffenses({
  repoRoot,
  base,
  head,
  execFile = execFileSync,
  allowlist = GRANDFATHERED_OFFENSE_SHAS,
} = {}) {
  const format = `%H${UNIT_SEPARATOR}%ae${UNIT_SEPARATOR}%an${UNIT_SEPARATOR}%aI${UNIT_SEPARATOR}%s${RECORD_SEPARATOR}`;
  const rawOutput = execFile(
    "git",
    ["log", "--no-merges", `--format=${format}`, `${base}..${head}`],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const commits = parseLocalGitLog(rawOutput).map((commit) =>
    APP_NOREPLY_EMAIL_PATTERN.test(String(commit.authorEmail ?? ""))
      ? {
          ...commit,
          patchId: patchIdForCommit(repoRoot, commit.sha, execFile),
          paths: pathsForCommit(repoRoot, commit.sha, execFile),
        }
      : commit,
  );
  return findAttributionOffenses(commits, { allowlist });
}

/**
 * Normalize `--since` to the `YYYY-MM-DD` form the search qualifier takes.
 * Accepts `<N>d` (relative) or an explicit `YYYY-MM-DD`.
 */
export function resolveSince(value, nowMs = Date.now()) {
  const raw = String(value ?? `${DEFAULT_AUDIT_SINCE_DAYS}d`).trim();
  const relative = /^(\d+)d$/.exec(raw);
  if (relative) {
    return new Date(nowMs - Number(relative[1]) * 86_400_000).toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`--since expects YYYY-MM-DD or <N>d, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * Newest merge first. Entries without a parseable `mergedAt` are dropped
 * rather than sorted to an arbitrary position — `gh` only omits it for PRs
 * that are not actually merged.
 */
export function sortByMergedAtDesc(prs) {
  return prs
    .map((pr) => ({ pr, mergedMs: Date.parse(pr.mergedAt ?? "") }))
    .filter((entry) => Number.isFinite(entry.mergedMs))
    .sort((a, b) => b.mergedMs - a.mergedMs)
    .map((entry) => entry.pr);
}

/**
 * Remote audit mode: every PR in `repo` merged on or after `since`, each PR's
 * own (pre-squash) commit list. `ghApi` is injected so tests never shell out.
 *
 * Two incompleteness signals travel with the result, both distinct from
 * "audited and clean":
 *   - `windowTruncated` — the merge-time window exceeded AUDIT_PR_LIST_MAX, so
 *     some merged PRs in it were never examined.
 *   - `truncated` — a PR's commit list hit COMMITS_API_MAX, so that PR was
 *     only partially examined.
 */
export async function auditRepoCommitAttribution({ repo, since, ghApi }) {
  const prsJson = await ghApi([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "merged",
    "--search",
    `merged:>=${since}`,
    "--limit",
    String(AUDIT_PR_LIST_MAX),
    "--json",
    "number,title,mergedAt,mergeCommit",
  ]);
  const rawPrs = JSON.parse(prsJson);
  const windowTruncated = rawPrs.length >= AUDIT_PR_LIST_MAX;
  const prs = sortByMergedAtDesc(rawPrs);

  const offenses = [];
  const mergeOffenses = [];
  const truncated = [];
  let totalCommits = 0;
  for (const pr of prs) {
    const commitsJson = await ghApi([
      "api",
      `repos/${repo}/pulls/${pr.number}/commits`,
      "--paginate",
    ]);
    const commits = parseConcatenatedJsonArrays(commitsJson);
    totalCommits += commits.length;
    if (commits.length >= COMMITS_API_MAX) {
      truncated.push({ repo, prNumber: pr.number, prTitle: pr.title, commitsSeen: commits.length });
    }
    const normalized = commits.map((commit) => ({
      sha: commit.sha,
      authorEmail: commit.commit?.author?.email ?? null,
      // Carried so the audit REPORT names the author, not so it exempts:
      // `paths` is deliberately absent here, and
      // `isExemptNonAgentProcessCommit` fails closed without it — see the
      // module docblock. The audit is a complete advisory record and already
      // declines to apply the grandfather allowlist for the same reason.
      authorName: commit.commit?.author?.name ?? null,
      authorDate: commit.commit?.author?.date ?? null,
      parentCount: commit.parents?.length ?? 1,
      message: (commit.commit?.message ?? "").split("\n")[0],
    }));
    for (const offense of findAttributionOffenses(normalized)) {
      offenses.push({ ...offense, repo, prNumber: pr.number, prTitle: pr.title });
    }

    // BLO-39345: the commit GitHub creates AT merge. Fetched separately
    // because /pulls/{n}/commits cannot return it — it does not exist until
    // the merge, which is also why no pull_request workflow sees it.
    const mergeOid = pr.mergeCommit?.oid;
    if (mergeOid) {
      const mergeJson = await ghApi(["api", `repos/${repo}/commits/${mergeOid}`]);
      const mc = JSON.parse(mergeJson);
      const offense = findMergeAttributionOffense({
        mergeCommit: {
          sha: mc.sha,
          authorEmail: mc.commit?.author?.email ?? null,
          authorName: mc.commit?.author?.name ?? null,
          parentCount: mc.parents?.length ?? 1,
          message: mc.commit?.message ?? "",
        },
        prCommits: normalized,
      });
      if (offense) mergeOffenses.push({ ...offense, repo, prNumber: pr.number, prTitle: pr.title });
    }
  }

  return {
    repo,
    since,
    prsChecked: prs.length,
    commitsChecked: totalCommits,
    offenses,
    mergeOffenses,
    truncated,
    windowTruncated,
    oldestMergedAt: prs.at(-1)?.mergedAt ?? null,
    newestMergedAt: prs[0]?.mergedAt ?? null,
  };
}

async function defaultGhApi(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export async function runAudit({
  repos = DEFAULT_AUDIT_REPOS,
  since,
  ghApi = defaultGhApi,
  log = console.log,
  // Which findings decide the EXIT CODE. Everything is always reported; this
  // only chooses what fails the process.
  //
  //   "all"   (default) — head-side offenses too. The historical contract, and
  //                       the right one for a human running the audit by hand:
  //                       a complete advisory record.
  //   "merge"           — merge-produced commits only. What the scheduled
  //                       workflow uses, and NOT a weakening:
  //
  // Mode 2 cannot evaluate the grandfather allowlist. That allowlist is keyed
  // on patch-id (BLO-27142), patch-ids require a local checkout, and mode 2
  // has none — so an enumerated, deliberately-unfixable pre-cutoff commit is
  // reported as an offense on every single run. Gating on that would ship a
  // guard that is red on day one and stays red forever, which is the
  // ally-review-consistency failure mode (0 successes in 100 runs) that
  // check-scheduled-guard-liveness.mjs exists to reason about: a permanently
  // red check is an ignored check.
  //
  // Head-side commits are already gated at PR time by mode 1, which DOES have
  // the checkout and DOES apply the allowlist correctly. Re-gating them here
  // adds no coverage and costs the signal. The merge-produced commit is the
  // one thing no other gate can see, so it is the one thing this gates on.
  gate = "all",
} = {}) {
  const window = resolveSince(since);
  const results = [];
  for (const repo of repos) {
    const result = await auditRepoCommitAttribution({ repo, since: window, ghApi });
    results.push(result);
    const covered = result.oldestMergedAt
      ? `${result.oldestMergedAt} .. ${result.newestMergedAt}`
      : "no merged PRs in window";
    log(
      `${repo}: checked ${result.commitsChecked} non-merge commits across ${result.prsChecked} PRs merged since ${window} (${covered}) — ${result.offenses.length} App-attributed`,
    );
    for (const offense of result.offenses) {
      log(
        `  VIOLATION ${repo}#${offense.prNumber} ${offense.sha.slice(0, 7)} "${offense.message}" — ${offense.authorEmail}`,
      );
    }
    for (const offense of result.mergeOffenses) {
      const recoverable = offense.recoverableFromTrailers
        ? "authors still in Co-authored-by trailers"
        : "NOT recoverable from trailers";
      log(
        `  MERGE-REATTRIBUTION ${repo}#${offense.prNumber} ${offense.sha.slice(0, 7)} "${offense.message}" — merge-time author ${offense.authorEmail} displaced ${offense.displacedAuthors.join(", ") || "(no head authors seen)"} (${recoverable})`,
      );
    }
    if (result.windowTruncated) {
      log(
        `  INCOMPLETE ${repo} — the window since ${window} contains at least ${AUDIT_PR_LIST_MAX} merged PRs, which is the fetch cap; merged PRs beyond it were NOT audited. Narrow --since.`,
      );
    }
    for (const partial of result.truncated) {
      log(
        `  INCOMPLETE ${repo}#${partial.prNumber} "${partial.prTitle}" — commit list hit the ${COMMITS_API_MAX}-entry API cap; commits past it were NOT audited`,
      );
    }
  }
  const allOffenses = results.flatMap((r) => r.offenses);
  const allMergeOffenses = results.flatMap((r) => r.mergeOffenses);
  const allTruncated = results.flatMap((r) => r.truncated);
  const windowTruncated = results.filter((r) => r.windowTruncated);
  // Truncation always gates, under either mode: an audit that could not
  // complete has not shown the merge side is clean either.
  const complete = allTruncated.length === 0 && windowTruncated.length === 0;
  return {
    passed:
      complete &&
      allMergeOffenses.length === 0 &&
      (gate === "merge" || allOffenses.length === 0),
    gate,
    since: window,
    results,
    offenses: allOffenses,
    mergeOffenses: allMergeOffenses,
    truncated: allTruncated,
    windowTruncated,
  };
}

function parseArgs(argv) {
  const args = { mode: "local" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--audit-merged") args.mode = "audit";
    else if (arg === "--gate") args.gate = argv[++i];
    else if (arg === "--repos") args.repos = argv[++i]?.split(",").map((r) => r.trim()).filter(Boolean);
    else if (arg === "--since") args.since = argv[++i];
    else if (arg === "--base") args.base = argv[++i];
    else if (arg === "--head") args.head = argv[++i];
  }
  return args;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === "audit") {
    if (args.gate !== undefined && args.gate !== "all" && args.gate !== "merge") {
      console.error(`ERROR: --gate must be "all" or "merge", got ${JSON.stringify(args.gate)}.`);
      process.exit(2);
    }
    const gate = args.gate ?? "all";
    const { passed, offenses, mergeOffenses, truncated, windowTruncated, since } = await runAudit({
      repos: args.repos,
      since: args.since,
      gate,
    });
    // Name which failure mode fired: an offense is a real violation, a
    // truncated result is an audit that could not complete. Reporting the
    // latter as the former would send someone hunting a commit the audit
    // never actually saw.
    if (offenses.length > 0) {
      console.error(
        `\n${offenses.length} non-merge commit(s) carry the shared App identity (${APP_NOREPLY_EMAIL}) instead of a per-agent author. See BLO-21416 / AGENTS.md §9.`,
      );
      if (gate === "merge") {
        console.error(
          "  (advisory under --gate merge: these do not fail this run. They are gated at PR time by the local-range mode, which has the checkout needed to apply the patch-id grandfather allowlist that this mode cannot evaluate.)",
        );
      }
    }
    if (mergeOffenses.length > 0) {
      console.error(
        `\n${mergeOffenses.length} merge-produced commit(s) were re-stamped with the shared App identity (${APP_NOREPLY_EMAIL}) at merge time, displacing the per-agent authors of the PR's own commits (BLO-39345).\n\nThis is a squash-merge of a PR whose commits have two or more distinct authors: GitHub attributes the squash commit to the PR author, which for an agent PR is the shared App. The commit is created AFTER the last pull_request run, so the per-PR gate cannot see it and nothing re-evaluates it.\n\nIt CANNOT be fixed in place — rewriting the base branch would relabel every other correctly-attributed commit on it. Prevent it instead: merge through the queue (merge_method REBASE, which preserves per-commit authorship — 0 of 82 multi-author rebases re-stamped in the 2026-10-02 measurement), or have a repo admin disable squash-merge. Where the trailers still carry the displaced authors the attribution is recoverable from the commit message; where they do not, it is lost.`,
      );
    }
    if (windowTruncated.length > 0) {
      console.error(
        `\n${windowTruncated.length} repo(s) had more than ${AUDIT_PR_LIST_MAX} PRs merged since ${since}, so the window could not be audited in full. Re-run with a narrower --since. This is an incomplete audit, not a clean one.`,
      );
    }
    if (truncated.length > 0) {
      console.error(
        `\n${truncated.length} PR(s) could not be fully audited: their commit list hit the ${COMMITS_API_MAX}-entry cap on GET /pulls/{number}/commits, so a violation past that point would be invisible. This is an incomplete audit, not a clean one.`,
      );
    }
    process.exit(passed ? 0 : 1);
  }

  const base = args.base ?? process.env.PR_BASE_SHA;
  const head = args.head ?? process.env.PR_HEAD_SHA ?? "HEAD";
  if (!base) {
    console.error("ERROR: --base (or PR_BASE_SHA) is required in local mode.");
    process.exit(2);
  }
  const offenses = findLocalRangeOffenses({ repoRoot: process.cwd(), base, head });
  if (offenses.length > 0) {
    console.error(
      `ERROR: ${offenses.length} commit(s) in ${base}..${head} carry the shared allyblockcast[bot] App identity instead of a per-agent author:\n`,
    );
    for (const offense of offenses) {
      const author = offense.authorName ? `${offense.authorName} <${offense.authorEmail}>` : offense.authorEmail;
      console.error(`  ${offense.sha.slice(0, 7)} "${offense.message}" — ${author}`);
    }
    console.error(
      "\nThis almost certainly means the commit was created via the GitHub REST/MCP write path (contents API, merge API, or `create_or_update_file`/`push_files`, which always stamps the shared App credential). Fix: recreate it with `git push`, which carries your per-agent identity from the run environment.\n\nDo NOT try to fix this by setting `git config user.email`/`user.name` in the checkout. Since BLO-29050 every adapter process runs with a `GIT_AUTHOR_*`/`GIT_COMMITTER_*` overlay that outranks the local, global and system config files, so a config write changes nothing about what gets committed — and `git config user.email` correspondingly tells you nothing about what the gate saw. Diagnose from the commit instead: `git log -1 --pretty='%an <%ae>'`. (Earlier revisions of this message named a misconfigured local config as the second cause; that was true of the 2026-08-10 sweep and is not a live failure mode now.) See AGENTS.md §9 (BLO-21416).\n\nIf this commit predates the gate (authored before ATTRIBUTION_GATE_CUTOFF, e.g. it was already open and reviewed before the rule existed, or it's a grandfathered PR that got rebased or edited and changed patch-id), LOOK THE AUTHOR UP BEFORE CALLING IT UNFIXABLE. Query the Paperclip run record for the run whose comments describe this commit's work within minutes of its author date — runs routinely name the SHA they just created. If the author is recoverable, re-attribute it (`git commit --amend --author=…`, preserving the author date, proving the content is unchanged with `git patch-id --stable` on both sides). That is how #1126 and #1161 landed, it shrinks the allowlist instead of growing it, and it touches no security control. Only when the author is genuinely lost is this a grandfather case — then file against BLO-23894's owner to register its PATCH-ID (not its SHA; the allowlist has been patch-id-keyed since BLO-27142) rather than rewriting history.",
    );
    process.exit(1);
  }
  console.log("  ✓  No commits in range carry the shared allyblockcast[bot] App identity.");
  process.exit(0);
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}
