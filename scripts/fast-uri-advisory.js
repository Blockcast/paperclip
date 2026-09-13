// Every npm advisory published against fast-uri, read live from
// `GET /advisories?ecosystem=npm&affects=fast-uri` on 2026-09-13.
//
// Encode each advisory SEPARATELY, verbatim in GitHub's own range syntax, and
// derive the union below. Three tickets in a row hand-merged this table and
// each one missed an advisory: the version before this commit encoded
// GHSA-5jgf alone and therefore accepted 3.0.0-3.1.2 and 4.0.0, which five
// other live advisories declare vulnerable. A hand-merged summary cannot be
// diffed against the advisory page; a verbatim copy can, and adding the next
// advisory is one appended entry rather than a re-derivation of the union.
//
// Re-read the source of truth with:
//   gh api 'advisories?ecosystem=npm&affects=fast-uri&per_page=100' \
//     --jq '.[]|"\(.ghsa_id) \([.vulnerabilities[]
//            |select(.package.name=="fast-uri")|.vulnerable_version_range]|join(" ; "))"'
export const FAST_URI_ADVISORIES = [
  {
    id: "GHSA-5jgf-p345-68v8",
    ranges: [">= 2.4.2, < 2.4.5", ">= 3.1.3, < 3.1.6", ">= 4.0.1, < 4.1.3"],
  },
  {
    id: "GHSA-f65p-4m7j-42xc",
    ranges: [">= 2.3.1, < 2.4.5", ">= 3.0.0, < 3.1.6", ">= 4.0.0, < 4.1.3"],
  },
  {
    id: "GHSA-fph4-wmhf-6fwf",
    ranges: [">= 2.4.1, < 2.4.5", ">= 3.1.2, < 3.1.6", ">= 4.0.0, < 4.1.3"],
  },
  {
    id: "GHSA-jqff-g426-hqxp",
    ranges: [">= 2.3.1, < 2.4.5", ">= 3.0.0, < 3.1.6", ">= 4.0.0, < 4.1.3"],
  },
  {
    id: "GHSA-7p8r-x3mc-p8w7",
    ranges: ["< 2.4.4", ">= 3.0.0, < 3.1.5", ">= 4.0.0, < 4.1.2"],
  },
  {
    id: "GHSA-v2hh-gcrm-f6hx",
    ranges: [">= 2.3.1, <= 2.4.2", ">= 3.0.0, <= 3.1.3", ">= 4.0.0, <= 4.1.0"],
  },
  {
    id: "GHSA-4c8g-83qw-93j6",
    ranges: [">= 4.0.0, < 4.0.1", ">= 3.0.0, < 3.1.3", ">= 2.3.1, < 2.4.2"],
  },
  {
    id: "GHSA-v39h-62p7-jpjc",
    ranges: [">= 3.0.0, <= 3.1.1", "<= 2.4.0"],
  },
  {
    id: "GHSA-q3j6-qgpj-74h6",
    ranges: [">= 3.0.0, <= 3.1.0", "<= 2.4.0"],
  },
];

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function parseVersion(version) {
  const parts = String(version).split(".").map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`unparseable fast-uri version ${version}`);
  }
  return parts.slice(0, 3);
}

// GitHub writes both inclusive and exclusive upper bounds, and omits the lower
// bound entirely on the oldest advisories. Normalise to a half-open
// [introduced, fixed) pair so every comparison downstream is the same shape --
// doing that `<= X` -> `< X+1` arithmetic by hand at transcription time is
// precisely what this module keeps getting wrong.
const RANGE = /^(?:(>=?)\s*(\d+\.\d+\.\d+)\s*,\s*)?(<=?)\s*(\d+\.\d+\.\d+)$/;

export function parseRange(range) {
  const match = RANGE.exec(String(range).trim());
  if (!match) throw new Error(`unparseable fast-uri range ${range}`);
  const [, lowOp, low, highOp, high] = match;

  const introduced = low ? parseVersion(low) : [0, 0, 0];
  if (lowOp === ">") introduced[2] += 1;

  const fixed = parseVersion(high);
  if (highOp === "<=") fixed[2] += 1;

  if (compare(introduced, fixed) >= 0) {
    throw new Error(`empty fast-uri range ${range}`);
  }
  return { introduced, fixed };
}

const PARSED = FAST_URI_ADVISORIES.map(({ id, ranges }) => ({
  id,
  ranges: ranges.map(parseRange),
}));

function covers({ introduced, fixed }, v) {
  return compare(v, introduced) >= 0 && compare(v, fixed) < 0;
}

// Half-open union across every advisory. Derived, never transcribed.
export const FAST_URI_VULNERABLE_RANGES = PARSED.flatMap((a) => a.ranges)
  .slice()
  .sort((a, b) => compare(a.introduced, b.introduced))
  .reduce((merged, range) => {
    const last = merged[merged.length - 1];
    if (last && compare(range.introduced, last.fixed) <= 0) {
      if (compare(range.fixed, last.fixed) > 0) last.fixed = [...range.fixed];
      return merged;
    }
    merged.push({ introduced: [...range.introduced], fixed: [...range.fixed] });
    return merged;
  }, []);

// The advisory IDs that declare `version` vulnerable -- empty when it sits
// outside every range. Ranges overlap, so several advisories can match at once
// and which one "the" match is is not recoverable from a version alone: a
// guard failure cites the set it matched. Naming one hardcoded advisory is how
// the other eight stayed invisible across three tickets.
export function fastUriAdvisoriesFor(version) {
  const v = parseVersion(version);
  return PARSED.filter(({ ranges }) => ranges.some((r) => covers(r, v))).map(
    ({ id }) => id,
  );
}

// True when `version` falls in any advisory range: introduced <= v < fixed.
export function isVulnerableFastUri(version) {
  return fastUriAdvisoriesFor(version).length > 0;
}
