#!/bin/bash -ex
export PC_TEST_ROOT="$(mktemp -d /tmp/paperclip-clean.XXXXXX)"
export PC_HOME="$PC_TEST_ROOT/home"
export PC_CACHE="$PC_TEST_ROOT/npm-cache"
export PC_DATA="$PC_TEST_ROOT/paperclip-data"
mkdir -p "$PC_HOME" "$PC_CACHE" "$PC_DATA"
echo "PC_TEST_ROOT: $PC_TEST_ROOT"
echo "PC_HOME: $PC_HOME"
cd $PC_TEST_ROOT
# BLO-43044: blobless. Destination is $PC_TEST_ROOT/repo under `mktemp -d /tmp/...`,
# so this is a /tmp clone even though no `/tmp` literal appears on this line.
# The checkout below fetches only the blobs at HEAD, not every blob in history.
git clone --filter=blob:none https://github.com/paperclipai/paperclip.git repo
cd repo
pnpm install
env HOME="$PC_HOME" npm_config_cache="$PC_CACHE" npm_config_userconfig="$PC_HOME/.npmrc" \
  pnpm paperclipai onboard --yes --data-dir "$PC_DATA"