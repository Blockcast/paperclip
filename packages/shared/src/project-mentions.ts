export const PROJECT_MENTION_SCHEME = "project://";
export const AGENT_MENTION_SCHEME = "agent://";
export const USER_MENTION_SCHEME = "user://";
export const SKILL_MENTION_SCHEME = "skill://";
export const ROUTINE_MENTION_SCHEME = "routine://";
export const PIPELINE_MENTION_SCHEME = "pipeline://";

const HEX_COLOR_RE = /^[0-9a-f]{6}$/i;
const HEX_COLOR_SHORT_RE = /^[0-9a-f]{3}$/i;
const HEX_COLOR_WITH_HASH_RE = /^#[0-9a-f]{6}$/i;
const HEX_COLOR_SHORT_WITH_HASH_RE = /^#[0-9a-f]{3}$/i;
const PROJECT_MENTION_LINK_RE = /\[[^\]]*]\((project:\/\/[^)\s]+)\)/gi;
const AGENT_MENTION_LINK_RE = /\[[^\]]*]\((agent:\/\/[^)\s]+)\)/gi;
const USER_MENTION_LINK_RE = /\[[^\]]*]\((user:\/\/[^)\s]+)\)/gi;
const SKILL_MENTION_LINK_RE = /\[[^\]]*]\((skill:\/\/[^)\s]+)\)/gi;
const ROUTINE_MENTION_LINK_RE = /\[[^\]]*]\((routine:\/\/[^)\s]+)\)/gi;
const PIPELINE_MENTION_LINK_RE = /\[[^\]]*]\((pipeline:\/\/[^)\s]+)\)/gi;
const AGENT_ICON_NAME_RE = /^[a-z0-9-]+$/i;
const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;

export interface ParsedProjectMention {
  projectId: string;
  color: string | null;
}

export interface ParsedAgentMention {
  agentId: string;
  icon: string | null;
}

export interface ParsedUserMention {
  userId: string;
}

export interface ParsedSkillMention {
  skillId: string;
  slug: string | null;
}

export interface ParsedRoutineMention {
  routineId: string;
}

export interface ParsedPipelineMention {
  pipelineId: string;
  stageKey: string | null;
}

