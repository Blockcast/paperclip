/**
 * Body/evidence duplicate matching for issue creation (BLO-18799).
 *
 * The original guard compared normalized titles for exact equality, which misses
 * the dominant real-world failure: four runs filing one defect under four
 * different titles ("PATCH drops `monitor`" vs "`paperclipUpdateIssue` drops
 * top-level `monitor`" vs "re-arm is silently discarded"). Those titles share
 * almost no tokens while the bodies carry near-identical evidence — the same
 * symbols (`monitorNextCheckAt`, `executionPolicy.monitor`), the same file
 * references, and overlapping issue references.
 *
 * So we match on the *evidence* instead. Each document is reduced to a set of
 * weighted features drawn from title + description:
 *
 *   - `symbol`    code identifiers: camelCase, snake_case, dotted paths, and
 *                 anything inside backticks or fenced code
 *   - `path`      repo-relative file paths (line numbers stripped)
 *   - `reference` issue identifiers (BLO-1234) and PR/issue refs (#806)
 *   - `term`      remaining prose words, stopword-filtered
 *
 * Feature weight is `classWeight * idf`, where idf is computed over the
 * candidate window supplied by the caller. The idf term is what makes this
 * usable against agent-authored issues: our own templates put "## Acceptance
 * criteria", "## Verifying signal", "Server test asserting", and "non-2xx" in
 * nearly every issue, so those tokens appear in most candidates and their
 * weight collapses toward zero without any hand-maintained blocklist.
 *
 * Similarity is weighted Jaccard over the union — deliberately the conservative
 * choice over containment, which would flag every short issue whose evidence is
 * a subset of some sprawling epic.
 *
 * A score alone is not enough to refuse a create, so a match additionally
 * requires `minSharedDistinctiveFeatures` shared *distinctive* features
 * (symbol/path/reference with idf above a floor). Prose overlap by itself can
 * never trip the guard; two issues must cite the same concrete evidence.
 *
 * Pure and dependency-free by design: the create path, the unit tests, and the
 * offline backfill script all run the identical code.
 */

export const ISSUE_DUPLICATE_FEATURE_CLASSES = ["symbol", "path", "reference", "term"] as const;

export type IssueDuplicateFeatureClass = (typeof ISSUE_DUPLICATE_FEATURE_CLASSES)[number];

/** Relative pull of each feature class before idf scaling. */
export const ISSUE_DUPLICATE_FEATURE_CLASS_WEIGHTS: Record<IssueDuplicateFeatureClass, number> = {
  symbol: 3,
  path: 3,
  reference: 2,
  term: 1,
};

export interface IssueDuplicateMatcherOptions {
  /** Minimum weighted-Jaccard similarity for a candidate to match. */
  scoreThreshold?: number;
  /** Minimum shared symbol/path/reference features required alongside the score. */
  minSharedDistinctiveFeatures?: number;
  /** idf floor a shared feature must clear to count as distinctive. */
  distinctiveIdfFloor?: number;
  /** Cap on candidates returned, highest score first. */
  maxCandidates?: number;
  /**
   * Floor for the corpus size used in the idf denominator.
   *
   * Without it the matcher is pathological on small windows: with four
   * documents that are all the same defect, the tokens that prove it
   * (`monitorNextCheckAt`, `executionPolicy.monitor`) appear in 4/4 documents
   * and idf drives their weight to ~0 — the strongest evidence scores as
   * boilerplate. Scoring df against `max(windowSize, referenceCorpusSize)`
   * makes a small window behave like the production-sized one the thresholds
   * were calibrated on, so a unit test and a live 3000-issue window agree.
   */
  referenceCorpusSize?: number;
}

/**
 * Calibrated against the trailing-30-day, manual-origin Paperclip corpus
 * (3645 issues; see `server/scripts/issue-duplicate-backfill.ts`).
 *
 * Every one of the 12 ordered pairs among the four BLO-18168/18782/18783/18790
 * filings scores in 0.174–0.299, and each of the four ranks the other three as
 * its top three neighbours. The strongest neighbour outside the group scores
 * 0.133 and the issue *about* those four (BLO-18799) scores 0.117–0.126, so
 * 0.16 sits in the gap.
 *
 * `minSharedDistinctiveFeatures` is deliberately a low floor rather than a
 * discriminator: real pairs in that corpus shared 47-59 distinctive features and
 * unrelated ones still shared 18-43, because long issues share a lot of
 * vocabulary. Its job is only to stop a short prose-only overlap from matching
 * on score alone, so it must not scale with document length.
 */
