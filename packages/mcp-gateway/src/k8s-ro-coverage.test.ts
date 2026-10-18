import { describe, expect, it } from "vitest";
import { scrubResponseBody } from "./response-scrub.js";

/**
 * PEN-4282: what the k8s-ro scrubber covers, as an executable register.
 *
 * ## The gap this closes
 *
 * PEN-2429 put `scrubResponseBody` on the `/k8s-ro` path; PEN-2704 closed the
 * direct-dial route around it. Both are about **reaching** the scrubber.
 * `docs/AGENT-VISIBLE-CONFIG-EGRESS.md` §1 then enumerated **what it scrubs
 * once reached** — but as a prose table, verified by reading the code to its
 * call site. A prose table cannot fail, and the verdicts in it are exactly the
 * kind of claim that rots: every one of them is a statement about the
 * behaviour of a 1600-line scanner that is still being extended.
 *
 * This file makes each verdict a test. Every surface the `k8s-ro` seat can
 * return is pushed through the real `scrubResponseBody` carrying a sentinel,
 * and the register declares which way it must come out. A change to the
 * scrubber that silently widens or narrows coverage turns a documented verdict
 * red instead of making the documentation wrong.
 *
 * ## Why every entry is two-sided
 *
 * Each surface declares BOTH `mustNotSurvive` and `mustSurvive`, and
 * `mustSurvive` may not be empty. An all-redacted response would otherwise
 * score as "covered" while having simply broken the surface — the scrubber
 * fails closed by design (`response-scrub.ts` constraint 4: it drops whole
 * indented blocks rather than guess), so "the sentinel is gone" is satisfied
 * just as well by a scanner that ate the document. The surviving control value
 * is what distinguishes redaction from destruction.
 *
 * Pass-through entries are two-sided in the same way and for a sharper reason:
 * `mustSurvive` there asserts that material really does reach the agent in the
 * clear. That is not a bug report, it is the recorded decision (see BOUNDARY
 * below) — and pinning it means a future change that starts scrubbing logs or
 * ConfigMap `data` fails here and forces the register and the doc to be updated
 * with it, rather than leaving both describing a world that moved.
 *
 * ## BOUNDARY — the decision this register records (PEN-4282, box 2)
 *
 * **The k8s-ro scrubber is transcript hygiene for the structured pod-spec
 * shapes. It is NOT a credential boundary.** The boundary on what an agent seat
 * can reach is RBAC — `ClusterRole/paperclip-k8s-mcp-readonly` — not this
 * scrubber.
 *
 * It follows, and this is the operative sentence, that **"redacted to me" does
 * NOT mean "unreachable by any agent".** The same string is redacted as
 * `env[].value` and returned in full as `ConfigMap.data`, in a pod log, or in
 * an event message. On PEN-4274 two seats independently read a redacted
 * `TO_URL` as evidence that a question was unanswerable by any agent; it was
 * answerable in minutes through a ConfigMap and a pod log. The inversion ran
 * both ways — a reviewer trusting redaction to bound what agents can see is
 * wrong by the same measurement.
 *
 * Option (a) — make it a credential boundary — was considered and declined.
 * Extending to ConfigMap `data` costs the diagnostic outright: unlike `env` and
 * argv there is no structural gate separating the credential case from the
 * legitimate one, so the only available rule redacts every ConfigMap read (the
 * rationale already recorded at `response-scrub.ts`, constraint 5's closing
 * note). A text scrubber over log output is a separate design with its own
 * false-positive cost and is not smuggled in here.
 *
 * ## ⚠️ What a green run here does NOT mean — read before citing this file
 *
 * `K8S_RO_TOOLS` is hand-maintained, and no test in THIS repo can derive it.
 * The tool surface is set by the upstream server image
 * (`ghcr.io/containers/kubernetes-mcp-server@sha256:…`), its `--read-only
 * --disable-destructive` flags and the `disabled_tools` list in
 * `kubernetes-mcp-server-config` — all of which live in
 * `Blockcast/onprem-k8s:paperclip/k8s-mcp-stack.yaml`. The `k8s-ro` gateway
 * upstream map carries NO `tools` allowlist (unlike the prometheus gateway,
 * whose five-tool allowlist is what actually closed PEN-2735), so every tool
 * that image serves is exposed.
 *
 * So an upstream image bump can add a tool, route it through `/k8s-ro`, and
 * leave this suite green. That half is tracked on PEN-4295 and is named here
 * rather than left implicit, exactly as the sibling register
 * (`server/src/__tests__/mcp-seed-scrub-coverage.test.ts`) names its own
 * un-derivable oracle. What this file DOES enforce is that the two in-repo
 * records cannot drift: `scripts/__tests__/k8s-ro-coverage-doc-sync.test.mjs` asserts
 * `K8S_RO_TOOLS` below equals the tool list in the doc's table, so neither can be
 * updated without the other.
 *
 * That assertion deliberately lives in the always-on `policy` lane rather than
 * in this file. Reading `docs/…` from a vitest suite makes a prose-only edit
 * *select* that suite, which breaks the repo's "a prose-only diff skips every
 * suite" invariant (`scripts/__tests__/select-ci-suites.test.mjs`) — a real
 * CI-cost property, not a technicality. A cross-artifact string comparison is
 * cheap and belongs where it runs unconditionally; the behavioural assertions
 * below are what need the suite.
 */