function normalizeHexColor(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (HEX_COLOR_WITH_HASH_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (HEX_COLOR_RE.test(trimmed)) {
    return `#${trimmed.toLowerCase()}`;
  }
  if (HEX_COLOR_SHORT_WITH_HASH_RE.test(trimmed)) {
    const raw = trimmed.slice(1).toLowerCase();
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`;
  }
  if (HEX_COLOR_SHORT_RE.test(trimmed)) {
    const raw = trimmed.toLowerCase();
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`;
  }
  return null;
}

export function buildProjectMentionHref(projectId: string, color?: string | null): string {
  const trimmedProjectId = projectId.trim();
  const normalizedColor = normalizeHexColor(color ?? null);
  if (!normalizedColor) {
    return `${PROJECT_MENTION_SCHEME}${trimmedProjectId}`;
  }
  return `${PROJECT_MENTION_SCHEME}${trimmedProjectId}?c=${encodeURIComponent(normalizedColor.slice(1))}`;
}

export function parseProjectMentionHref(href: string): ParsedProjectMention | null {
  if (!href.startsWith(PROJECT_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "project:") return null;

  const projectId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!projectId) return null;

  const color = normalizeHexColor(url.searchParams.get("c") ?? url.searchParams.get("color"));

  return {
    projectId,
    color,
  };
}

export function buildAgentMentionHref(agentId: string, icon?: string | null): string {
  const trimmedAgentId = agentId.trim();
  const normalizedIcon = normalizeAgentIcon(icon ?? null);
  if (!normalizedIcon) {
    return `${AGENT_MENTION_SCHEME}${trimmedAgentId}`;
  }
  return `${AGENT_MENTION_SCHEME}${trimmedAgentId}?i=${encodeURIComponent(normalizedIcon)}`;
}

export function parseAgentMentionHref(href: string): ParsedAgentMention | null {
  if (!href.startsWith(AGENT_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "agent:") return null;

  const agentId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!agentId) return null;

  return {
    agentId,
    icon: normalizeAgentIcon(url.searchParams.get("i") ?? url.searchParams.get("icon")),
  };
}

export function buildUserMentionHref(userId: string): string {
  return `${USER_MENTION_SCHEME}${userId.trim()}`;
}

export function parseUserMentionHref(href: string): ParsedUserMention | null {
  if (!href.startsWith(USER_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "user:") return null;

  const userId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!userId) return null;

  return { userId };
}

export function buildSkillMentionHref(skillId: string, slug?: string | null): string {
  const trimmedSkillId = skillId.trim();
  const normalizedSlug = normalizeSkillSlug(slug ?? null);
  if (!normalizedSlug) {
    return `${SKILL_MENTION_SCHEME}${trimmedSkillId}`;
  }
  return `${SKILL_MENTION_SCHEME}${trimmedSkillId}?s=${encodeURIComponent(normalizedSlug)}`;
}

export function parseSkillMentionHref(href: string): ParsedSkillMention | null {
  if (!href.startsWith(SKILL_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "skill:") return null;

  const skillId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!skillId) return null;

  return {
    skillId,
    slug: normalizeSkillSlug(url.searchParams.get("s") ?? url.searchParams.get("slug")),
  };
}

export function buildRoutineMentionHref(routineId: string): string {
  return `${ROUTINE_MENTION_SCHEME}${routineId.trim()}`;
}

export function parseRoutineMentionHref(href: string): ParsedRoutineMention | null {
  if (!href.startsWith(ROUTINE_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "routine:") return null;

  const routineId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!routineId) return null;

  return { routineId };
}

export function buildPipelineMentionHref(pipelineId: string, stageKey?: string | null): string {
  const trimmedPipelineId = pipelineId.trim();
  const normalizedStageKey = stageKey?.trim();
  if (!normalizedStageKey) return `${PIPELINE_MENTION_SCHEME}${trimmedPipelineId}`;
  return `${PIPELINE_MENTION_SCHEME}${trimmedPipelineId}?stage=${encodeURIComponent(normalizedStageKey)}`;
}

export function parsePipelineMentionHref(href: string): ParsedPipelineMention | null {
  if (!href.startsWith(PIPELINE_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "pipeline:") return null;

  const pipelineId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!pipelineId) return null;

  const stageKey = url.searchParams.get("stage")?.trim() || null;
  return { pipelineId, stageKey };
}

export function extractProjectMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(PROJECT_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parseProjectMentionHref(match[1]);
    if (parsed) ids.add(parsed.projectId);
  }
  return [...ids];
}

export function extractAgentMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(AGENT_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parseAgentMentionHref(match[1]);
    if (parsed) ids.add(parsed.agentId);
  }
  return [...ids];
}

export function extractUserMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(USER_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parseUserMentionHref(match[1]);
    if (parsed) ids.add(parsed.userId);
  }
  return [...ids];
}

export function extractSkillMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(SKILL_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parseSkillMentionHref(match[1]);
    if (parsed) ids.add(parsed.skillId);
  }
  return [...ids];
}

export function extractRoutineMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(ROUTINE_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parseRoutineMentionHref(match[1]);
    if (parsed) ids.add(parsed.routineId);
  }
  return [...ids];
}

