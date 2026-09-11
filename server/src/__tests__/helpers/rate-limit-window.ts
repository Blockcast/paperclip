// Tool-policy rate limits use a FIXED window floored to the wall clock
// (`windowStart()` in server/src/services/tool-access-policy.ts), not a sliding
// window off first use, and the counter row is keyed on `windowStartAt`. So a
// test that fires two calls expecting the second to be limited fails whenever
// the pair straddles a boundary: the calls land in two different counters and
// neither reaches the limit. Wait out the tail of the window before starting
// such a pair. Tracked under BLO-33257.
export async function awaitRateLimitWindow(windowMs = 60_000, marginMs = 5_000): Promise<void> {
  const into = Date.now() % windowMs;
  if (into > windowMs - marginMs) {
    await new Promise((resolve) => setTimeout(resolve, windowMs - into + 50));
  }
}