const SENTINEL = "PEN4282_SENTINEL_MUST_NOT_REACH_AN_AGENT";
const REDACTED = "<redacted>";

/**
 * Every tool the `k8s-ro` seat exposes, as of the measurement below.
 *
 * Measured live 2026-10-18 against gateway image
 * `sha-860c6c6@sha256:81016633…` — the reference pinned in
 * `onprem-k8s:paperclip/k8s-mcp-gateway-k8s-ro.yaml` and confirmed running on
 * `Deployment/paperclip-mcp-gateway-k8s-ro`. Every call below was confirmed to
 * have traversed the gateway by its own access log, which logs
 * `{"event":"mcp_gateway_request","prefix":"k8s-ro","tool":"…"}` per request —
 * so the unredacted results are a coverage gap in a control that ran, not a
 * request that went around it.
 *
 * If you are here because this list disagrees with the doc table, add the tool
 * to BOTH, and give it a surface below. Do not delete the assertion.
 */
const K8S_RO_TOOLS: readonly string[] = [
  "events_list",
  "namespaces_list",
  "nodes_log",
  "nodes_stats_summary",
  "nodes_top",
  "pods_get",
  "pods_list",
  "pods_list_in_namespace",
  "pods_log",
  "pods_top",
  "resources_get",
  "resources_list",
];

type Verdict =
  /** `scrubResponseBody` removes credential material from this surface. */
  | { kind: "scrubbed"; why: string }
  /**
   * This surface reaches the agent unchanged, BY DECISION. `why` states the
   * decision; `risk` states what an agent can therefore read, in plain terms,
   * so no reader has to infer the residual from the absence of a rule.
   */
  | { kind: "passthrough"; why: string; risk: string };

interface Surface {
  /** Stable id, used in failure messages. */
  readonly id: string;
  /** The k8s-ro tools that can return this surface. */
  readonly tools: readonly string[];
  readonly verdict: Verdict;
  /** A response body in this surface's real wire shape, carrying `SENTINEL`. */
  readonly body: string;
  /** Substrings that must be ABSENT from the scrubbed body. */
  readonly mustNotSurvive: readonly string[];
  /**
   * Substrings that must still be PRESENT. Never empty — see the two-sided note
   * in the file docblock.
   */
  readonly mustSurvive: readonly string[];
}

/** The k8s MCP server returns resources as YAML text inside a content block. */
function contentBlock(text: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text }] },
  });
}

