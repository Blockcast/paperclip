#!/bin/sh
set -eu

# Keep the compiler-cache identity out of other agents' AWS/S3 commands.
export AWS_ACCESS_KEY_ID="${PAPERCLIP_SCCACHE_ACCESS_KEY_ID:?compiler cache access key is missing}"
export AWS_SECRET_ACCESS_KEY="${PAPERCLIP_SCCACHE_SECRET_ACCESS_KEY:?compiler cache secret key is missing}"
export AWS_EC2_METADATA_DISABLED=true
exec /usr/local/bin/sccache "$@"
