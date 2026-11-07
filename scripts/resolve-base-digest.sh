#!/usr/bin/env bash
#
# Resolve a floating base-image tag to an immutable <repo>@sha256:... reference,
# so an image build records WHICH base it used instead of leaving that decided by
# the wall clock (PEN-5927).
#
# This exists because the repo could not answer "what is inside sha-<x>?" from
# its own tree. Two paperclip-mcp-gateway images built from an identical tree
# five weeks apart landed on opposite sides of a CVE boundary — npm 10.9.8 bundles
# tar 7.5.11 (affected by CVE-2026-59873), npm 10.9.9 bundles 7.5.22 (clean) —
# and establishing that cost two published corrections on PEN-5690, read out of
# npm tarballs and nodejs.org/dist/index.json rather than out of the repo.
#
# Callers pass the resolved reference both as a build-arg (so every stage of a
# multi-stage build pins the same base, with no window for the tag to move
# mid-build) and as the org.opencontainers.image.base.name label (so the answer
# travels with the artifact and the next triage reads it back off the image).
#
# Fails closed: an unresolvable or malformed base is exit 1, never a silent
# fallback to the floating tag. A red build is the cheap failure here; the
# expensive one is an image nobody can account for.
#
# Usage: scripts/resolve-base-digest.sh <image-ref>
#   scripts/resolve-base-digest.sh node:22-alpine
#     -> node@sha256:3f1b...
#   scripts/resolve-base-digest.sh node@sha256:3f1b...   # already pinned
#     -> node@sha256:3f1b...                             # echoed back, no lookup
#
# Env knobs (for tests and for a flaky registry):
#   PAPERCLIP_BASE_DIGEST_ATTEMPTS         lookup attempts, default 5
#   PAPERCLIP_BASE_DIGEST_BACKOFF_SECONDS  backoff unit, default 2 (sleep n*unit)
#
# NOTE: docker.yml and docker-agent.yml carry their own inline copy of this
# resolve loop. That is deliberate for now — they thread the resolved reference
# into scripts/container-base-tag.sh to derive a content-addressed runtime tag,
# which is extra behaviour this helper does not model. Folding them in is a
# separate change against the repo's two most load-bearing image builds.

set -euo pipefail

ref="${1:-}"
if [ -z "$ref" ]; then
  echo "usage: $0 <image-ref>" >&2
  exit 64
fi

attempts="${PAPERCLIP_BASE_DIGEST_ATTEMPTS:-5}"
backoff="${PAPERCLIP_BASE_DIGEST_BACKOFF_SECONDS:-2}"

# Already immutable: hand it straight back. A caller that pins in its Dockerfile
# and still routes through here should not pay a registry round trip.
if [[ "$ref" == *@sha256:* ]]; then
  printf '%s\n' "$ref"
  exit 0
fi

# Drop the tag without eating a registry port. A ':' only introduces a tag when
# it sits in the FINAL path component, so "host:5000/img" has no tag at all and
# the naive "${ref%:*}" would truncate it to "host".
strip_tag() {
  local full="$1" last prefix
  last="${full##*/}"
  if [[ "$last" != *:* ]]; then
    printf '%s' "$full"
    return 0
  fi
  prefix="${full%/*}"
  if [ "$prefix" = "$full" ]; then
    printf '%s' "${last%:*}"
  else
    printf '%s/%s' "$prefix" "${last%:*}"
  fi
}

digest=""
for attempt in $(seq 1 "$attempts"); do
  if digest="$(docker buildx imagetools inspect "$ref" --format '{{json .Manifest.Digest}}' 2>/dev/null | tr -d '"')" \
    && [ -n "$digest" ]; then
    break
  fi
  digest=""
  echo "Base manifest lookup for ${ref} failed (attempt ${attempt}/${attempts})" >&2
  if [ "$attempt" -lt "$attempts" ]; then
    sleep "$((attempt * backoff))"
  fi
done

if [ -z "$digest" ]; then
  echo "Unable to resolve ${ref} to a digest" >&2
  exit 1
fi

# Shape-check the answer rather than trusting whatever came back on stdout. An
# imagetools that prints a warning, an error object, or a short digest must fail
# closed here — not be concatenated into a reference that then fails at pull
# time with a far less obvious message.
if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Resolved ${ref} to a malformed digest: ${digest}" >&2
  exit 1
fi

printf '%s@%s\n' "$(strip_tag "$ref")" "$digest"