const SURFACES: readonly Surface[] = [
  {
    id: "pod-spec-literals",
    tools: ["pods_get", "pods_list", "pods_list_in_namespace", "resources_get", "resources_list"],
    verdict: {
      kind: "scrubbed",
      why: "the PEN-2370 instance: env values, argv and exec probe commands inside a container list",
    },
    body: contentBlock(
      [
        "apiVersion: v1",
        "kind: Pod",
        "metadata:",
        "  name: some-other-agent",
        "spec:",
        "  containers:",
        "  - name: agent",
        "    image: harbor.example.net/agent:v1",
        "    command:",
        `    - ${SENTINEL}`,
        "    env:",
        "    - name: OPENAI_API_KEY",
        `      value: ${SENTINEL}`,
        "    - name: LOG_LEVEL",
        `      value: ${SENTINEL}`,
        "    readinessProbe:",
        "      exec:",
        "        command:",
        `        - ${SENTINEL}`,
        "status:",
        "  phase: Running",
      ].join("\n"),
    ),
    mustNotSurvive: [SENTINEL],
    // `image` and `status.phase` are the control: the diagnostic value of the
    // grant must survive the redaction. Measured live on
    // `Deployment/paperclip-mcp-gateway-k8s-ro`, where every `env[].value` came
    // back `<redacted>` while `image`, the probes and the resource block did
    // not.
    mustSurvive: ["harbor.example.net/agent:v1", "OPENAI_API_KEY", "phase: Running", REDACTED],
  },
  {
    id: "secret-material",
    tools: ["resources_get", "resources_list"],
    verdict: {
      kind: "scrubbed",
      why: "a v1 Secret carries its material directly in data/stringData; scrubbing the harder env route while leaving this open would be decoration",
    },
    body: contentBlock(
      [
        "apiVersion: v1",
        "kind: Secret",
        "metadata:",
        "  name: some-credential",
        "type: Opaque",
        "data:",
        `  token: ${SENTINEL}`,
        "stringData:",
        `  password: ${SENTINEL}`,
      ].join("\n"),
    ),
    mustNotSurvive: [SENTINEL],
    // Deliberately NOT measured live: confirming this one against a real Secret
    // would put real material in an agent transcript if the rule had regressed,
    // which is the exposure the whole chain exists to prevent. It is pinned
    // here instead, where the sentinel is ours.
    mustSurvive: ["name: some-credential", "kind: Secret", REDACTED],
  },
  {
    id: "resource-echo-annotation",
    tools: ["pods_get", "pods_list", "pods_list_in_namespace", "resources_get", "resources_list"],
    verdict: {
      kind: "scrubbed",
      why: "kubectl writes the whole applied manifest into last-applied-configuration, so it carries a second copy of every env value in the resource",
    },
    body: contentBlock(
      [
        "apiVersion: v1",
        "kind: ConfigMap",
        "metadata:",
        "  name: some-config",
        "  annotations:",
        `    kubectl.kubernetes.io/last-applied-configuration: '{"env":"${SENTINEL}"}'`,
        "data:",
        "  upstreams.json: |",
        '    {"k8s-ro": "http://example.svc.cluster.local:8080/mcp"}',
      ].join("\n"),
    ),
    mustNotSurvive: [SENTINEL],
    mustSurvive: ["name: some-config", REDACTED],
  },
  {
    id: "configmap-data",
    tools: ["resources_get", "resources_list"],
    verdict: {
      kind: "passthrough",
      why: "declined at `response-scrub.ts` constraint 5: a ConfigMap read is a legitimate diagnostic and has no name/value split to gate on, so the only available rule would redact every ConfigMap read outright",
      risk: "a ConfigMap used to carry a credential is returned to the agent in the clear",
    },
    // Shaped exactly as measured live on
    // `ConfigMap/paperclip-mcp-gateway-k8s-ro-upstreams`, which returned
    // `last-applied-configuration: "<redacted>"` and its `data` in full
    // plaintext in the SAME response. That object is this surface's in-body
    // positive control: the scrubber demonstrably ran on the body that carried
    // the plaintext.
    body: contentBlock(
      [
        "apiVersion: v1",
        "kind: ConfigMap",
        "metadata:",
        "  name: some-config",
        "  annotations:",
        "    kubectl.kubernetes.io/last-applied-configuration: '{\"redact\":\"me\"}'",
        "data:",
        `  credential.txt: ${SENTINEL}`,
      ].join("\n"),
    ),
    mustNotSurvive: ['{"redact":"me"}'],
    mustSurvive: [SENTINEL, REDACTED],
  },
  {
    id: "crd-with-pod-spec",
    tools: ["resources_get", "resources_list"],
    verdict: {
      kind: "scrubbed",
      why: "coverage is keyed on the response SHAPE, not on the kind, so a CRD that embeds a pod template is reached by the same rules as a core Pod",
    },
    // Measured live on `AutoscalingRunnerSet/arc-light`
    // (actions.github.com/v1alpha1): `spec.template.spec.containers[].env[]`,
    // `command` and `lifecycle.postStart.exec.command` all returned
    // `<redacted>` on a non-core kind.
    body: contentBlock(
      [
        "apiVersion: example.com/v1alpha1",
        "kind: SomeRunnerSet",
        "metadata:",
        "  name: runners",
        "spec:",
        "  template:",
        "    spec:",
        "      containers:",
        "      - name: runner",
        "        image: harbor.example.net/runner:v1",
        "        env:",
        "        - name: RUNNER_TOKEN",
        `          value: ${SENTINEL}`,
      ].join("\n"),
    ),
    mustNotSurvive: [SENTINEL],
    mustSurvive: ["harbor.example.net/runner:v1", "RUNNER_TOKEN", REDACTED],
  },
  {
    id: "crd-without-pod-spec",
    tools: ["resources_get", "resources_list"],
    verdict: {
      kind: "passthrough",
      why: "the corollary of the shape-keyed rule: a CRD whose config sits under its own key names carries none of the probe shapes, so no rule reaches it",
      risk: "arbitrary CRD spec fields — Argo Application sources, policy bodies, operator settings — are returned in the clear",
    },
    // Measured live on `Application/paperclip-mcp-gateways` (argoproj.io): the
    // ONLY field redacted in the whole document was
    // `last-applied-configuration`; all of `spec.source.*` came back plaintext.
    body: contentBlock(
      [
        "apiVersion: example.com/v1alpha1",
        "kind: SomePolicy",
        "metadata:",
        "  name: policy",
        "spec:",
        `  inlineCredential: ${SENTINEL}`,
        "  target: https://example.invalid",
      ].join("\n"),
    ),
    mustNotSurvive: [],
    mustSurvive: [SENTINEL, "target: https://example.invalid"],
  },
  {
    id: "container-log-text",
    tools: ["pods_log"],
    verdict: {
      kind: "passthrough",
      why: "unstructured text: it carries none of the probe shapes, and a text scrubber over log output is a separate design with its own false-positive cost",
      risk: "anything a container prints, including request lines — this estate already tracks a WS upgrade that logs a raw req.url able to carry ?token=<credential>",
    },
    // Measured live on `paperclip-mcp-gateway-k8s-ro-7647d8d5d8-kzfk4`:
    // returned verbatim.
    body: contentBlock(
      [
        `2026-10-18T15:17:00Z GET /ws/upgrade?token=${SENTINEL} 101`,
        "2026-10-18T15:17:01Z client cert auth ok",
      ].join("\n"),
    ),
    mustNotSurvive: [],
    mustSurvive: [SENTINEL, "client cert auth ok"],
  },
  {
    id: "node-log-text",
    tools: ["nodes_log"],
    verdict: {
      kind: "passthrough",
      why: "same class as container logs: unstructured text through the kubelet proxy",
      risk: "kubelet and /var/log content, including anything a node-level process prints",
    },
    body: contentBlock(`Oct 18 15:17:00 node kubelet[1]: started with flag --secret=${SENTINEL}`),
    mustNotSurvive: [],
    mustSurvive: [SENTINEL, "kubelet[1]"],
  },
  {
    id: "event-messages",
    tools: ["events_list"],
    verdict: {
      kind: "passthrough",
      why: "event messages are free-form strings written by controllers; same unstructured-text class",
      risk: "whatever a controller puts in a message — probe failures routinely quote a URL, and pull failures quote a registry reference",
    },
    // Measured live: `events_list` over ns paperclip returned 442,601
    // characters across 9,502 lines with ZERO occurrences of the redaction
    // marker.
    body: contentBlock(
      [
        "- InvolvedObject:",
        "    Kind: Pod",
        `  Message: 'Readiness probe failed: GET https://example.invalid/?key=${SENTINEL}'`,
        "  Type: Warning",
      ].join("\n"),
    ),
    mustNotSurvive: [],
    mustSurvive: [SENTINEL, "Type: Warning"],
  },
  {
    id: "numeric-metrics",
    tools: ["nodes_top", "pods_top", "nodes_stats_summary"],
    verdict: {
      kind: "passthrough",
      why: "resource-usage numbers and object names; no config or credential payload is carried on this surface",
      risk: "object names and namespaces, which the list tools already return",
    },
    body: contentBlock(
      ["NAMESPACE   NAME        CPU(cores)   MEMORY(bytes)", "paperclip   some-pod    12m          48Mi"].join("\n"),
    ),
    mustNotSurvive: [],
    mustSurvive: ["some-pod", "48Mi"],
  },
  {
    id: "namespace-metadata",
    tools: ["namespaces_list"],
    verdict: {
      kind: "passthrough",
      why: "namespace names, phase and labels; no config or credential payload is carried on this surface",
      risk: "namespace names and labels",
    },
    body: contentBlock(
      ["NAME        STATUS   AGE   LABELS", "paperclip   Active   175d  kubernetes.io/metadata.name=paperclip"].join(
        "\n",
      ),
    ),
    mustNotSurvive: [],
    mustSurvive: ["paperclip", "Active"],
  },
];

