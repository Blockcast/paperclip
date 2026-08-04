#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

sha256_digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$@"
  else
    echo "sha256sum or shasum is required" >&2
    return 69
  fi
}

case "${1:-}" in
  runtime)
    runtime_base_image="${2:-harbor.blockcast.net/paperclip/node:lts-trixie-slim}"
    digest="$({
      printf 'paperclip-container-base-tag-v1\n'
      printf 'label=runtime\n'
      printf 'runtime-base-image=%s\n' "$runtime_base_image"
      for file in \
        Dockerfile.runtime \
        scripts/gh-token-wrapper.sh \
        scripts/docker-entrypoint.sh \
        scripts/paperclip-consult-codex.sh; do
        printf 'file=%s\n' "$file"
        sha256_digest "$file"
      done
    } | sha256_digest | cut -c1-20)"
    printf 'runtime-%s\n' "$digest"
    ;;
  agent-toolchain)
    runtime_image="${2:-}"
    ffmpeg_image="${3:-registry.blockcast.net/blockcast/pim-multicast-gateway/ffmpeg-publisher:stable}"
    if [ -z "$runtime_image" ]; then
      echo "usage: $0 agent-toolchain <runtime-image> [ffmpeg-image]" >&2
      exit 64
    fi
    digest="$({
      printf 'paperclip-container-base-tag-v1\n'
      printf 'label=agent-toolchain\n'
      printf 'runtime-image=%s\n' "$runtime_image"
      printf 'ffmpeg-image=%s\n' "$ffmpeg_image"
      for file in \
        Dockerfile.agent-toolchain \
        scripts/smoke/agent-browser-screenshot.sh; do
        printf 'file=%s\n' "$file"
        sha256_digest "$file"
      done
    } | sha256_digest | cut -c1-20)"
    printf 'toolchain-%s\n' "$digest"
    ;;
  *)
    echo "usage: $0 {runtime [base-image]|agent-toolchain <runtime-image> [ffmpeg-image]}" >&2
    exit 64
    ;;
esac