export function extractPipelineMentions(markdown: string): ParsedPipelineMention[] {
  if (!markdown) return [];
  const seen = new Set<string>();
  const mentions: ParsedPipelineMention[] = [];
  const re = new RegExp(PIPELINE_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parsePipelineMentionHref(match[1]);
    if (!parsed) continue;
    const key = `${parsed.pipelineId}:${parsed.stageKey ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mentions.push(parsed);
  }
  return mentions;
}

function normalizeAgentIcon(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed || !AGENT_ICON_NAME_RE.test(trimmed)) return null;
  return trimmed;
}

function normalizeSkillSlug(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed || !SKILL_SLUG_RE.test(trimmed)) return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// PEN-5180: unbound `@`-mention reporting.
//
// `extractAgentMentionIds` above requires a markdown link whose href is
// `agent://<id>`. A plain `@Ceo` — the form a human writes — matches nothing,
// binds to nobody, and raises no wake. The comment write still returns 200 and
// renders normally, so the author's only evidence of failure is the absence of
// a reply, which is indistinguishable from a busy recipient. Measured on
// PEN-2918: a plain `@Ceo` drew zero CEO actions in 24h while the same ask as
// `[@Ceo](agent://<uuid>)` was answered in ~5 minutes.
//
// The remedy is NOT to make the extractor match plain names — an unambiguous
// href is a defensible contract, and name matching buys false wakes (similar
// names, a name inside prose, a quoted prior comment). The remedy is to tell
// the author the mention bound to nothing, so a silent drop becomes a readable
// one. Same shape as the `unrecognizedPayloadKeys` precedent on interaction
// creates, which exists for exactly this class of silent drop.
//
// Fail toward reporting: a false "this may not have reached anyone" costs a
// re-send, a false silence costs a day. Where this scanner is unsure it
// reports.
//
// PEN-5187 refines that in one place and declines to refine it in another.
//
// REFINED: a token directly followed by `/<scope-char>` is skipped. `@types/node`
// and `@paperclipai/shared` in prose used to report `["types"]` / `["paperclipai"]`,
// and engineering comments here name scoped packages and GitHub org paths
// constantly, so that was a systematic false entry rather than an occasional
// one. A field that is usually wrong is a field people learn to skip, which
// returns us to the silent drop above while looking like it works. The rule is
// safe because an agent name is never followed by a slash, and it is narrowed
// to `/<scope-char>` so the mention-pair form `@Ceo/@Cto` keeps reporting.
//
// The class is narrowed again to `[a-z0-9]`, because npm scope segments and
// GitHub team slugs are lowercase while agent names here are capitalized. That
// recovers `@Ceo/Cto` and `@Ceo/PlatformSRE`, which the wider class swallowed.
//
// Residual, stated rather than hidden, and now smaller: the all-lowercase pair
// `@ceo/cto` is still read as a scope and dropped. No lexical rule separates it
// from `@types/node`. The narrowing also costs one false positive in the other
// direction — a capitalized repo segment (`@Blockcast/Network-Operator-Portal`)
// reports `Blockcast` again — which is the cheap failure being bought with the
// expensive one.
//
// ACCEPTED, NOT FIXED: a bare decorator, `@Injectable`. It is lexically
// IDENTICAL to a bare name mention, and agent names here are capitalized too
// (`@Ceo`), so every candidate discriminator — capitalization, a known-decorator
// list — would also drop real mentions. The common `` `@Injectable` `` form is
// already masked as inline code. Reporting it costs its author one glance;
// suppressing it would cost a class of real mention. Per the cost asymmetry
// above, the false positive is the correct failure, so this one is kept.
//
// ⛔ NOT an option for either half: narrowing to a known-agent-name allowlist.
// That reintroduces exactly the name-matching ambiguity ruled out above, and it
// would make an unbound mention of a DEPARTED agent invisible — the single case
// most worth reporting.
// ---------------------------------------------------------------------------

/** Cap on reported tokens, so a pathological body cannot inflate a response. */
export const MAX_UNBOUND_MENTION_TOKENS = 20;

/** Cap on the reported length of any single token. */
const MAX_UNBOUND_MENTION_TOKEN_LENGTH = 64;

/**
 * An `@`-shaped token. Deliberately starts with a letter: `@1`, `@_` and the
 * `@` in `a@b` are not plausible names, and reporting them would be noise.
 */
const AT_TOKEN_RE = /@([A-Za-z][A-Za-z0-9._-]*)/g;

/**
 * The character class that can open the second half of a scoped package or org
 * path — `@types/node`, `@Blockcast/onprem-k8s-ally-reviewer`. Deliberately
 * excludes `@`, which is what keeps the mention-pair form `@Ceo/@Cto` reported.
 *
 * Lowercase-and-digit only, which is narrower than it looks and deliberate. An
 * npm scope path segment MUST be lowercase, and a GitHub team slug is always
 * lowercased, so a real scope path essentially always opens lowercase. Agent
 * names here open with a capital. Narrowing to `[a-z0-9]` therefore recovers
 * `@Ceo/Cto` and `@Ceo/PlatformSRE`, which a wider class swallows as scopes —
 * and a swallowed real mention is the expensive failure, per the asymmetry
 * above. `.`, `_` and `-` are excluded for a stronger reason: an npm name
 * cannot begin with any of them, so they never open a real scope path.
 *
 * Stated cost, measured not assumed: an org path whose repo segment is
 * capitalized (`@Blockcast/Network-Operator-Portal`) reports `Blockcast` again.
 * That is a false positive costing one glance, bought with a false negative. The
 * paths this corpus actually writes — `@Blockcast/paperclip`,
 * `@Blockcast/penstock-llm-proxy-core`, `@Blockcast/onprem-k8s-ally-reviewer` —
 * are lowercase and stay suppressed. The all-lowercase pair `@ceo/cto` is the
 * remaining residual and is unreachable by any lexical rule.
 */
const SCOPE_PATH_CHAR_RE = /[a-z0-9]/;

/** Any mention link, whatever its scheme. Used to locate well-formed mentions. */
const ANY_MENTION_LINK_RE =
  /\[([^\]]*)]\(((?:project|agent|user|skill|routine|pipeline):\/\/[^)\s]+)\)/gi;

