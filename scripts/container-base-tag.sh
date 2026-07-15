#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

hash_inputs() {
  local label="$1"
  shift

  {
    printf 'paperclip-container-base-tag-v1\n'
    printf 'label=%s\n' "$label"
    while [ "$#" -gt 0 ]; do
      printf 'file=%s\n' "$1"
      sha256sum "$1"
      shift
    done
  } | sha256sum | cut -c1-20
}

case "${1:-}" in
  runtime)
    digest="$(hash_inputs runtime \
      Dockerfile.runtime \
      scripts/gh-token-wrapper.sh \
      scripts/docker-entrypoint.sh \
      scripts/paperclip-consult-codex.sh)"
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
      printf 'file=Dockerfile.agent-toolchain\n'
      sha256sum Dockerfile.agent-toolchain
    } | sha256sum | cut -c1-20)"
    printf 'toolchain-%s\n' "$digest"
    ;;
  *)
    echo "usage: $0 {runtime|agent-toolchain <runtime-image> [ffmpeg-image]}" >&2
    exit 64
    ;;
esac
