import { describe, it, expect } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildJobManifest, POD_LOG_STREAM_MARKER } from "./job-manifest.js";
import { extractContainerLogDiagnostic } from "./execute.js";
import { POD_LOG_UNREDACTED_SUFFIX, buildPodLogRedactorSetupShell } from "./pod-log-redactor.js";
import type { SelfPodInfo } from "./k8s-client.js";

// PEN-5120 — the pod log crosses the agent volume in the READ direction.
//
// `buildPodLogPath` returns TWO absolute addresses for ONE file, on the stated
// premise that the server and the pod mount the SAME volume at different roots.
// PEN-4932's per-agent claim removes that premise, and the direction nothing
// covered is this one: the pod WRITES the transcript and the server READS it
// (`tailPodLogFile`, and that tail is the run's entire stdout). The four
// invariants PEN-4932 closed were derived from the subPath mount inventory and
// from what the server writes, so none of them could reach it.
//
// The remedy is that the container also writes the transcript to its own
// stdout, where the Kubernetes log API can serve it without any shared volume.
// What this suite pins is the part that is NOT visible from either the awk
// program or the redactor fragment alone:
//
//   * that today's fleet command is BYTE-IDENTICAL, because the whole change is
//     gated on a claim no agent resolves to yet;
//   * that the marked copy is downstream of `tee`, so the FILE keeps its bytes
//     and every existing parser of it is untouched;
//   * that the redactor's fail-OPEN becomes a fail-CLOSED on exactly that path,
//     because "degrade to today's behaviour" is not available when the degraded
//     stream would be published to the node's container log.

const selfPod: SelfPodInfo = {
  namespace: "paperclip",
  image: "paperclipai/paperclip:latest",
  imagePullSecrets: [],
  dnsConfig: undefined,
  nodeSelector: {},
  tolerations: [],
  pvcClaimName: "paperclip-data",
  secretVolumes: [],
  inheritedEnv: {},
  inheritedEnvValueFrom: [],
  inheritedEnvFrom: [],
};

function makeCtx(workspaceVolumeClaim?: string): AdapterExecutionContext {
  return {
    runId: "run-abc12345",
    agent: { id: "agent-abc", companyId: "co1", name: "Test Agent", adapterType: "claude_k8s", adapterConfig: {} },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
      isolation: {
        isolationMode: "workspace",
        isolationKey: "workspace:ws-1",
        workspaceRoot: "/paperclip/instances/default/projects/co1/proj-1/_default",
        homeRoot: "/paperclip/instances/default/data/k8s-isolation/workspaces/ws-1/home",
        sessionRoot: "/paperclip/instances/default/data/k8s-isolation/workspaces/ws-1/session",
        cacheRoot: "/runtime-cache/paperclip-workspaces/ws-1/cache",
        tmpRoot: "/runtime-cache/paperclip-workspaces/ws-1/tmp",
        storage: { workspace: "persistent", home: "persistent", session: "persistent", cache: "ephemeral" },
      } as unknown as NonNullable<AdapterExecutionContext["runtime"]["isolation"]>,
    },
    config: {
      serviceAccountName: "test-sa",
      ...(workspaceVolumeClaim ? { workspaceVolumeClaim } : {}),
    },
    context: {},
    onLog: async () => {},
  };
}

/** The agent container's command string — `["sh", "-c", <script>]`. */
function agentCommand(claim?: string): string {
  const built = buildJobManifest({ ctx: makeCtx(claim), selfPod });
  return built.job.spec?.template?.spec?.containers?.[0]?.command?.[2] ?? "";
}

/** The unmarked `print` the fail-fast awk has always opened with. */
const UNMARKED_PRINT = "awk '{ print; fflush() }";
const MARKED_PRINT = `awk '{ print "${POD_LOG_STREAM_MARKER}" $0; fflush() }`;