/** Fenced code blocks — ``` or ~~~ delimited, including an unterminated tail. */
const FENCED_CODE_RE = /(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*(?=\n|$)|$)/g;

/** Inline code spans. */
const INLINE_CODE_RE = /`[^`\n]*`/g;

/** Blockquote lines — a quoted prior comment is not a fresh mention. */
const BLOCKQUOTE_LINE_RE = /^[ \t]*>[^\n]*/gm;

/** Bare URLs and autolinks, whose userinfo or fragment can look like a token. */
const URL_RE = /<?\b(?:https?|mailto):\/{0,2}[^\s<>)]+>?/gi;

/** Email addresses — `ops@example.com` is not a mention of `@example`. */
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Blank out a region while preserving every character offset, so later passes
 * over the same string still line up with the original.
 */
function maskRange(chars: string[], start: number, end: number): void {
  for (let i = start; i < end && i < chars.length; i += 1) {
    chars[i] = " ";
  }
}

function maskPattern(chars: string[], source: string, re: RegExp): void {
  const scanner = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(source)) !== null) {
    maskRange(chars, match.index, match.index + match[0].length);
    if (match[0].length === 0) scanner.lastIndex += 1;
  }
}

export interface UnboundMentionScanOptions {
  /**
   * Agent ids that actually resolved to a real agent the wake could be
   * delivered to. A mention link whose target is in this set is bound, and its
   * label is not reported; every other `@` token is.
   */
  boundAgentIds?: readonly string[];
}

/**
 * Return the `@`-shaped tokens in `markdown` that bound to no agent.
 *
 * A token is treated as BOUND only when it is the label of a mention link
 * whose target actually resolved:
 *
 *   - `[@Ceo](agent://<id>)` where `<id>` is in `boundAgentIds` — bound, silent.
 *   - `[@Ceo](agent://<unknown>)` — well formed but resolved to nobody, so the
 *     wake is dropped just as silently as a plain name. Reported.
 *   - `[@taylor](user://<id>)` and the other non-agent schemes — well-formed
 *     mention syntax for a different subject. Out of scope here, not reported.
 *   - plain `@Ceo` — reported. This is the defect of record.
 *
 * Code spans, fenced blocks, blockquotes, URLs and email addresses are masked
 * first: a name inside a quoted prior comment or a `user@host` is not somebody
 * asking for a wake, and reporting it would train readers to ignore the field.
 * A token directly followed by `/<scope-char>` is skipped for the same reason —
 * `@types/node` is a package, not a person (PEN-5187).
 */
export function extractUnboundMentionTokens(
  markdown: string,
  options: UnboundMentionScanOptions = {},
): string[] {
  if (!markdown) return [];

  const bound = new Set(options.boundAgentIds ?? []);
  // Indexed by UTF-16 code unit, which is the offset space every `RegExp`
  // below reports in, so masking stays aligned with the original string.
  const units = markdown.split("");

  maskPattern(units, markdown, FENCED_CODE_RE);
  const afterFences = units.join("");
  maskPattern(units, afterFences, INLINE_CODE_RE);
  maskPattern(units, units.join(""), BLOCKQUOTE_LINE_RE);
  maskPattern(units, units.join(""), URL_RE);
  maskPattern(units, units.join(""), EMAIL_RE);

  // Mask the labels of mention links that are NOT an unresolved agent link.
  // Scan the original text so a link is still located even if a later pass
  // blanked part of its href.
  const linkScanner = new RegExp(ANY_MENTION_LINK_RE.source, ANY_MENTION_LINK_RE.flags);
  let link: RegExpExecArray | null;
  while ((link = linkScanner.exec(markdown)) !== null) {
    const href = link[2] ?? "";
    const isAgentLink = href.toLowerCase().startsWith(AGENT_MENTION_SCHEME);
    if (isAgentLink) {
      const parsed = parseAgentMentionHref(href);
      // An agent link that resolved is bound. One that did not is left visible
      // so its label is reported — a well-formed href pointing at nobody drops
      // the wake exactly as silently as a plain name does.
      if (!parsed || !bound.has(parsed.agentId)) continue;
    }
    maskRange(units, link.index, link.index + link[0].length);
  }

  const scanned = units.join("");
  const seen = new Set<string>();
  const tokens: string[] = [];
  const tokenScanner = new RegExp(AT_TOKEN_RE.source, AT_TOKEN_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = tokenScanner.exec(scanned)) !== null) {
    // `foo@bar` is not a mention; require the `@` to open a word.
    const prev = match.index > 0 ? scanned[match.index - 1] : "";
    if (prev && /[A-Za-z0-9]/.test(prev)) continue;

    // PEN-5187: a token directly followed by `/<scope-char>` is a scoped
    // package or an org path, not a name — `@types/node`, `@paperclipai/shared`,
    // `@Blockcast/onprem-k8s-ally-reviewer`. An agent name is never followed by
    // a slash, so this costs no real mention.
    //
    // The `<scope-char>` half is load-bearing, not decoration, in two ways.
    // Skipping on a bare `/` would also drop `@Ceo/@Cto`, ordinary prose for
    // addressing two people. Admitting uppercase would drop `@Ceo/Cto`, the
    // same address written without the second `@`. Both are real unbound
    // mentions, and dropping one is the expensive failure here, where a
    // spurious token costs one glance. See `SCOPE_PATH_CHAR_RE` for why
    // lowercase-and-digit is the discriminator and what it costs.
    const after = scanned.slice(match.index + match[0].length, match.index + match[0].length + 2);
    if (after[0] === "/" && after[1] !== undefined && SCOPE_PATH_CHAR_RE.test(after[1])) continue;

    // Trim trailing punctuation that markdown prose attaches to a name:
    // "@Ceo." and "@Ceo-" both mean `Ceo`.
    const raw = (match[1] ?? "").replace(/[._-]+$/, "");
    if (!raw) continue;

    const token = raw.slice(0, MAX_UNBOUND_MENTION_TOKEN_LENGTH);
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push(token);
    if (tokens.length >= MAX_UNBOUND_MENTION_TOKENS) break;
  }

  return tokens;
}
