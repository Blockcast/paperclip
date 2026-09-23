export function truncateText(value: string, maxChars: number, marker = "...", separator = "") {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;

  const available = Math.max(0, maxChars - marker.length - separator.length * 2);
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  const head = trimmed.slice(0, headLength).trimEnd();
  const tail = tailLength > 0 ? trimmed.slice(-tailLength).trimStart() : "";
  return `${head}${separator}${marker}${separator}${tail}`;
}