describe("pod log stream framing (PEN-5120)", () => {
  it("leaves today's fleet command byte-identical on the server's own claim", () => {
    // The inertness property, and the reason this can land before PEN-4932's
    // gate is enabled for anyone. Asserted as the literal pipeline tail rather
    // than as "does not contain the marker": the marker could be absent while
    // the sink was still dropped, which is the mutation that would put a 10 Mi
    // transcript into every node's container log on every run in the fleet.
    const command = agentCommand();
    expect(command).toContain(UNMARKED_PRINT);
    expect(command).not.toContain(POD_LOG_STREAM_MARKER);
    expect(command.endsWith(" > /dev/null")).toBe(true);
  });

  it("marks each transcript line and keeps the filter's stdout on a foreign claim", () => {
    const command = agentCommand("agent-workspace-abc");
    expect(command).toContain(MARKED_PRINT);
    expect(command).not.toContain(UNMARKED_PRINT);
    // The sink is gone — that discard is what the whole remedy removes.
    expect(command.endsWith(" > /dev/null")).toBe(false);
  });

  it("streams on an emptyDir Job too, which is the one branch reachable without the 4b swap", () => {
    // `dataClaimName === ""` — a deployment whose server has no PVC at all.
    // `serverHoldsJobDataClaim` reports false for it, so this takes the stream
    // path. That is a fix rather than a widening, and it is the same call the
    // prompt-bundle Secret channel already makes for the same branch: such a pod
    // writes its log to an emptyDir the server cannot read either, so the tail
    // is already collecting nothing today.
    const built = buildJobManifest({ ctx: makeCtx(), selfPod: { ...selfPod, pvcClaimName: null } });
    const command = built.job.spec?.template?.spec?.containers?.[0]?.command?.[2] ?? "";
    expect(command).toContain(MARKED_PRINT);
    expect(command.endsWith(" > /dev/null")).toBe(false);
  });

  it("marks the stdout copy only — the file keeps today's bytes", () => {
    // `tee` is UPSTREAM of the awk, so the marker cannot reach the file. This
    // is what keeps `orphaned-run-terminal-result.ts` and the belt-and-braces
    // re-read parsing one JSON object per line, and it is the reason the marker
    // is a prefix added by the filter rather than by the redactor.
    const command = agentCommand("agent-workspace-abc");
    const tee = command.indexOf("| tee ");
    const marker = command.indexOf(POD_LOG_STREAM_MARKER);
    expect(tee).toBeGreaterThan(-1);
    expect(marker).toBeGreaterThan(tee);
    // Nothing between the tee and its pipe carries the marker.
    expect(command.slice(tee, command.indexOf("|", tee + 1))).not.toContain(POD_LOG_STREAM_MARKER);
  });

  it("never marks the wrapper's own stderr diagnostic", () => {
    // The terminal rate-limit line goes to `/dev/stderr` and is a message ABOUT
    // the run, not a line OF it. Marking it would feed `[wrapper] terminal
    // rate-limit: …` to the stream-json parser as a transcript line.
    for (const claim of [undefined, "agent-workspace-abc"]) {
      const command = agentCommand(claim);
      const diagnostic = command.indexOf('print "[wrapper] terminal rate-limit');
      expect(diagnostic).toBeGreaterThan(-1);
      expect(command.slice(diagnostic, diagnostic + 40)).not.toContain(POD_LOG_STREAM_MARKER);
    }
  });

  it("keeps the redactor failing OPEN on the server's own claim", () => {
    // Unchanged for the fleet: a degraded filter writes unredacted bytes to a
    // file on a volume the control plane already owns, which is strictly better
    // than failing every run.
    const command = agentCommand();
    expect(command).toContain("pod log is UNREDACTED");
    expect(command).toContain(POD_LOG_UNREDACTED_SUFFIX);
    expect(command).not.toContain("refusing to emit an UNREDACTED transcript");
  });

  it("makes the redactor fail CLOSED on a foreign claim", () => {
    // Where the stream IS the delivery channel, falling open does not degrade
    // to today's behaviour — it publishes the transcript to the node's
    // container log, somewhere it has never been. The forensic record is
    // unchanged: the original stderr line and the `.unredacted` sentinel are
    // both still written, and only then does the run fail.
    const command = agentCommand("agent-workspace-abc");
    const announce = command.indexOf("pod log is UNREDACTED");
    const sentinel = command.indexOf(POD_LOG_UNREDACTED_SUFFIX);
    const refuse = command.indexOf("refusing to emit an UNREDACTED transcript");
    expect(announce).toBeGreaterThan(-1);
    expect(sentinel).toBeGreaterThan(announce);
    expect(refuse).toBeGreaterThan(sentinel);
    expect(command.slice(refuse)).toContain("exit 1;");
  });

  it("carries no single quote that would break the fragment's shell quoting", () => {
    // The refusal message is interpolated INTO a single-quoted `echo`, so one
    // apostrophe in it ends the string and the rest of the line is re-parsed as
    // shell. It would be syntactically valid and would silently mangle the
    // branch, on a path that only runs when something else has already failed.
    const command = agentCommand("agent-workspace-abc");
    const refuse = command.indexOf("refusing to emit an UNREDACTED transcript");
    const close = command.indexOf("'", refuse);
    expect(close).toBeGreaterThan(refuse);
    expect(command.slice(refuse, close)).not.toContain("'");
    // Balance the FRAGMENT this suite owns, not the whole rendered command.
    // Whole-command parity is NOT an invariant of a valid command: POSIX
    // single-quote escaping renders an apostrophe as `'\''`, so a quoted
    // argument containing one contributes an ODD number of quote characters
    // (2 + 3k) while staying perfectly well-formed. The first `quoteShellArg`
    // output with an apostrophe anywhere in this fixture would therefore have
    // failed the global check on correct code. The local assertion above is
    // what actually guards the defect; this one keeps the balance claim where
    // it holds. The path below carries no apostrophe, so the fragment's own
    // sentinel escaping cannot flip it either.
    const fragment = buildPodLogRedactorSetupShell("/paperclip/run-abc.pod.ndjson", {
      failClosedOnFallOpen: true,
    });
    expect(fragment).toContain("refusing to emit an UNREDACTED transcript");
    expect(fragment.split("'").length % 2).toBe(1);
  });
});

