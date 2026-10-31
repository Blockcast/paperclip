// NOTE: These types must match what Paperclip's SchemaConfigFields component
// expects. Paperclip's server at GET /api/adapters/:type/config-schema
// calls adapter.getConfigSchema() and the UI reads the JSON — types are only
// used at build time here. The Paperclip types in @paperclipai/adapter-utils
// may lag behind; these locals are the source of truth for this adapter.

import { DEFAULT_CLAUDE_CODE_VERSION } from "./runtime-pin.js";

interface ConfigFieldOption {
  label: string;
  value: string;
  group?: string;
}

type ConfigFieldSchema =
  | { type: "text"; key: string; label: string; hint?: string; default?: unknown; meta?: Record<string, unknown> }
  | { type: "number"; key: string; label: string; hint?: string; default?: unknown; meta?: Record<string, unknown> }
  | { type: "toggle"; key: string; label: string; hint?: string; default?: unknown; meta?: Record<string, unknown> }
  | { type: "select"; key: string; label: string; hint?: string; options: ConfigFieldOption[]; default?: unknown; meta?: Record<string, unknown> }
  | { type: "textarea"; key: string; label: string; hint?: string; default?: unknown; meta?: Record<string, unknown> }
  | { type: "combobox"; key: string; label: string; hint?: string; options?: ConfigFieldOption[]; default?: unknown; meta?: Record<string, unknown> };

interface AdapterConfigSchema {
  fields: ConfigFieldSchema[];
}

