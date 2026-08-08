#!/usr/bin/env node
/**
 * check-ffmpeg-muxer.mjs
 * Checks whether a named muxer is present in `ffmpeg -muxers` output.
 * Export: hasMuxer(muxersOutput, muxerName) → boolean
 *
 * BLO-23128: extracted from the inline `grep -qE '(^|[[:space:]])NAME([[:space:]]|$)'`
 * check in docker-agent.yml's ffmpeg-publisher verification step (and mirrors
 * the equivalent assertion in Dockerfile.agent-toolchain) so the matching
 * logic has a unit test instead of living only as an untested shell regex.
 */
import { fileURLToPath } from 'node:url';

export function hasMuxer(muxersOutput, muxerName) {
  const escaped = muxerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|\\s)${escaped}(\\s|$)`, 'm');
  return pattern.test(muxersOutput);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const muxerName = process.argv[2];
  if (!muxerName) {
    console.error('Usage: ffmpeg -hide_banner -muxers | node check-ffmpeg-muxer.mjs <muxer-name>');
    process.exit(2);
  }
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    const muxersOutput = Buffer.concat(chunks).toString('utf8');
    if (hasMuxer(muxersOutput, muxerName)) {
      console.log(`${muxerName} muxer present`);
      process.exit(0);
    }
    console.error(`${muxerName} muxer missing`);
    console.error(muxersOutput);
    process.exit(1);
  });
}