describe("container-log diagnostic vs. the marked transcript (PEN-5120)", () => {
  it("drops marked transcript lines so the real error survives the last-five cut", () => {
    // `readPodContainerLogTail` takes the last 120 lines and keeps 5. On a
    // foreign claim those last lines are now the transcript, which is long and
    // which pushes the actual failure out of the window — so the diagnostic
    // would report the run's output instead of its error, exactly when the
    // caller needs the error.
    const raw = [
      "[paperclip] launcher preflight ok",
      "Error: claude exited with code 137 (OOMKilled)",
      ...Array.from({ length: 10 }, (_, i) => `${POD_LOG_STREAM_MARKER}{"type":"assistant","i":${i}}`),
    ].join("\n");
    const diagnostic = extractContainerLogDiagnostic(raw);
    expect(diagnostic).toContain("OOMKilled");
    expect(diagnostic).not.toContain(POD_LOG_STREAM_MARKER);
    expect(diagnostic).not.toContain('"type":"assistant"');
  });

  it("is unchanged for a container log that carries no marked lines", () => {
    // The negative control for the filter itself: today's fleet emits no marked
    // line at all, so this predicate must be a no-op there.
    const raw = ["one", "", "  two  ", "three"].join("\n");
    expect(extractContainerLogDiagnostic(raw)).toBe("one | two | three");
  });
});

describe("podLogStreamedToContainerStdout (PEN-5120 collector hand-off)", () => {
  // The collector in `execute.ts` chooses its transport from this flag. It is
  // returned by the builder rather than re-derived by the caller precisely so
  // that a drift between "what the pod command does" and "what the server reads"
  // is impossible — these two tests are that guarantee, not decoration.
  it("is false on the server's own claim, where the file tail still applies", () => {
    const built = buildJobManifest({ ctx: makeCtx(), selfPod });
    expect(built.podLogStreamedToContainerStdout).toBe(false);
  });

  it("is true on a claim the server does not hold", () => {
    const built = buildJobManifest({ ctx: makeCtx("agent-workspace-abc"), selfPod });
    expect(built.podLogStreamedToContainerStdout).toBe(true);
  });

  it("agrees with the command it shipped, on both claims", () => {
    // The drift guard stated as one assertion: the flag is true exactly when the
    // command carries the marker. A change that marked the fleet's command but
    // left the flag false would leave the server tailing a file nobody writes;
    // the reverse would have it stream from a container log carrying no frames.
    for (const claim of [undefined, "agent-workspace-abc"]) {
      const built = buildJobManifest({ ctx: makeCtx(claim), selfPod });
      const command = built.job.spec?.template?.spec?.containers?.[0]?.command?.[2] ?? "";
      expect(built.podLogStreamedToContainerStdout).toBe(command.includes(POD_LOG_STREAM_MARKER));
    }
  });
});