export function getConfigSchema(): AdapterConfigSchema {
  // model, effort, instructionsFilePath, timeoutSec, graceSec are provided
  // by the platform UI and must not be duplicated here.
  const fields: ConfigFieldSchema[] = [
    // Core Claude fields
    {
      type: "number",
      key: "maxTurnsPerRun",
      label: "Max Turns Per Run",
      hint: "Maximum number of agentic turns (tool calls) per heartbeat run. 0 means unlimited.",
      default: 1000,
    },
    {
      type: "text",
      key: "agentCommand",
      label: "Agent Launcher",
      hint: "Optional executable used to launch Claude. Set this to the reviewed Caveman/Penstock launcher path; arguments and shell syntax are rejected.",
    },
    {
      type: "text",
      key: "ponytailPluginPath",
      label: "Ponytail Plugin Path",
      hint: "Absolute path to the installed Ponytail plugin directory. The path is passed to Claude with --plugin-dir.",
    },
    {
      type: "select",
      key: "ponytailDefaultMode",
      label: "Ponytail Default Mode",
      hint: "Default Ponytail intensity for this agent. An explicit PONYTAIL_DEFAULT_MODE in env takes precedence.",
      options: [
        { value: "off", label: "Off" },
        { value: "lite", label: "Lite" },
        { value: "full", label: "Full" },
        { value: "ultra", label: "Ultra" },
      ],
    },
    // Kubernetes
    {
      type: "text",
      key: "serviceAccountName",
      label: "Service Account",
      hint: "Service Account name for Job pods. Required — falls back to PAPERCLIP_DEFAULT_SERVICE_ACCOUNT_NAME (an adapter Deployment-level fleet default) when unset, and refuses to launch the run if neither resolves. Never silently falls back to the namespace's `default` ServiceAccount, which has no cluster-scoped read.",
    },
    {
      type: "text",
      key: "namespace",
      label: "Namespace",
      hint: "Kubernetes namespace for Jobs. Defaults to the Deployment namespace.",
    },
    {
      type: "text",
      key: "image",
      label: "Container Image",
      hint: "Override the container image used for Job pods. Defaults to the running Deployment image.",
    },
    {
      type: "select",
      key: "imagePullPolicy",
      label: "Image Pull Policy",
      hint: "Image pull policy for the container image.",
      options: [
        { value: "IfNotPresent", label: "IfNotPresent" },
        { value: "Always", label: "Always" },
        { value: "Never", label: "Never" },
      ],
    },
    {
      type: "text",
      key: "claudeCodeVersion",
      label: "Claude Code Version",
      hint: `Exact @anthropic-ai/claude-code version the Job installs once onto the shared data PVC and runs instead of the image's bundled CLI (default ${DEFAULT_CLAUDE_CODE_VERSION}). Set to "image" to run the CLI bundled in the container image. New Claude models require a minimum CLI version; the image's copy only changes on an image rebuild.`,
      default: DEFAULT_CLAUDE_CODE_VERSION,
    },
    {
      type: "text",
      key: "kubeconfig",
      label: "Kubeconfig Path",
      hint: "Absolute path to a kubeconfig file on disk. Defaults to in-cluster service account auth.",
    },
    {
      type: "number",
      key: "ttlSecondsAfterFinished",
      label: "TTL Seconds After Finished",
      hint: "Auto-cleanup delay for completed Jobs in seconds. Default: 300.",
    },
    {
      type: "toggle",
      key: "retainJobs",
      label: "Retain Jobs",
      hint: "Skip cleanup of completed Jobs for debugging purposes.",
    },
    {
      type: "toggle",
      key: "reattachOrphanedJobs",
      label: "Reattach to Orphaned Jobs",
      hint: "If a prior K8s Job for the same agent/task/session is still running (e.g. Paperclip restarted mid-run), attach to it and stream its output instead of blocking the new run. When false, any non-terminal orphan blocks the new run. Default: on.",
      default: true,
    },
    // Resource Limits
    {
      type: "text",
      key: "resources.requests.cpu",
      label: "CPU Request",
      hint: "CPU request for Job pods (e.g. 100m, 0.5, 1).",
    },
    {
      type: "text",
      key: "resources.requests.memory",
      label: "Memory Request",
      hint: "Memory request for Job pods (e.g. 128Mi, 512Mi, 1Gi). Default '1536Mi'.",
    },
    {
      type: "text",
      key: "resources.limits.cpu",
      label: "CPU Limit",
      hint: "CPU limit for Job pods (e.g. 100m, 0.5, 1).",
    },
    {
      type: "text",
      key: "resources.limits.memory",
      label: "Memory Limit",
      hint: "Memory limit for Job pods (e.g. 2Gi, 4Gi, 8Gi). Under about 1.5Gi, half the limit is too small for node, so the tool child memory cap below is raised to its 768 MiB floor.",
    },
    {
      type: "number",
      key: "resources.limits.toolMemoryKb",
      label: "Tool Child Memory Cap (KiB)",
      hint: "RLIMIT_DATA ceiling (ulimit -d, KiB) applied to every bash or zsh the agent spawns — Bash tool commands and their children — and inherited by their descendants, including plain `sh`. Not applied to the claude process itself, nor to a bare `sh -c` launched outside a tool shell (POSIX sh reads neither BASH_ENV nor ZDOTDIR). A runaway child then fails alone with ENOMEM instead of the cgroup OOM-killing the whole run (BLO-34477). Default: half of Memory Limit, raised to at least 786432 (768 MiB) because node cannot start below about 576 MiB; an explicit value is used as given. 0 disables.",
    },
    // Scheduling
    {
      type: "textarea",
      key: "nodeSelector",
      label: "Node Selector",
      hint: "Node selector for Job pods. One key=value per line (e.g. disktype=ssd).",
    },
    {
      type: "textarea",
      key: "tolerations",
      label: "Tolerations",
      hint: "Tolerations for Job pods as JSON array.",
    },
    {
      type: "textarea",
      key: "labels",
      label: "Labels",
      hint: "Extra labels added to Job metadata. One key=value per line.",
    },
    // Docker-in-Docker sidecar — opt-in. When enabled, a docker:dind
    // sidecar runs alongside the agent container and exposes
    // /var/run/dind/docker.sock to it (NOT /var/run/docker.sock: mounting the
    // shared emptyDir over /var/run hid every sibling mount, BLO-40401). Required for `docker build`,
    // `kind create cluster`, and similar tooling. Pod becomes privileged.
    {
      type: "toggle",
      key: "enableDocker",
      label: "Enable Docker (DinD sidecar)",
      default: false,
      hint: "Add a docker:dind sidecar that exposes /var/run/dind/docker.sock to the agent (read DOCKER_HOST, not the legacy path). Required for `docker build` and `kind create cluster`. Pod becomes privileged.",
    },
    {
      type: "text",
      key: "dockerImage",
      label: "DinD Image",
      hint: "Container image for the DinD sidecar (default docker:28-dind). Only used when Enable Docker is on.",
    },
    {
      type: "text",
      key: "dockerCpuLimit",
      label: "DinD CPU Limit",
      hint: "CPU limit for the DinD sidecar (default '4'). e.g. '4', '4000m'.",
    },
    {
      type: "text",
      key: "dockerMemoryLimit",
      label: "DinD Memory Limit",
      hint: "Memory limit for the DinD sidecar (default '8Gi'). e.g. '4Gi', '8Gi'.",
    },
    // PEN-3183 D1 rollout gate (PEN-4933). Surfaced here so the state of a
    // credential boundary is legible to a reviewer looking at the agent,
    // rather than only to whoever reads the database (PEN-5017).
    //
    // ⚠ This field is a VIEW, not the enforcement point. The key is pinned to
    // agent provenance by AGENT_SCOPE_ONLY_CONFIG_KEYS in the Paperclip
    // server's heartbeat merge; a per-issue `assigneeAdapterOverrides`
    // carrying it is discarded and logged, not honoured. Do not read the
    // presence of this toggle as the thing that makes that true.
    {
      type: "toggle",
      key: "enableGitHubPublishBroker",
      label: "GitHub publish broker (PEN-3183 D1)",
      default: false,
      hint:
        "Move the GitHub push credential out of the agent container into a sidecar at a different uid. "
        + "With it off the credential is mounted into the agent container (the accepted PEN-3183 \u00a77 residual). "
        + "With it on the agent cannot authenticate to github.com directly at all, which changes every publish path "
        + "for this agent. Agent scope only \u2014 a per-issue override of this key is ignored. "
        + "While it is on, `enableDocker` and `dockerImage` are pinned to agent scope too, and the two cannot "
        + "both be on: a privileged DinD sidecar in the same pod defeats the broker's uid boundary, so the Job "
        + "REFUSES TO RENDER rather than report a boundary that is not there (PEN-3183 \u00a77.6). "
        + "This is a rollout gate, not a kill switch: switching it back off after enablement re-opens the \u00a77 "
        + "acceptance and needs Security.",
    },
    // PEN-4932 stage 4b / PEN-5120. Deliberately withheld when the swap landed:
    // until the pod log had a transport that does not assume a shared volume,
    // this toggle was a switch that emptied every opted-in run's stdout, and an
    // operator-visible switch for a path that fails every run is a trap.
    //
    // Surfaced now that PEN-5120's collector exists, because the remaining
    // acceptance — a real run on a foreign claim producing parseable stdout —
    // is not reachable without a way to opt one agent in. The hint says plainly
    // that nothing has yet proven it in production; do not soften that wording
    // before a run has.
    {
      type: "toggle",
      key: "enablePerAgentWorkspaceVolume",
      label: "Per-agent workspace volume (PEN-4932)",
      default: false,
      hint:
        "Give this agent its own PersistentVolumeClaim instead of the shared CephFS RWX claim every agent "
        + "pod mounts today. The shared claim is why one hung NodeUnstageVolume bricks every agent pod on a "
        + "node (PEN-3199: three wedges in 30h, one of them 30h26m).\n\n"
        + "\u26a0 NOT YET PROVEN IN PRODUCTION. The code path is complete \u2014 the Job mounts the agent's own "
        + "claim, the prompt bundle is delivered by Secret, the writable dirs are seeded from inside the pod, "
        + "and the run transcript is collected from the container log rather than from a file the server "
        + "cannot read \u2014 but no agent has completed a run on it. Turn it on for ONE agent first and read "
        + "that run's output before turning it on for a second.\n\n"
        + "Per-agent opt-in, not fleet-wide: the agent's existing workspace tree stays on the shared claim and "
        + "is not visible from the new one, so the first run after enabling starts from an empty workspace. "
        + "Turning it back off restores the old tree; it does not migrate anything either way.\n\n"
        + "Known residual while on: `orphaned-run-terminal-result.ts` cannot recover a vanished Job's verdict "
        + "for this agent, because that recovery reads an artifact on the agent's own volume (PEN-2421). It "
        + "only fires when the adapter owner dies mid-run.",
    },
  ];

  return { fields };
}
