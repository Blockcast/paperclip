#!/bin/sh
set -eu

# These names survive the scheduler's reserved PAPERCLIP_* filter.
if [ -z "${SCCACHE_ACCESS_KEY_ID:-}" ] || [ -z "${SCCACHE_SECRET_ACCESS_KEY:-}" ]; then
  exec "$@"
fi
# Keep the compiler-cache identity out of other agents' AWS/S3 commands.
export AWS_ACCESS_KEY_ID="$SCCACHE_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$SCCACHE_SECRET_ACCESS_KEY"
export AWS_EC2_METADATA_DISABLED=true
exec /usr/local/bin/sccache "$@"
