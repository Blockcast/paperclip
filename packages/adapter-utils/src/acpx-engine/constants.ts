export const DEFAULT_ACP_ENGINE_AGENT = "claude";
export const DEFAULT_ACP_ENGINE_MODE = "persistent";
export const DEFAULT_ACP_ENGINE_PERMISSION_MODE = "approve-all";
export const DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS = "deny";
export const DEFAULT_ACP_ENGINE_TIMEOUT_SEC = 0;
export const DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS = 0;

// Session establishment (agent spawn + session/new|session/load) is awaited
// with no wall-clock bound: adapterConfig.timeoutSec only arms a timer around
// the turn, which starts after the handle exists. A stalled handshake
// therefore froze the run log at its pre-exec lines -- observed at 90.56min,
// 16.5h+, and 43.20h, the last of which still completed successfully. These
// intervals emit periodic elapsed-time progress so a stalled handshake is
// visible while it is happening instead of only in hindsight. Backing off to a
// 5-minute ceiling keeps a multi-hour stall to a few hundred log lines.
export const ACP_ENGINE_SESSION_PROGRESS_FIRST_DELAY_MS = 30_000;
export const ACP_ENGINE_SESSION_PROGRESS_MAX_DELAY_MS = 300_000;

export const ACPX_ADAPTER_AGENT_IDS = {
  claude_local: "claude",
  codex_local: "codex",
  gemini_local: "gemini",
  custom_acp: "custom",
} as const;

export type AcpxAdapterType = keyof typeof ACPX_ADAPTER_AGENT_IDS;
export type AcpxAgentId = (typeof ACPX_ADAPTER_AGENT_IDS)[AcpxAdapterType];

export function acpxAgentIdForAdapterType(adapterType: string | null | undefined): AcpxAgentId | null {
  if (!adapterType) return null;
  return ACPX_ADAPTER_AGENT_IDS[adapterType as AcpxAdapterType] ?? null;
}