export const ISSUE_DUPLICATE_MATCHER_DEFAULTS: Required<IssueDuplicateMatcherOptions> = {
  scoreThreshold: 0.16,
  minSharedDistinctiveFeatures: 5,
  distinctiveIdfFloor: 0.4,
  maxCandidates: 5,
  referenceCorpusSize: 200,
};

export interface IssueDuplicateDocument {
  /** Caller-owned key echoed back on candidates (issue id in practice). */
  id: string;
  identifier?: string | null;
  title: string;
  description?: string | null;
}

export interface IssueDuplicateSharedFeature {
  token: string;
  featureClass: IssueDuplicateFeatureClass;
  idf: number;
  weight: number;
}

export interface IssueDuplicateCandidate {
  id: string;
  identifier: string | null;
  title: string;
  score: number;
  sharedDistinctiveFeatureCount: number;
  /** Highest-weight shared features first — this is the "why" shown to callers. */
  sharedFeatures: IssueDuplicateSharedFeature[];
}

/**
 * Common English + markdown scaffolding. Domain boilerplate is handled by idf,
 * not here; this list only removes words too common for df over a bounded
 * window to reliably discount.
 */
const STOPWORDS = new Set([
  "about", "above", "after", "again", "against", "algo", "also", "although", "always", "among",
  "another", "any", "anything", "are", "aren", "around", "because", "been", "before", "being",
  "below", "best", "better", "between", "both", "but", "came", "can", "cannot", "come", "could",
  "did", "didn", "does", "doesn", "doing", "don", "done", "down", "during", "each", "either",
  "else", "enough", "even", "ever", "every", "few", "for", "from", "further", "get", "gets",
  "getting", "give", "goes", "going", "gone", "got", "had", "has", "hasn", "have", "haven",
  "having", "her", "here", "hers", "him", "his", "how", "however", "into", "isn", "its", "itself",
  "just", "keep", "kept", "known", "knows", "least", "less", "let", "like", "made", "make",
  "makes", "making", "many", "may", "maybe", "mean", "means", "meant", "might", "more", "most",
  "much", "must", "need", "needed", "needs", "never", "next", "not", "nothing", "now", "off",
  "often", "once", "one", "only", "onto", "other", "others", "our", "ours", "out", "over", "own",
  "per", "put", "quite", "rather", "really", "same", "see", "seen", "several", "shall", "she",
  "should", "shouldn", "since", "some", "something", "still", "such", "sure", "take", "taken",
  "takes", "than", "that", "the", "their", "theirs", "them", "then", "there", "these", "they",
  "thing", "things", "this", "those", "though", "through", "thus", "too", "took", "toward",
  "under", "until", "upon", "use", "used", "uses", "using", "very", "via", "want", "wants",
  "was", "wasn", "way", "well", "went", "were", "weren", "what", "when", "where", "whether",
  "which", "while", "who", "whom", "whose", "why", "will", "with", "within", "without", "won",
  "would", "wouldn", "yet", "you", "your", "yours",
]);

const MIN_TERM_LENGTH = 4;

