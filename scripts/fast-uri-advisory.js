// Vulnerable ranges for GHSA-5jgf-p345-68v8 / CVE-2026-75931 — "fast-uri
// vulnerable to host confusion via skipped IDN canonicalization on
// scheme-relative references".
//
// The advisory declares THREE disjoint vulnerable ranges, not one. Encoding
// only the 3.x range and short-circuiting on `major > 3` — as the guards here
// previously did — silently accepts 4.0.1 through 4.1.2, which this same
// advisory declares vulnerable. Keep the full set in one place so the guards
// cannot drift apart from each other.
//
// Source of truth: GET /advisories/GHSA-5jgf-p345-68v8
export const FAST_URI_ADVISORY = "GHSA-5jgf-p345-68v8 / CVE-2026-75931";

export const FAST_URI_VULNERABLE_RANGES = [
  { introduced: [2, 4, 2], fixed: [2, 4, 5] },
  { introduced: [3, 1, 3], fixed: [3, 1, 6] },
  { introduced: [4, 0, 1], fixed: [4, 1, 3] },
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

// True when `version` falls in any advisory range: introduced <= v < fixed.
export function isVulnerableFastUri(version) {
  const v = parseVersion(version);
  return FAST_URI_VULNERABLE_RANGES.some(
    ({ introduced, fixed }) =>
      compare(v, introduced) >= 0 && compare(v, fixed) < 0,
  );
}
