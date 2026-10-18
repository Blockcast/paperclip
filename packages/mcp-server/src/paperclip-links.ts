import type { PaperclipMcpConfig } from "./config.js";

const ISSUE_OR_PROJECT_HREF_RE =
  /^\/(?:(?<company>[A-Za-z][A-Za-z0-9]*)\/)?(?<kind>issues|projects)\/(?<ref>[^#?\s/]+)(?<suffix>[#?][^\s]*)?$/;
const IDENTIFIER_PREFIX_RE = /^([A-Za-z][A-Za-z0-9]*)-\d+$/;

// PEN-4257: absolutization is scoped to keys whose value is a server-DERIVED
// navigation pointer, never to stored prose.
//
// It used to walk every string in the response and rewrite markdown links too,
// which silently corrupted the fields agents read-modify-write. A description
// stored as `[PEN-2111](/PEN/issues/PEN-2111)` was served as
// `[PEN-2111](https://paperclip.blockcast.net/PEN/issues/PEN-2111)`, so writing
// the value back persisted the rewrite — and because the write-response echo
// and the next read both passed through the same layer, the round-trip verified
// byte-identical and green. Four separate seats rediscovered that over seven
// weeks; the self-confirming verification is what made it survive.
//
// Every `href` the API emits is built server-side (`issueHref`,
// `buildIssueHref`, and peers) and is never round-tripped back into storage, so
// absolutizing those keeps relative paths like `/issues/PEN-2508#comment-abc`
// resolvable for callers that have no base URL, which is why this transform
// exists. Keep the allowlist narrow: an unlisted key is passed through
// untouched, so the failure direction for anything new is a link that stays
// relative — not storage that is silently rewritten.
//
// PEN-4262: `href` was not the whole set. Surveying every server-side builder
// of a relative issue/project path (`server/src`, six of them) against the key
// each is emitted under:
//
//   builder                                    key(s)              here?
//   company-search    issueHref                href                 yes
//   issue-references  issuePath → sourceHref   href                 yes
//   company-artifacts buildIssueHref           href                 yes
//   attention         issueHref                href                 yes
//   pipeline-case-    sourceIssuePath          sourceIssuePath      yes
//     outputs           └ sourceDocumentPath   documentPath         yes
//                       └ (same value)         path                 NO
//   feedback          buildIssuePath           path                 NO
//
// `sourceIssuePath` and `documentPath` qualify on the same grounds as `href`:
// each has exactly one producer, both in `pipeline-case-outputs.ts` and both
// derived from the company prefix plus the issue identifier, and neither is
// ever written back. The PR that introduced this allowlist measured "132 of 132
// occurrences were `href`" on an issue detail, a document and an inbox page —
// true of those surfaces, but none of them emits a pipeline case output, so the
// two keys above came back relative.
//
// Bare `path` is deliberately excluded even though it carries the same derived
// value in both places above. `feedback.ts` also uses `path` for artifact file
// paths (`adapter/claude/session.jsonl`, and `file.path` for user-supplied
// names), so it is not server-derived in general and admitting it would put
// stored content back inside the rewrite — the exact defect PEN-4257 closed.
// Those two emitters keep returning a relative path; the pipeline one sits
// beside a `sourceIssuePath` carrying the identical value, so nothing is lost.
// If the feedback one needs to be absolute, rename it at the source rather than
// widening this set.
const NAVIGATION_HREF_KEYS = new Set(["href", "sourceIssuePath", "documentPath"]);

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function stripApiSuffix(value: string): string {
  return value.replace(/\/api\/?$/, "");
}

export function paperclipPublicBaseUrl(config: PaperclipMcpConfig): string {
  const configured = config.publicUrl?.trim();
  return stripTrailingSlash(stripApiSuffix(configured || config.apiUrl));
}

function prefixFromRef(ref: string): string | null {
  let decoded = ref;
  try {
    decoded = decodeURIComponent(ref);
  } catch {
    decoded = ref;
  }
  const match = IDENTIFIER_PREFIX_RE.exec(decoded);
  return match ? match[1].toUpperCase() : null;
}

export function absolutizePaperclipHref(href: string, publicBaseUrl: string): string {
  const trimmed = href.trim();
  if (!trimmed.startsWith("/")) return href;

  const match = ISSUE_OR_PROJECT_HREF_RE.exec(trimmed);
  if (!match?.groups) return href;

  const kind = match.groups.kind;
  const ref = match.groups.ref;
  const suffix = match.groups.suffix ?? "";
  const company = match.groups.company ?? (kind === "issues" ? prefixFromRef(ref) : null);
  const path = company
    ? `/${company}/${kind}/${ref}${suffix}`
    : `/${kind}/${ref}${suffix}`;
  return `${publicBaseUrl}${path}`;
}

// `key` is the object key the string was reached under; array members inherit
// the key of the array itself so `{ href: ["/issues/X"] }` is still rewritten.
// A string reached under no key at all (a bare top-level response body) is
// stored content as far as this layer can tell, so it is left alone.
function absolutizeNode(value: unknown, publicBaseUrl: string, key: string | null): unknown {
  if (typeof value === "string") {
    return key !== null && NAVIGATION_HREF_KEYS.has(key)
      ? absolutizePaperclipHref(value, publicBaseUrl)
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => absolutizeNode(item, publicBaseUrl, key));
  }
  if (value && typeof value === "object") {
    const rewritten: Record<string, unknown> = {};
    for (const [nestedKey, nested] of Object.entries(value)) {
      rewritten[nestedKey] = absolutizeNode(nested, publicBaseUrl, nestedKey);
    }
    return rewritten;
  }
  return value;
}

export function absolutizePaperclipLinksInJson<T>(value: T, publicBaseUrl: string): T {
  return absolutizeNode(value, publicBaseUrl, null) as T;
}