const ISSUE_REFERENCE_RE = /\b[A-Z][A-Z0-9]{1,9}-\d{1,7}\b/g;
const NUMERIC_REFERENCE_RE = /(?:^|[\s([])#(\d{1,7})\b/g;
const FENCED_CODE_BLOCK_RE = /^[ \t]*`{3,}[^\n`]*(?:\r?\n[\s\S]*?\r?\n[ \t]*`{3,}[ \t]*(?=\r?\n|$))/gm;
const FENCED_CODE_BLOCK_OPEN_RE = /^[ \t]*`{3,}[^\n`]*\r?\n/;
const FENCED_CODE_BLOCK_CLOSE_RE = /\r?\n[ \t]*`{3,}[ \t]*$/;
const INLINE_CODE_SPAN_RE = /(`+)([^\n]*?)(?<!`)\1(?!`)/g;
const URL_RE = /\bhttps?:\/\/\S+/g;
const PATH_RE = /\b(?:[A-Za-z0-9_.-]+\/){1,}[A-Za-z0-9_.-]+\b/g;
const IDENTIFIER_RE = /\b[A-Za-z_$][A-Za-z0-9_$]*(?:[.:][A-Za-z_$][A-Za-z0-9_$]*)*\b/g;
const WORD_RE = /[A-Za-z][A-Za-z'-]*/g;

function isDottedSymbol(token: string): boolean {
  return token.includes(".") && /[A-Za-z_$]/.test(token[0] ?? "");
}

function isCasedSymbol(token: string): boolean {
  // camelCase / PascalCase with an internal hump, or snake_case.
  return /[a-z][A-Z]/.test(token) || (token.includes("_") && /[A-Za-z]/.test(token));
}

function looksLikePath(token: string): boolean {
  if (!token.includes("/")) return false;
  // Require either a file extension or more than one segment of real depth, so
  // "and/or" or "24/7" do not register as paths.
  const segments = token.split("/").filter(Boolean);
  if (segments.length < 2) return false;
  return /\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(token) || segments.length >= 3;
}

function stripTrailingLineNumber(token: string): string {
  // "server/src/routes/issues.ts:8242" -> "server/src/routes/issues.ts"
  return token.replace(/:\d+(?::\d+)?$/, "");
}

/**
 * Unwrap one code span to its contents.
 *
 * Fenced and inline spans must be unwrapped by different rules. A fence may
 * carry an info string (```` ```ts ````) that is markup, not evidence, so it is
 * dropped; an inline span never does, and treating its leading word as one is
 * how `` `monitor` `` used to be erased entirely — the language-tag pattern ate
 * the backtick *and* the all-letters body, and the closing replacement removed
 * what was left. That silently excluded exactly the lowercase identifiers this
 * defect class turns on.
 */
function unwrapCodeSpan(span: string): string {
  if (FENCED_CODE_BLOCK_OPEN_RE.test(span)) {
    return span.replace(FENCED_CODE_BLOCK_OPEN_RE, "").replace(FENCED_CODE_BLOCK_CLOSE_RE, "");
  }
  const delimiter = span.match(/^`+/)?.[0];
  if (delimiter && span.endsWith(delimiter)) {
    return span.slice(delimiter.length, -delimiter.length);
  }
  return span.replace(/^`+/, "").replace(/`+$/, "");
}

function extractCodeText(text: string): string {
  const fencedBlocks = text.match(FENCED_CODE_BLOCK_RE) ?? [];
  const withoutFencedBlocks = text.replace(FENCED_CODE_BLOCK_RE, " ");
  const inlineSpans = withoutFencedBlocks.match(INLINE_CODE_SPAN_RE) ?? [];
  return [...fencedBlocks, ...inlineSpans].map(unwrapCodeSpan).join("\n");
}

function stripCodeMarkup(text: string): string {
  return text
    .replace(FENCED_CODE_BLOCK_RE, (span) => `\n${unwrapCodeSpan(span)}\n`)
    .replace(INLINE_CODE_SPAN_RE, (_span, _ticks: string, body: string) => body);
}

/**
 * Reduce one issue to its deduplicated feature set.
 *
 * Feature classes are assigned by strongest match: a token that looks like a
 * path is never also counted as a prose term, so the class weights stay
 * meaningful. Dotted symbols additionally contribute their trailing component
 * (`executionPolicy.monitor` also yields `monitor`) so that two issues
 * describing the same field via different access paths still overlap.
 */
export function extractIssueDuplicateFeatures(
  document: Pick<IssueDuplicateDocument, "title" | "description">,
): Map<string, IssueDuplicateFeatureClass> {
  const features = new Map<string, IssueDuplicateFeatureClass>();
  const add = (rawToken: string, featureClass: IssueDuplicateFeatureClass) => {
    const token = rawToken.trim().toLowerCase();
    if (!token) return;
    const existing = features.get(token);
    if (existing === undefined) {
      features.set(token, featureClass);
      return;
    }
    // Keep the highest-weight class if the same token surfaces two ways.
    if (
      ISSUE_DUPLICATE_FEATURE_CLASS_WEIGHTS[featureClass] >
      ISSUE_DUPLICATE_FEATURE_CLASS_WEIGHTS[existing]
    ) {
      features.set(token, featureClass);
    }
  };

  const title = document.title ?? "";
  const description = document.description ?? "";
  const raw = `${title}\n\n${description}`;

  for (const match of raw.match(ISSUE_REFERENCE_RE) ?? []) add(match, "reference");
  for (const match of raw.matchAll(NUMERIC_REFERENCE_RE)) add(`#${match[1]}`, "reference");

  // URLs are dropped wholesale: they are mostly issue permalinks whose signal is
  // already captured as a reference, and their host/path segments would
  // otherwise inflate overlap between unrelated issues.
  const withoutUrls = raw.replace(URL_RE, " ");

  // Code spans are the densest evidence, so mine them before generic prose and
  // let their contents register as symbols/paths.
  const codeText = extractCodeText(withoutUrls);
  const withoutCodeMarkup = stripCodeMarkup(withoutUrls);

  for (const source of [codeText, withoutCodeMarkup]) {
    for (const rawPath of source.match(PATH_RE) ?? []) {
      const path = stripTrailingLineNumber(rawPath);
      if (looksLikePath(path)) add(path, "path");
    }
    for (const rawIdentifier of source.match(IDENTIFIER_RE) ?? []) {
      const identifier = stripTrailingLineNumber(rawIdentifier);
      if (identifier.length < 3) continue;
      if (isDottedSymbol(identifier)) {
        add(identifier, "symbol");
        const tail = identifier.split(".").pop();
        if (tail && tail.length >= 3) add(tail, "symbol");
        continue;
      }
      if (isCasedSymbol(identifier)) add(identifier, "symbol");
    }
  }

  // Bare identifiers inside code spans count as symbols even without a hump or
  // dot — `triggered`, `monitor`, `scheduled` are the evidence in this defect
  // class, and the author marked them as code for exactly that reason.
  for (const word of codeText.match(WORD_RE) ?? []) {
    if (word.length < 3) continue;
    if (STOPWORDS.has(word.toLowerCase())) continue;
    add(word, "symbol");
  }

  for (const word of withoutCodeMarkup.match(WORD_RE) ?? []) {
    const lower = word.toLowerCase();
    if (lower.length < MIN_TERM_LENGTH) continue;
    if (STOPWORDS.has(lower)) continue;
    add(lower, "term");
  }

  return features;
}

function isDistinctiveClass(featureClass: IssueDuplicateFeatureClass): boolean {
  return featureClass !== "term";
}

/**
 * A scored window.
 *
 * idf is a corpus-level property, but the feature *class* is deliberately
 * per-document. Promoting a token to the strongest class any document gave it
 * would let a single author's backticks reclassify that word for everyone: one
 * issue writing `` `request` `` would turn the same word into "symbol" evidence
 * in every prose-only issue in the window, and enough of those could carry a
 * pair over `minSharedDistinctiveFeatures` on prose alone — the one thing the
 * distinctive floor exists to prevent.
 *
 * Keeping classes per-document makes a shared token's weight differ by side, so
 * the weighted Jaccard uses min/max over the pair: the intersection takes
 * `min(weightLeft, weightRight)` and the union is
 * `totalLeft + totalRight - sum(min)`. That still collapses to one pass over
 * the smaller token set, so pairwise scoring stays O(min(|A|,|B|)).
 */
interface ScoredWindow {
  documents: IssueDuplicateDocument[];
  /** Per-document token -> class maps, index-aligned with `documents`. */
  features: Map<string, IssueDuplicateFeatureClass>[];
  totalWeight: number[];
  idf: Map<string, number>;
  /** Distinctive token -> document indices, for candidate-pair blocking. */
  postings: Map<string, number[]>;
  /** The floor `postings` was built with; shared-feature counting must agree. */
  distinctiveIdfFloor: number;
}

/** Weight of a token given the class *one document* assigned it; 0 if absent. */
function weightFor(tokenClass: IssueDuplicateFeatureClass | undefined, tokenIdf: number): number {
  if (tokenClass === undefined) return 0;
  return ISSUE_DUPLICATE_FEATURE_CLASS_WEIGHTS[tokenClass] * tokenIdf;
}

/** Whether a token is concrete evidence under one document's own classification. */
function isDistinctiveFor(
  tokenClass: IssueDuplicateFeatureClass | undefined,
  tokenIdf: number,
  distinctiveIdfFloor: number,
): boolean {
  if (tokenClass === undefined || !isDistinctiveClass(tokenClass)) return false;
  return tokenIdf >= distinctiveIdfFloor;
}

/** Weight of `token` *as document `index` classified it*; 0 if absent. */
function tokenWeightIn(window: ScoredWindow, index: number, token: string): number {
  return weightFor(window.features[index]!.get(token), window.idf.get(token) ?? 0);
}

/** Whether `token` is evidence *in document `index`*, not merely somewhere. */
function isDistinctiveIn(window: ScoredWindow, index: number, token: string): boolean {
  return isDistinctiveFor(
    window.features[index]!.get(token),
    window.idf.get(token) ?? 0,
    window.distinctiveIdfFloor,
  );
}

function buildScoredWindow(
  documents: readonly IssueDuplicateDocument[],
  distinctiveIdfFloor: number,
  referenceCorpusSize: number,
): ScoredWindow {
  const features = documents.map((document) => extractIssueDuplicateFeatures(document));

  const documentFrequency = new Map<string, number>();
  for (const perDocument of features) {
    for (const token of perDocument.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const total = Math.max(documents.length, referenceCorpusSize);
  const idf = new Map<string, number>();
  for (const [token, df] of documentFrequency) {
    // BM25-style idf: a token in every document lands near zero, which is what
    // discounts our shared issue-template boilerplate without a blocklist.
    idf.set(token, Math.log(1 + (total - df + 0.5) / (df + 0.5)));
  }

  const totalWeight = features.map((perDocument) => {
    let sum = 0;
    for (const [token, tokenClass] of perDocument) sum += weightFor(tokenClass, idf.get(token) ?? 0);
    return sum;
  });

  const postings = new Map<string, number[]>();
  for (const [index, perDocument] of features.entries()) {
    for (const [token, tokenClass] of perDocument) {
      if (!isDistinctiveFor(tokenClass, idf.get(token) ?? 0, distinctiveIdfFloor)) continue;
      const list = postings.get(token);
      if (list) list.push(index);
      else postings.set(token, [index]);
    }
  }

  return { documents: [...documents], features, totalWeight, idf, postings, distinctiveIdfFloor };
}

export interface IssueDuplicatePairScore {
  score: number;
  sharedDistinctiveFeatureCount: number;
  sharedFeatures: IssueDuplicateSharedFeature[];
}

function scorePair(window: ScoredWindow, leftIndex: number, rightIndex: number): IssueDuplicatePairScore {
  const left = window.features[leftIndex]!;
  const right = window.features[rightIndex]!;
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];

  const sharedFeatures: IssueDuplicateSharedFeature[] = [];
  let intersectionWeight = 0;
  let sharedDistinctiveFeatureCount = 0;

  for (const token of smaller.keys()) {
    if (!larger.has(token)) continue;
    const tokenIdf = window.idf.get(token) ?? 0;
    const leftWeight = tokenWeightIn(window, leftIndex, token);
    const rightWeight = tokenWeightIn(window, rightIndex, token);
    // A token counts for the pair only as strongly as the *weaker* side saw it,
    // so one side's backticks cannot upgrade the other side's prose.
    const pairWeight = Math.min(leftWeight, rightWeight);
    const pairClass = leftWeight <= rightWeight ? left.get(token)! : right.get(token)!;
    intersectionWeight += pairWeight;
    sharedFeatures.push({ token, featureClass: pairClass, idf: tokenIdf, weight: pairWeight });
    // Likewise distinctive only when *both* documents treated it as evidence.
    if (isDistinctiveIn(window, leftIndex, token) && isDistinctiveIn(window, rightIndex, token)) {
      sharedDistinctiveFeatureCount += 1;
    }
  }

  const unionWeight =
    window.totalWeight[leftIndex]! + window.totalWeight[rightIndex]! - intersectionWeight;

  sharedFeatures.sort((a, b) => b.weight - a.weight || a.token.localeCompare(b.token));

  return {
    score: unionWeight > 0 ? intersectionWeight / unionWeight : 0,
    sharedDistinctiveFeatureCount,
    sharedFeatures,
  };
}

/**
 * Document indices sharing at least `minShared` distinctive features with
 * `index`, counted straight off the inverted index.
 *
 * This is not a heuristic pre-filter: the count it produces *is* the gate that
 * `minSharedDistinctiveFeatures` applies, so blocking here cannot drop a pair
 * that would otherwise have matched. It just avoids scoring the vast majority
 * of pairs that share no concrete evidence at all.
 *
 * Only tokens `index` itself classified as distinctive are walked, which is
 * what makes the count agree with `scorePair`'s both-sides rule: `postings`
 * already holds only the documents that classified the token distinctively.
 */
function distinctiveNeighbours(
  window: ScoredWindow,
  index: number,
  minShared: number,
  onlyGreaterThanIndex: boolean,
): Map<number, number> {
  const counts = new Map<number, number>();
  for (const token of window.features[index]!.keys()) {
    if (!isDistinctiveIn(window, index, token)) continue;
    const list = window.postings.get(token);
    if (!list) continue;
    for (const other of list) {
      if (other === index) continue;
      if (onlyGreaterThanIndex && other <= index) continue;
      counts.set(other, (counts.get(other) ?? 0) + 1);
    }
  }
  for (const [other, count] of counts) {
    if (count < minShared) counts.delete(other);
  }
  return counts;
}

export interface FindIssueDuplicateCandidatesResult {
  candidates: IssueDuplicateCandidate[];
}

/**
 * Score `subject` against `corpus` and return the candidates that clear both
 * the score threshold and the distinctive-feature floor.
 *
 * idf is computed over `[subject, ...corpus]`, so the caller's window choice is
 * part of the contract: pass the same window you would show a human reviewer.
 */
export function findIssueDuplicateCandidates(
  subject: IssueDuplicateDocument,
  corpus: readonly IssueDuplicateDocument[],
  options: IssueDuplicateMatcherOptions = {},
): FindIssueDuplicateCandidatesResult {
  const {
    scoreThreshold, minSharedDistinctiveFeatures, distinctiveIdfFloor, maxCandidates, referenceCorpusSize,
  } = {
    ...ISSUE_DUPLICATE_MATCHER_DEFAULTS,
    ...options,
  };
  if (corpus.length === 0) return { candidates: [] };

  // The subject sits at index 0 of the window so it contributes to df like any
  // other document.
  const window = buildScoredWindow([subject, ...corpus], distinctiveIdfFloor, referenceCorpusSize);
  const neighbours = distinctiveNeighbours(window, 0, minSharedDistinctiveFeatures, false);

  const candidates: IssueDuplicateCandidate[] = [];
  for (const index of neighbours.keys()) {
    const document = window.documents[index]!;
    if (document.id === subject.id) continue;
    const { score, sharedDistinctiveFeatureCount, sharedFeatures } = scorePair(window, 0, index);
    if (score < scoreThreshold) continue;
    if (sharedDistinctiveFeatureCount < minSharedDistinctiveFeatures) continue;
    candidates.push({
      id: document.id,
      identifier: document.identifier ?? null,
      title: document.title,
      score,
      sharedDistinctiveFeatureCount,
      // Keep the explanation short enough to fit in an error message.
      sharedFeatures: sharedFeatures.slice(0, 12),
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { candidates: candidates.slice(0, maxCandidates) };
}

export interface IssueDuplicateCluster {
  /** Member ids, ordered as supplied. */
  ids: string[];
  identifiers: string[];
}

/**
 * Union-find clustering over all pairs above threshold. Used by the offline
 * backfill to report cluster counts over a historical window; the live create
 * path uses `findIssueDuplicateCandidates` instead.
 */
export function clusterIssueDuplicates(
  documents: readonly IssueDuplicateDocument[],
  options: IssueDuplicateMatcherOptions = {},
): IssueDuplicateCluster[] {
  const { scoreThreshold, minSharedDistinctiveFeatures, distinctiveIdfFloor, referenceCorpusSize } = {
    ...ISSUE_DUPLICATE_MATCHER_DEFAULTS,
    ...options,
  };
  const window = buildScoredWindow(documents, distinctiveIdfFloor, referenceCorpusSize);

  const parent = documents.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    let cursor = index;
    while (parent[cursor] !== root) {
      const next = parent[cursor]!;
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  for (let i = 0; i < documents.length; i += 1) {
    // onlyGreaterThanIndex keeps each pair to a single visit.
    for (const j of distinctiveNeighbours(window, i, minSharedDistinctiveFeatures, true).keys()) {
      const { score, sharedDistinctiveFeatureCount } = scorePair(window, i, j);
      if (score >= scoreThreshold && sharedDistinctiveFeatureCount >= minSharedDistinctiveFeatures) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < documents.length; i += 1) {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(i);
    else groups.set(root, [i]);
  }

  return Array.from(groups.values())
    .filter((group) => group.length > 1)
    .map((group) => ({
      ids: group.map((index) => window.documents[index]!.id),
      identifiers: group.map(
        (index) => window.documents[index]!.identifier ?? window.documents[index]!.id,
      ),
    }));
}

/**
 * Human-readable one-liner per candidate for the refusal message. Kept here so
 * the API error, the MCP tool surface, and the backfill report all phrase the
 * evidence the same way.
 */
export function describeIssueDuplicateCandidate(candidate: IssueDuplicateCandidate): string {
  const evidence = candidate.sharedFeatures
    .slice(0, 5)
    .map((feature) => feature.token)
    .join(", ");
  const label = candidate.identifier ?? candidate.id;
  return `${label} (score ${candidate.score.toFixed(2)}; shared evidence: ${evidence})`;
}