function scrub(body: string): string {
  return scrubResponseBody(Buffer.from(body, "utf8"), "application/json").toString("utf8");
}

/**
 * The same document delivered as an SSE frame, which is how the streamable-HTTP
 * MCP transport delivers most tool results (`response-scrub.ts`,
 * `transformResponseBody`).
 *
 * Every surface above is asserted over the plain-JSON framing, so without this
 * the register would describe the *less common* transport while reading as
 * coverage of the tool. `transformResponseBody` dispatches to a different
 * function per framing, and each verdict has to hold on both.
 */
function scrubSse(body: string): string {
  const framed = `event: message\ndata: ${body}\n\n`;
  return scrubResponseBody(Buffer.from(framed, "utf8"), "text/event-stream").toString("utf8");
}

describe("k8s-ro scrubber coverage register (PEN-4282)", () => {
  it("classifies every tool the k8s-ro seat exposes", () => {
    const classified = new Set(SURFACES.flatMap((surface) => surface.tools));
    const unclassified = K8S_RO_TOOLS.filter((tool) => !classified.has(tool));
    const unknown = [...classified].filter((tool) => !K8S_RO_TOOLS.includes(tool));

    expect(
      unclassified,
      "every k8s-ro tool needs a surface in SURFACES saying what the scrubber does to its " +
        "output. Pick `scrubbed` or `passthrough` and say why — an unclassified tool is the " +
        "exact state PEN-4282 was filed for.",
    ).toEqual([]);
    expect(unknown, "SURFACES names a tool that is not in K8S_RO_TOOLS").toEqual([]);
  });

  it("declares a surviving control value for every surface", () => {
    // The anti-"broke the surface" rule, enforced structurally rather than left
    // to whoever adds the next entry. See the two-sided note in the docblock.
    for (const surface of SURFACES) {
      expect(surface.mustSurvive.length, `${surface.id} declares no control value`).toBeGreaterThan(0);
    }
  });

  describe.each(SURFACES.map((surface) => [surface.id, surface] as const))("%s", (_id, surface) => {
    const scrubbed = () => scrub(surface.body);

    it(`is ${surface.verdict.kind}: ${surface.verdict.why}`, () => {
      const output = scrubbed();
      for (const needle of surface.mustNotSurvive) {
        expect(output, `${surface.id}: "${needle}" reached the agent`).not.toContain(needle);
      }
      for (const needle of surface.mustSurvive) {
        expect(output, `${surface.id}: "${needle}" did not survive — redaction, not destruction`).toContain(needle);
      }
    });

    if (surface.verdict.kind === "scrubbed") {
      it("replaces the material with the redaction marker rather than dropping the field silently", () => {
        expect(scrubbed()).toContain(REDACTED);
      });
    } else if (surface.mustNotSurvive.length === 0) {
      it("passes through byte-exact", () => {
        // `scrubResponseBody` returns the ORIGINAL buffer when nothing changed,
        // which is the documented contract (`response-scrub.ts` constraint 6)
        // and the reason a pass-through cannot silently round a number or
        // reformat a log line.
        //
        // Skipped for a pass-through surface that carries an in-body control —
        // today only `configmap-data`, whose sample includes the echo
        // annotation precisely BECAUSE it gets redacted. That body must change;
        // asserting byte-exactness on it would be asserting the control did not
        // fire. Its `mustSurvive`/`mustNotSurvive` pair already pins both
        // halves, which is the stronger claim of the two.
        expect(scrubbed()).toBe(surface.body);
      });
    }
  });

  it("does not claim a boundary the scrubber does not hold", () => {
    // The PEN-4274 inversion, as an assertion: the SAME string is redacted in
    // one shape and returned in another, from the same seat in the same run.
    // If this ever fails, the boundary moved and the BOUNDARY note in this
    // file's docblock — and §1 of the egress doc — must be rewritten before
    // the assertion is.
    const asEnv = scrub(
      contentBlock(
        ["kind: Pod", "spec:", "  containers:", "  - name: c", "    env:", "    - name: URL", `      value: ${SENTINEL}`].join(
          "\n",
        ),
      ),
    );
    const asConfigMapData = scrub(contentBlock(["kind: ConfigMap", "data:", `  url: ${SENTINEL}`].join("\n")));

    expect(asEnv).not.toContain(SENTINEL);
    expect(asConfigMapData).toContain(SENTINEL);
  });

  // Carried forward from the review of 26da37bb: every assertion above runs on
  // the plain-JSON framing, but SSE is the framing most tool results actually
  // arrive in, and it takes a different branch of `transformResponseBody`. A
  // verdict that held on one framing and not the other would make this register
  // describe a transport the agent mostly does not use.
  describe.each(SURFACES.map((surface) => [surface.id, surface] as const))(
    "%s over SSE framing",
    (_id, surface) => {
      it(`reaches the same verdict as the JSON framing (${surface.verdict.kind})`, () => {
        const output = scrubSse(surface.body);
        for (const needle of surface.mustNotSurvive) {
          expect(output, `${surface.id}: "${needle}" survived SSE framing`).not.toContain(needle);
        }
        for (const needle of surface.mustSurvive) {
          expect(output, `${surface.id}: "${needle}" did not survive SSE framing`).toContain(needle);
        }
      });
    },
  );
});
