import { redactCurrentUserText } from "../log-redaction.js";
import { redactSensitiveText } from "../redaction.js";

/**
 * Shared write-time sanitizer for captured command/agent output.
 *
 * PEN-3205: this used to live inside `heartbeat.ts`, which made it unreachable from
 * `workspace-operations.ts` — `heartbeat.ts` already imports that module, so importing
 * back would close a cycle. The workspace-operation write path therefore grew its own
 * weaker transform (`redactCurrentUserText` alone, i.e. username censoring with no
 * secret scrub) and persisted unscrubbed output to both the excerpt columns and the
 * log-store body.
 *
 * Extracting it here rather than re-deriving an equivalent in the second caller is
 * deliberate: two independent sanitizers would be two oracles that can silently drift,
 * and the weaker one would decide what a reviewer believes is covered. `heartbeat.ts`
 * re-exports these so its existing importers and tests keep their current entry points.
 */

export const MAX_PERSISTED_LOG_CHUNK_CHARS = 64 * 1024;

const INLINE_BASE64_IMAGE_DATA_RE =
  /("type":"image","source":\{"type":"base64","data":")([A-Za-z0-9+/=]{1024,})(")/g;

function redactInlineBase64ImageData(chunk: string) {
  return chunk.replace(INLINE_BASE64_IMAGE_DATA_RE, (_match, prefix: string, data: string, suffix: string) =>
    `${prefix}[omitted base64 image data: ${data.length} chars]${suffix}`,
  );
}

export function compactRunLogChunk(chunk: string, maxChars = MAX_PERSISTED_LOG_CHUNK_CHARS) {
  const normalized = redactSensitiveText(redactInlineBase64ImageData(chunk));
  if (normalized.length <= maxChars) return normalized;

  const headChars = Math.max(0, Math.floor(maxChars * 0.6));
  const tailChars = Math.max(0, Math.floor(maxChars * 0.25));
  const omittedChars = Math.max(0, normalized.length - headChars - tailChars);
  const marker = `\n[paperclip truncated run log chunk: omitted ${omittedChars} chars]\n`;
  return `${normalized.slice(0, headChars)}${marker}${normalized.slice(normalized.length - tailChars)}`;
}

export function sanitizeRunLogChunkForStorage(
  chunk: string,
  currentUserRedactionOptions: Parameters<typeof redactCurrentUserText>[1],
  maxChars = MAX_PERSISTED_LOG_CHUNK_CHARS,
) {
  return compactRunLogChunk(redactCurrentUserText(chunk, currentUserRedactionOptions), maxChars);
}
