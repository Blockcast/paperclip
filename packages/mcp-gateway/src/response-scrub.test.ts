import { describe, expect, it } from "vitest";
import {
  REDACTED,
  scrubJsonValue,
  scrubResponseBody,
  scrubText,
  scrubYamlText,
} from "./response-scrub.js";

/**
 * Every fixture below uses the synthetic marker `LEAKED_*` in place of secret
 * material. No real credential appears in this file, and the central assertion
 * of most tests is that no `LEAKED_*` marker survives scrubbing — a test that
 * only checks `<redacted>` is present would pass even if the plaintext were
 * printed alongside it.
 */
const LEAK = "LEAKED_PLAINTEXT_MUST_NOT_SURVIVE";

function expectNoLeak(output: string): void {
  expect(output).not.toContain(LEAK);
  expect(output).not.toContain("LEAKED_");
}

describe("scrubYamlText — the shape kubectl actually emits", () => {
  it("redacts env values while preserving variable names", () => {
    const pod = [
      "spec:",
      "  containers:",
      "  - name: server",
      "    image: ghcr.io/example/app:v1",
      "    env:",
      "    - name: OPENAI_API_KEY",
      `      value: ${LEAK}`,
      "    - name: LOG_LEVEL",
      `      value: ${LEAK}`,
    ].join("\n");

    const out = scrubYamlText(pod);

    expectNoLeak(out);
    // Names survive: knowing *which* variables are set is the diagnostic value
    // of the grant, and is the whole reason we redact rather than drop the key.
    expect(out).toContain("name: OPENAI_API_KEY");
    expect(out).toContain("name: LOG_LEVEL");
    expect(out).toContain(`value: "${REDACTED}"`);
    // Non-secret spec fields are untouched.
    expect(out).toContain("image: ghcr.io/example/app:v1");
  });

  it("redacts regardless of variable name — no fragment allowlist", () => {
    // This is the property PEN-2380's name-pattern matcher lacked: a
    // credential whose name contains none of TOKEN/SECRET/KEY/PASSWORD/
    // CREDENTIAL/AUTH must still be redacted.
    const pod = [
      "    env:",
      "    - name: DSN",
      `      value: ${LEAK}`,
      "    - name: SIGNING_MATERIAL",
      `      value: ${LEAK}`,
      "    - name: INNOCUOUS",
      `      value: ${LEAK}`,
    ].join("\n");

    const out = scrubYamlText(pod);

    expectNoLeak(out);
    expect(out.match(/value: "<redacted>"/g)).toHaveLength(3);
  });

  it("preserves valueFrom references, which name a source but carry no material", () => {
    const pod = [
      "    env:",
      "    - name: FROM_SECRET",
      "      valueFrom:",
      "        secretKeyRef:",
      "          name: app-credentials",
      "          key: token",
    ].join("\n");

    const out = scrubYamlText(pod);

    expect(out).toContain("secretKeyRef:");
    expect(out).toContain("name: app-credentials");
    expect(out).toContain("key: token");
    expect(out).not.toContain(REDACTED);
  });

  it("swallows block-scalar continuation lines", () => {
    // `value: |` puts the material on the following lines. Redacting only the
    // key would print the secret directly underneath `value: "<redacted>"`.
    const pod = [
      "    env:",
      "    - name: PRIVATE_KEY",
      "      value: |",
      `        ${LEAK}-line-one`,
      `        ${LEAK}-line-two`,
      "    - name: AFTER",
      "      value: plain",
    ].join("\n");

    const out = scrubYamlText(pod);

    expectNoLeak(out);
    expect(out).toContain("name: PRIVATE_KEY");
    // The block did not swallow the following entry.
    expect(out).toContain("name: AFTER");
  });

  it("fails closed on flow-style env mappings", () => {
    const pod = `    env: [{name: A, value: ${LEAK}}]`;

    const out = scrubYamlText(pod);

    expectNoLeak(out);
    expect(out).toContain(`env: "${REDACTED}"`);
  });

  it("swallows a wrapped plain-scalar value, not just block scalars", () => {
    // kubectl's serializer folds long values at spaces, so a value can continue
    // on deeper-indented lines without any `|`/`>` marker. Handling only block
    // scalars printed `value: "<redacted>"` and then the plaintext underneath
    // it — worse than not scrubbing, because the marker implies it worked.
    const pod = [
      "    env:",
      "    - name: CONNECTION_STRING",
      `      value: some prefix ${LEAK}`,
      `        ${LEAK}-continued`,
      "    - name: AFTER",
      "      value: plain",
    ].join("\n");

    const out = scrubYamlText(pod);

    expectNoLeak(out);
    // The swallow stops at the next entry rather than eating the rest of the block.
    expect(out).toContain("name: AFTER");
    expect(out.match(/value: "<redacted>"/g)).toHaveLength(2);
  });

  it("swallows a double-quoted value wrapped across lines", () => {
    const pod = [
      "    env:",
      "    - name: CONNECTION_STRING",
      `      value: "prefix`,
      `        ${LEAK}"`,
      "    - name: AFTER",
      "      value: plain",
    ].join("\n");

    const out = scrubYamlText(pod);

    expectNoLeak(out);
    expect(out).toContain("name: AFTER");
  });

  it("fails closed on a flow-mapping entry inside a block env", () => {
    // `- {name: A, value: B}` as a sequence entry: the value sits in a construct
    // this scanner does not parse, so the entry is dropped rather than passed
    // through. `env: [...]` on one line is a different shape, covered above.
    const pod = [
      "    env:",
      `    - {name: OPENAI_API_KEY, value: ${LEAK}}`,
      "    - name: AFTER",
      "      value: plain",
    ].join("\n");

    const out = scrubYamlText(pod);

    expectNoLeak(out);
    expect(out).toContain("name: AFTER");
  });

  it("does not let the value swallow a sibling valueFrom block", () => {
    // The swallow boundary is load-bearing: `valueFrom:` sits at the same indent
    // as `value:`, so it must survive, along with its deeper-indented children.
    const pod = [
      "    env:",
      "    - name: LITERAL",
      `      value: ${LEAK}`,
      "    - name: FROM_SECRET",
      "      valueFrom:",
      "        secretKeyRef:",
      "          name: app-credentials",
      "          key: token",
    ].join("\n");

    const out = scrubYamlText(pod);

    expectNoLeak(out);
    expect(out).toContain("secretKeyRef:");
    expect(out).toContain("name: app-credentials");
    expect(out).toContain("key: token");
  });

  it("leaves `value:` keys outside an env block alone", () => {
    // Redacting every `value:` in the document would destroy unrelated,
    // non-secret spec data.
    const doc = [
      "spec:",
      "  ports:",
      "  - name: http",
      "    value: 8080",
      "  tolerations:",
      "  - key: dedicated",
      "    value: paperclip",
    ].join("\n");

    expect(scrubYamlText(doc)).toBe(doc);
  });

  it("closes the env block at a sibling key", () => {
    const pod = [
      "    env:",
      "    - name: A",
      `      value: ${LEAK}`,
      "    resources:",
      "      limits:",
      "        value: 512Mi",
    ].join("\n");

    const out = scrubYamlText(pod);

    expectNoLeak(out);
    // `resources.limits.value` is outside the env block and must survive.
    expect(out).toContain("value: 512Mi");
  });

  it("handles several containers, each with its own env block", () => {
    const pod = [
      "  containers:",
      "  - name: one",
      "    env:",
      "    - name: A",
      `      value: ${LEAK}`,
      "  - name: two",
      "    image: example:v2",
      "    env:",
      "    - name: B",
      `      value: ${LEAK}`,
    ].join("\n");

    const out = scrubYamlText(pod);

    expectNoLeak(out);
    expect(out.match(/value: "<redacted>"/g)).toHaveLength(2);
    expect(out).toContain("image: example:v2");
  });

  it("redacts the annotation that echoes the whole resource", () => {
    // kubectl writes the entire applied manifest here as one JSON string, so
    // it carries a second copy of every env value in the resource.
    const doc = [
      "metadata:",
      "  annotations:",
      `    kubectl.kubernetes.io/last-applied-configuration: '{"env":[{"name":"A","value":"${LEAK}"}]}'`,
      "  name: example",
    ].join("\n");

    const out = scrubYamlText(doc);

    expectNoLeak(out);
    expect(out).toContain("name: example");
  });

  it("swallows a wrapped echo annotation, whose value is long by nature", () => {
    // The last-applied JSON is long, so it is the field most likely to be
    // wrapped by the serializer. Redacting the key while printing the wrapped
    // remainder would leak the resource echo this field is redacted to remove.
    const doc = [
      "metadata:",
      "  annotations:",
      `    kubectl.kubernetes.io/last-applied-configuration: '{"env":[{"name":"A",`,
      `      "value":"${LEAK}"}]}'`,
      "  name: example",
    ].join("\n");

    const out = scrubYamlText(doc);

    expectNoLeak(out);
    expect(out).toContain("name: example");
  });
});

describe("scrubJsonValue — structural path, in case the server changes format", () => {
  it("redacts env values and keeps names", () => {
    const out = scrubJsonValue({
      spec: {
        containers: [
          { name: "server", image: "example:v1", env: [{ name: "API_KEY", value: LEAK }] },
        ],
      },
    });

    expectNoLeak(JSON.stringify(out));
    expect(out).toEqual({
      spec: {
        containers: [
          { name: "server", image: "example:v1", env: [{ name: "API_KEY", value: REDACTED }] },
        ],
      },
    });
  });

  it("keeps valueFrom entries intact", () => {
    const out = scrubJsonValue({
      env: [{ name: "FROM_SECRET", valueFrom: { secretKeyRef: { name: "creds", key: "t" } } }],
    }) as { env: unknown[] };

    expect(out.env[0]).toEqual({
      name: "FROM_SECRET",
      valueFrom: { secretKeyRef: { name: "creds", key: "t" } },
    });
  });

  it("redacts an env object with an unknown property instead of passing it through", () => {
    const out = scrubJsonValue({ env: [{ name: "A", credential: LEAK }] });

    expectNoLeak(JSON.stringify(out));
    expect(out).toEqual({ env: [REDACTED] });
  });

  it("redacts malformed valueFrom objects and their unknown properties", () => {
    const out = scrubJsonValue({
      env: [
        {
          name: "A",
          valueFrom: { secretKeyRef: { name: "creds", key: "t" }, credential: LEAK },
        },
        { name: "B", valueFrom: { secretKeyRef: { name: "creds" } } },
        { name: "C", valueFrom: { secretKeyRef: { name: "creds", key: "t", extra: LEAK } } },
        { name: "D", valueFrom: { secretKeyRef: { key: "t" } } },
        { name: "E", valueFrom: { configMapKeyRef: { name: "", key: "mode" } } },
      ],
    });

    expectNoLeak(JSON.stringify(out));
    expect(out).toEqual({ env: [REDACTED, REDACTED, REDACTED, REDACTED, REDACTED] });
  });

  it("keeps only a schema-valid valueFrom EnvVar shape", () => {
    const env = [
      {
        name: "FROM_SECRET",
        valueFrom: { secretKeyRef: { name: "creds", key: "t", optional: true } },
      },
      {
        name: "FROM_CONFIG_MAP",
        valueFrom: { configMapKeyRef: { name: "settings", key: "mode" } },
      },
      { name: "FROM_FIELD", valueFrom: { fieldRef: { fieldPath: "metadata.name" } } },
      {
        name: "FROM_RESOURCE",
        valueFrom: { resourceFieldRef: { containerName: "app", resource: "limits.cpu", divisor: "1m" } },
      },
    ];

    expect(scrubJsonValue({ env })).toEqual({ env });
  });

  it("recurses into YAML carried inside a string field", () => {
    // This is the real MCP shape: the resource arrives as YAML text inside a
    // JSON-RPC content block.
    const out = scrubJsonValue({
      content: [{ type: "text", text: `spec:\n  env:\n  - name: A\n    value: ${LEAK}\n` }],
    });

    expectNoLeak(JSON.stringify(out));
  });
});

describe("scrubResponseBody — transport framing", () => {
  it("scrubs a plain JSON-RPC tool result", () => {
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: `env:\n- name: A\n  value: ${LEAK}\n` }] },
      }),
    );

    const out = scrubResponseBody(body, "application/json").toString("utf8");

    expectNoLeak(out);
    expect(out).toContain(REDACTED);
    // Still a well-formed JSON-RPC response.
    expect(JSON.parse(out)).toMatchObject({ jsonrpc: "2.0", id: 1 });
  });

  it("scrubs SSE data frames and preserves framing", () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: `env:\n- name: A\n  value: ${LEAK}\n` }] },
    });
    const body = Buffer.from(`event: message\ndata: ${payload}\n\n`);

    const out = scrubResponseBody(body, "text/event-stream").toString("utf8");

    expectNoLeak(out);
    expect(out).toContain("event: message");
    expect(out).toContain("data: ");
    expect(out.endsWith("\n\n")).toBe(true);
  });

  it("returns unrelated bodies byte-for-byte unchanged", () => {
    // The gateway proxies many upstreams. Scrubbing must be inert for traffic
    // that carries nothing we redact.
    const body = Buffer.from(JSON.stringify({ result: { tools: [{ name: "list_pods" }] } }));

    expect(scrubResponseBody(body, "application/json")).toBe(body);
  });

  it("passes through a body it cannot parse rather than corrupting it", () => {
    const body = Buffer.from("env: not-json-not-yaml- binary");

    expect(scrubResponseBody(body, "application/octet-stream").toString("utf8")).toBe(
      body.toString("utf8"),
    );
  });
});

describe("scrubText", () => {
  it("routes JSON text through the structural path", () => {
    const out = scrubText(JSON.stringify({ env: [{ name: "A", value: LEAK }] }));

    expectNoLeak(out);
    expect(JSON.parse(out)).toEqual({ env: [{ name: "A", value: REDACTED }] });
  });

  it("handles multi-document YAML", () => {
    const docs = [
      "kind: Pod",
      "spec:",
      "  env:",
      "  - name: A",
      `    value: ${LEAK}`,
      "---",
      "kind: Pod",
      "spec:",
      "  env:",
      "  - name: B",
      `    value: ${LEAK}`,
    ].join("\n");

    const out = scrubText(docs);

    expectNoLeak(out);
    expect(out.match(/value: "<redacted>"/g)).toHaveLength(2);
  });
});

/**
 * Line-ending coverage. Before this suite existed, every fixture in this file
 * used `\n`, which is exactly why a CRLF fail-open could ship: `env:\r` still
 * matched (its `\s*` absorbed the `\r`) so the block was entered, but
 * `value: X\r` did not (`.` does not match `\r` and the pattern is not
 * `/m`-flagged), so every value line inside the block was emitted verbatim.
 */
describe("scrubYamlText — line endings", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["CR", "\r"],
  ];

  for (const [label, eol] of cases) {
    it(`redacts env values with ${label} terminators`, () => {
      const pod = [
        "    env:",
        "    - name: OPENAI_API_KEY",
        `      value: ${LEAK}`,
        "    image: ghcr.io/example/app:v1",
      ].join(eol);

      const out = scrubYamlText(pod);

      expectNoLeak(out);
      expect(out).toContain("name: OPENAI_API_KEY");
      expect(out).toContain(`value: "${REDACTED}"`);
      // Terminators are preserved, not normalized: this is a proxy, and
      // rewriting an upstream's line endings is its own kind of corruption.
      expect(out).toContain(`image: ghcr.io/example/app:v1`);
      expect(out.split(eol)).toHaveLength(4);
    });
  }

  it("swallows a CRLF block scalar continuation", () => {
    // The fail-closed swallow has to work per line-ending style too, or the
    // marker prints above the plaintext.
    const pod = ["    env:", "    - name: CERT", "      value: |", `        ${LEAK}`, "    image: x"].join(
      "\r\n",
    );

    expectNoLeak(scrubYamlText(pod));
  });
});

/**
 * Quoted key spellings. YAML permits `"value": x` and `'value': x`, and the
 * annotation pattern already allowed for quoting — the omission in the env and
 * value patterns was an oversight, and each spelling passed plaintext through.
 */
describe("scrubYamlText — quoted keys", () => {
  it("redacts a double-quoted value key", () => {
    expectNoLeak(scrubYamlText(`    env:\n    - name: A\n      "value": ${LEAK}`));
  });

  it("redacts a single-quoted value key", () => {
    expectNoLeak(scrubYamlText(`    env:\n    - name: A\n      'value': ${LEAK}`));
  });

  it("enters a block opened by a quoted env key", () => {
    expectNoLeak(scrubYamlText(`    "env":\n    - name: A\n      value: ${LEAK}`));
    expectNoLeak(scrubYamlText(`    'env':\n    - name: A\n      value: ${LEAK}`));
  });

  it("fails closed on a quoted env key with an inline flow value", () => {
    const out = scrubYamlText(`    "env": [{name: A, value: ${LEAK}}]`);

    expectNoLeak(out);
    expect(out).toContain(REDACTED);
  });
});

/**
 * `Secret` coverage. The same read-only grant serves `resources_get` with an
 * arbitrary kind, and a Secret carries its material directly rather than in an
 * `env` block — so scrubbing only `env` closed the harder path and left the
 * easier one open.
 */
describe("Secret material", () => {
  // Kubernetes serializes fields alphabetically, so `data` precedes
  // `kind: Secret`. A fixture in that order is the one that catches a scanner
  // which decides on first sight of the kind.
  const secretYaml = [
    "apiVersion: v1",
    `data:`,
    `  token: ${LEAK}_BASE64`,
    "kind: Secret",
    "metadata:",
    "  name: agent-credentials",
    "  namespace: paperclip",
    "stringData:",
    `  plainToken: ${LEAK}_PLAIN`,
    "type: Opaque",
  ].join("\n");

  it("redacts both data and stringData in a YAML Secret", () => {
    const out = scrubYamlText(secretYaml);

    expectNoLeak(out);
    // Identity survives — which Secret this is remains diagnostic.
    expect(out).toContain("name: agent-credentials");
    expect(out).toContain("type: Opaque");
    expect(out).toContain(`data: "${REDACTED}"`);
    expect(out).toContain(`stringData: "${REDACTED}"`);
  });

  it("redacts a Secret arriving as YAML in an MCP content block", () => {
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        result: { content: [{ type: "text", text: secretYaml }] },
      }),
    );

    expectNoLeak(scrubResponseBody(body, "application/json").toString("utf8"));
  });

  it("redacts a Secret in the structural JSON path", () => {
    const out = scrubJsonValue({
      kind: "Secret",
      metadata: { name: "agent-credentials" },
      data: { token: `${LEAK}_BASE64` },
      stringData: { plainToken: `${LEAK}_PLAIN` },
    });

    expectNoLeak(JSON.stringify(out));
    expect(out).toMatchObject({ data: REDACTED, stringData: REDACTED });
  });

  it("redacts SecretList items, which carry no kind of their own", () => {
    const out = scrubJsonValue({
      kind: "SecretList",
      items: [{ metadata: { name: "a" }, data: { token: `${LEAK}_BASE64` } }],
    });

    expectNoLeak(JSON.stringify(out));
  });

  it("leaves a ConfigMap's data intact — only Secrets lose it", () => {
    // Over-redacting here would remove real diagnostic value for no security
    // gain, so the kind check has to be load-bearing in both directions.
    const configMap = ["apiVersion: v1", "data:", "  LOG_LEVEL: debug", "kind: ConfigMap"].join("\n");

    expect(scrubYamlText(configMap)).toBe(configMap);
    expect(scrubJsonValue({ kind: "ConfigMap", data: { LOG_LEVEL: "debug" } })).toEqual({
      kind: "ConfigMap",
      data: { LOG_LEVEL: "debug" },
    });
  });

  it("scopes redaction to the Secret document in a multi-document stream", () => {
    const docs = [secretYaml, "---", "apiVersion: v1", "data:", "  LOG_LEVEL: debug", "kind: ConfigMap"].join(
      "\n",
    );

    const out = scrubText(docs);

    expectNoLeak(out);
    expect(out).toContain("LOG_LEVEL: debug");
  });
});

/**
 * The JSON serialization path, driven through the entry point the proxy
 * actually calls. Every prior JSON-path test invoked `scrubJsonValue` directly,
 * so none of them could catch that the raw-body pre-filter made this path
 * unreachable: nested JSON spells the key `\"env\":`, which matched neither the
 * `env:` nor the `"env"` probe.
 */
describe("scrubResponseBody — JSON-serialized resources", () => {
  it("scrubs a resource that arrives as JSON inside content[].text", () => {
    const resource = JSON.stringify({
      kind: "Pod",
      spec: { containers: [{ name: "c", env: [{ name: "OPENAI_API_KEY", value: LEAK }] }] },
    });
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        result: { content: [{ type: "text", text: resource }] },
      }),
    );

    const out = scrubResponseBody(body, "application/json").toString("utf8");

    expectNoLeak(out);
    expect(out).toContain(REDACTED);
    expect(JSON.parse(out)).toMatchObject({ jsonrpc: "2.0", id: 4 });
  });

  it("scrubs a JSON-serialized Secret inside content[].text", () => {
    const resource = JSON.stringify({
      kind: "Secret",
      stringData: { plainToken: LEAK },
    });
    const body = Buffer.from(JSON.stringify({ result: { content: [{ type: "text", text: resource }] } }));

    expectNoLeak(scrubResponseBody(body, "application/json").toString("utf8"));
  });

  it("scrubs a JSON resource delivered over SSE", () => {
    const resource = JSON.stringify({
      kind: "Pod",
      spec: { containers: [{ env: [{ name: "A", value: LEAK }] }] },
    });
    const payload = JSON.stringify({ result: { content: [{ type: "text", text: resource }] } });
    const body = Buffer.from(`event: message\ndata: ${payload}\n\n`);

    const out = scrubResponseBody(body, "text/event-stream").toString("utf8");

    expectNoLeak(out);
    expect(out).toContain("event: message");
  });
});

/**
 * Pass-through fidelity. `scrubJsonRpcBody` used to reparse and re-stringify
 * any body containing the substring `env:` even when nothing was redacted,
 * which silently rounded large integers and normalized `1.0` to `1`. This
 * gateway also proxies GitHub and Paperclip, where an issue body or diff
 * mentioning `env:` is routine — this PR's own diff would have triggered it.
 */
describe("scrubResponseBody — pass-through is byte-exact", () => {
  it("returns the original buffer when a body mentions env: but carries nothing to redact", () => {
    const body = Buffer.from('{"result":{"note":"see env: config for details"}}');

    expect(scrubResponseBody(body, "application/json")).toBe(body);
  });

  it("does not round numbers in a body it does not redact", () => {
    const raw = '{"result":{"note":"env: x","nodeId":12345678901234567890,"ratio":1.0}}';

    const out = scrubResponseBody(Buffer.from(raw), "application/json").toString("utf8");

    expect(out).toBe(raw);
    expect(out).toContain("12345678901234567890");
    expect(out).toContain("1.0");
  });

  it("returns the original buffer for a Secret-shaped key on a non-Secret kind", () => {
    const body = Buffer.from('{"result":{"kind":"ConfigMap","data":{"LOG_LEVEL":"debug"}}}');

    expect(scrubResponseBody(body, "application/json")).toBe(body);
  });

  it("still re-serializes when it did redact something", () => {
    const body = Buffer.from(JSON.stringify({ result: { env: [{ name: "A", value: LEAK }] } }));

    const out = scrubResponseBody(body, "application/json");

    expect(out).not.toBe(body);
    expectNoLeak(out.toString("utf8"));
  });
});

/**
 * Three fail-opens found by probing the scrubber's own entry point rather than
 * re-reading it. Each one returned the payload with the plaintext intact, so the
 * assertion that matters is the absence of the marker — not the presence of
 * `<redacted>`, which was never emitted on these paths at all.
 */
describe("scrubResponseBody — fail-opens in stream detection and framing", () => {
  const leakyPayload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: `env:\n- name: OPENAI_API_KEY\n  value: ${LEAK}\n` }],
    },
  });

  it("scrubs a stream whose lines are terminated by a lone CR", () => {
    // All three of CRLF, LF and CR terminate a line in an event stream.
    // Splitting on "\n" alone left a CR-only stream as one unsplit line, so no
    // line began with `data:` and the whole body passed through in the clear.
    const body = Buffer.from(`event: message\rdata: ${leakyPayload}\r\r`);

    const out = scrubResponseBody(body, "text/event-stream").toString("utf8");

    expectNoLeak(out);
    expect(out).toContain(REDACTED);
    expect(out).toContain("OPENAI_API_KEY");
  });

  it("scrubs a stream that opens on a field other than event:/data:", () => {
    // With no content-type to dispatch on, the sniff decides. It recognized only
    // `event:`/`data:`, so a stream opening on `id:` was classified as neither
    // SSE nor JSON and returned untouched.
    const body = Buffer.from(`id: 7\ndata: ${leakyPayload}\n\n`);

    const out = scrubResponseBody(body, null).toString("utf8");

    expectNoLeak(out);
    expect(out).toContain(REDACTED);
  });

  it("scrubs a stream that opens on a comment line", () => {
    const body = Buffer.from(`:keep-alive\ndata: ${leakyPayload}\n\n`);

    expectNoLeak(scrubResponseBody(body, null).toString("utf8"));
  });

  it("leaves a non-SSE body that merely opens on an SSE-looking token byte-exact", () => {
    // Widening the sniff must not start rewriting unrelated traffic: with no
    // `data:` lines there is nothing to redact, so the original Buffer is
    // returned rather than a re-serialized copy.
    const body = Buffer.from("id: 7\nnote: nothing secret here\n");

    expect(scrubResponseBody(body, null)).toBe(body);
  });
});

describe("scrubJsonValue — env serialized as a mapping", () => {
  it("redacts the values of an env mapping and keeps the names", () => {
    // Kubernetes emits env as a list, but the JSON path exists so an upstream
    // shape change cannot silently make this a no-op. The generic recursion
    // carries no "inside env" state, so a mapping fell through with every value
    // in the clear.
    const out = JSON.stringify(
      scrubJsonValue({ kind: "Pod", spec: { containers: [{ env: { OPENAI_API_KEY: LEAK } }] } }),
    );

    expectNoLeak(out);
    expect(out).toContain("OPENAI_API_KEY");
    expect(out).toContain(REDACTED);
  });

  it("preserves a valueFrom-shaped reference inside an env mapping", () => {
    const out = scrubJsonValue({
      kind: "Pod",
      env: { TOKEN: { secretKeyRef: { name: "creds", key: "token" } } },
    });

    // A reference names a source without carrying the material, so it survives.
    expect(JSON.stringify(out)).toContain("secretKeyRef");
    expect(JSON.stringify(out)).toContain("creds");
  });

  it("redacts an unrecognized nested object instead of trusting it as a reference", () => {
    const out = scrubJsonValue({
      kind: "Pod",
      env: {
        TOKEN: { value: LEAK },
        MISSING_NAME: { secretKeyRef: { key: LEAK } },
      },
    });

    expectNoLeak(JSON.stringify(out));
    expect(out).toEqual({
      kind: "Pod",
      env: { TOKEN: REDACTED, MISSING_NAME: REDACTED },
    });
  });
});

/**
 * The three groups below cover one defect class in three places: a line that
 * matched no redact pattern and was therefore emitted. The scanner's in-block
 * default is now to redact, so these fixtures pin the *allowlist* — both that
 * unrecognized content is dropped, and that the three keys a Kubernetes env
 * entry legally carries still survive.
 */
describe("scrubYamlText — every env: spelling opens the block", () => {
  // `env:` had a block pattern and an inline pattern, and two patterns must be
  // tested in some order. Both matched `env: # vars`; the inline one won and
  // emitted the line *without* opening the block, so every value below it
  // missed the in-block guard.
  for (const [label, suffix] of [
    ["a trailing comment", " # container vars"],
    ["an anchor", " &shared"],
    ["a tag", " !!seq"],
    ["an anchor and a comment", " &shared # reused"],
    ["a tab before an anchor", "\t&shared"],
    ["a tag and an anchor", " !!seq &shared"],
  ] as const) {
    it(`enters a block whose env: key carries ${label}`, () => {
      const pod = ["    env:" + suffix, "    - name: OPENAI_API_KEY", `      value: ${LEAK}`].join(
        "\n",
      );

      const out = scrubYamlText(pod);

      expectNoLeak(out);
      // The name is the diagnostic the grant exists for, so it must survive.
      expect(out).toContain("OPENAI_API_KEY");
      expect(out).toContain(REDACTED);
    });
  }

  it("fails closed on an alias, whose anchor may never have been scrubbed", () => {
    const out = scrubYamlText(`    env: *shared\n`);

    expect(out).toContain(REDACTED);
  });

  for (const [label, suffix] of [
    ["a block scalar", " |"],
    ["a folded scalar", " >"],
  ] as const) {
    it(`fails closed on env: introducing ${label}`, () => {
      const out = scrubYamlText(`    env:${suffix}\n      OPENAI_API_KEY=${LEAK}\n`);

      expectNoLeak(out);
    });
  }

  it("redacts an env: scalar in KEY=VALUE form but keeps the name", () => {
    const out = scrubYamlText(`    env: OPENAI_API_KEY=${LEAK}\n`);

    expectNoLeak(out);
    expect(out).toContain(REDACTED);
  });

  it("leaves a plain env: scalar alone — it is prose, not a k8s env value", () => {
    // Failing closed here is not free: redaction sets the changed flag, which
    // re-serializes the whole body and rounds integers above 2^53. `env` is
    // never a bare scalar in Kubernetes, so this text belongs to some other
    // body the gateway proxies and must come back untouched.
    const text = "  note: see env: config for details\n";

    expect(scrubYamlText(text)).toBe(text);
  });
});

describe("scrubYamlText — unrecognized content inside an env block", () => {
  for (const [label, entry] of [
    ["a KEY=VALUE scalar entry", `    - OPENAI_API_KEY=${LEAK}`],
    ["a double-quoted KEY=VALUE entry", `    - "OPENAI_API_KEY=${LEAK}"`],
    ["a single-quoted KEY=VALUE entry", `    - 'OPENAI_API_KEY=${LEAK}'`],
    ["a bare scalar entry", `    - ${LEAK}`],
    ["a flow sequence entry", `    - [OPENAI_API_KEY, ${LEAK}]`],
    ["an unknown key", `      unknownKey: ${LEAK}`],
    ["a near-miss key spelling", `      Value: ${LEAK}`],
  ] as const) {
    it(`redacts ${label}`, () => {
      const out = scrubYamlText(`    env:\n${entry}\n`);

      expectNoLeak(out);
    });
  }

  it("keeps the variable name of a KEY=VALUE entry", () => {
    const out = scrubYamlText(`    env:\n    - OPENAI_API_KEY=${LEAK}\n`);

    expectNoLeak(out);
    expect(out).toContain("OPENAI_API_KEY");
  });

  it("preserves a valueFrom subtree — the allowlist must not over-redact", () => {
    // Guards the other direction: an allowlist that dropped these would destroy
    // the diagnostics the grant exists for, which is the outcome ask 2 was
    // filed to avoid.
    const pod = [
      "    env:",
      "    - name: TOKEN",
      "      valueFrom:",
      "        secretKeyRef:",
      "          name: creds",
      "          key: token",
      "    - name: OPENAI_API_KEY",
      `      value: ${LEAK}`,
    ].join("\n");

    const out = scrubYamlText(pod);

    expectNoLeak(out);
    expect(out).toContain("valueFrom:");
    expect(out).toContain("secretKeyRef:");
    expect(out).toContain("name: creds");
    expect(out).toContain("key: token");
  });

  it("keeps sibling container fields once the env block ends", () => {
    const pod = [
      "  - name: server",
      "    env:",
      "    - name: OPENAI_API_KEY",
      `      value: ${LEAK}`,
      "    image: ghcr.io/example/app:v1",
      "    restartCount: 7",
    ].join("\n");

    const out = scrubYamlText(pod);

    expectNoLeak(out);
    expect(out).toContain("image: ghcr.io/example/app:v1");
    expect(out).toContain("restartCount: 7");
  });
});

describe("scrubJsonValue — env entries that are not objects", () => {
  it("redacts a KEY=VALUE string entry and keeps the name", () => {
    // `KEY=VALUE` is the OCI/Docker env shape. A scalar is not an object, so
    // the `value` lookup never ran and the entry was returned intact.
    const out = JSON.stringify(scrubJsonValue({ env: [`OPENAI_API_KEY=${LEAK}`] }));

    expectNoLeak(out);
    expect(out).toContain("OPENAI_API_KEY");
    expect(out).toContain(REDACTED);
  });

  for (const [label, env] of [
    ["a nested array entry", [["OPENAI_API_KEY", LEAK]]],
    ["a string entry with no separator", [LEAK]],
  ] as const) {
    it(`redacts ${label}`, () => {
      expectNoLeak(JSON.stringify(scrubJsonValue({ env })));
    });
  }

  it("redacts an env serialized as a single KEY=VALUE string", () => {
    const out = JSON.stringify(scrubJsonValue({ env: `OPENAI_API_KEY=${LEAK}` }));

    expectNoLeak(out);
    expect(out).toContain("OPENAI_API_KEY");
  });

  it("leaves a plain env string alone, matching the YAML path", () => {
    const out = scrubJsonValue({ env: "see config" });

    expect(JSON.stringify(out)).toContain("see config");
  });

  /**
   * The assertion above is true of `"see config"` and was read as true in
   * general — the JSON path gated on `value.includes("=")` while the YAML path
   * gated on a constant that ALSO matches a leading `[`, `{`, `*`, `|` or `>`.
   * Five shapes were redacted as YAML and returned verbatim as JSON.
   *
   * Assert the agreement differentially, over both paths, rather than pinning
   * one more fixture per path: a fixture list re-checks the spellings someone
   * already thought of, and this defect was born from exactly that.
   */
  describe("env scalars agree across the JSON and YAML paths", () => {
    const INDICATOR_LED = [
      ["flow sequence", `[${LEAK}]`],
      ["flow mapping", `{k: ${LEAK}}`],
      ["alias", `*${LEAK}`],
      ["literal block", `|${LEAK}`],
      ["folded block", `>${LEAK}`],
      ["OCI KEY=VALUE", `OPENAI_API_KEY=${LEAK}`],
    ] as const;

    for (const [label, scalar] of INDICATOR_LED) {
      it(`redacts a ${label} env scalar on BOTH paths`, () => {
        expectNoLeak(JSON.stringify(scrubJsonValue({ env: scalar })));
        expectNoLeak(scrubYamlText(`env: ${scalar}`));
      });
    }

    it("keeps the variable name only where there is one to keep", () => {
      // `KEY=VALUE` names its variable; an indicator-led scalar does not, so
      // inventing a name there would be worse than redacting whole.
      expect(scrubJsonValue({ env: `OPENAI_API_KEY=${LEAK}` })).toEqual({
        env: `OPENAI_API_KEY=${REDACTED}`,
      });
      expect(scrubJsonValue({ env: `*${LEAK}` })).toEqual({ env: REDACTED });
    });

    /**
     * Reported by Ally on #1518, reproduced on `origin/master` as well — the
     * name-preservation branch predates this PR and was never sound.
     *
     * "Has a name to preserve" was implemented as `indexOf("=") !== -1`, which
     * is a different question. `[LEAKED]=x` contains an `=`, so slicing at the
     * first one promoted the material into the name position and printed it
     * beside its own redaction marker — the exact "false assurance" failure
     * design note 4 of this module names as worse than no scrubber at all.
     */
    for (const [label, prefix] of [
      ["flow sequence", "[%s]"],
      ["flow mapping", "{k: %s}"],
      ["alias", "*%s"],
      ["literal block", "|%s"],
      ["folded block", ">%s"],
    ] as const) {
      it(`does not promote an indicator-led ${label} into the name position when a later = exists`, () => {
        const scalar = `${prefix.replace("%s", LEAK)}=x`;

        expectNoLeak(JSON.stringify(scrubJsonValue({ env: scalar })));
        expectNoLeak(scrubYamlText(`env: ${scalar}`));
      });
    }

    it("still preserves a real variable name that contains the legal name characters", () => {
      // The counterweight to the five tests above: validating the prefix must
      // not become "redact every scalar", or the diagnostic value of knowing
      // WHICH variable is set (design note 2) is gone.
      expect(scrubJsonValue({ env: `my.app-name_2=${LEAK}` })).toEqual({
        env: `my.app-name_2=${REDACTED}`,
      });
    });

    it("still passes prose through on both paths, so the gate did not widen to everything", () => {
      // The negative control. Without it, `env: REDACTED` unconditionally
      // would satisfy every assertion above while destroying the diagnostic
      // value the scrubber exists to preserve.
      expect(scrubJsonValue({ env: "see config" })).toEqual({ env: "see config" });
      expect(scrubYamlText("env: see config")).toContain("see config");
    });
  });

  it("leaves a null entry untouched rather than inventing a redaction", () => {
    expect(JSON.stringify(scrubJsonValue({ env: [null] }))).toBe('{"env":[null]}');
  });
});

describe("scrubResponseBody — SSE sniff skips leading bytes", () => {
  // The sniff is the fallback for an upstream that omits content-type. It was
  // anchored on a 6-byte window with no allowance for leading bytes, while the
  // JSON sniff already skipped whitespace — and that asymmetry meant a stream
  // opening on a blank line or a BOM was classified as neither, so the whole
  // stream including its data: payloads came back unscrubbed.
  const frame = `data: {"env":[{"name":"OPENAI_API_KEY","value":"${LEAK}"}]}\n\n`;

  for (const [label, prefix] of [
    ["a blank line", "\n"],
    ["CRLF", "\r\n"],
    ["a BOM", "﻿"],
    ["indentation", "  "],
    ["a BOM then a blank line", "﻿\n"],
  ] as const) {
    it(`scrubs a stream that opens on ${label}`, () => {
      const out = scrubResponseBody(Buffer.from(prefix + frame, "utf8"), null).toString("utf8");

      expectNoLeak(out);
      expect(out).toContain(REDACTED);
    });
  }

  it("still leaves a leading-whitespace body that is not a stream byte-exact", () => {
    const body = Buffer.from("  this is plain prose, not an event stream\n", "utf8");

    expect(scrubResponseBody(body, null)).toBe(body);
  });
});

/**
 * The `valueFrom` subtree is the one place inside an env block where lines pass
 * through, so it is the one place the in-block default-redact can be escaped.
 * The first case below is a REGRESSION guard: `valueFrom:` / `value:` was
 * already redacted before this block existed, by the plain in-block scanner.
 * An earlier draft of the subtree branch emitted every deeper line
 * unclassified, which re-opened it — a fix that loosened what the module
 * already enforced. These fixtures pin both directions.
 */
describe("scrubYamlText — the valueFrom subtree is classified, not trusted", () => {
  for (const [label, key] of [
    ["a value: key", "value"],
    ["an unknown key", "anything"],
    ["a near-miss selector", "secretKeyReff"],
  ] as const) {
    it(`redacts ${label} nested under valueFrom`, () => {
      const out = scrubYamlText(
        ["    env:", "    - name: A", "      valueFrom:", `        ${key}: ${LEAK}`].join("\n"),
      );

      expectNoLeak(out);
      expect(out).toContain(REDACTED);
    });
  }

  it("keeps every EnvVarSource selector and leaf — the allowlist must not over-redact", () => {
    const pod = [
      "    env:",
      "    - name: A",
      "      valueFrom:",
      "        secretKeyRef:",
      "          name: creds",
      "          key: token",
      "          optional: true",
      "    - name: B",
      "      valueFrom:",
      "        fieldRef:",
      "          apiVersion: v1",
      "          fieldPath: metadata.name",
      "    - name: C",
      "      valueFrom:",
      "        resourceFieldRef:",
      "          containerName: app",
      "          resource: limits.cpu",
      "          divisor: '1'",
    ].join("\n");

    const out = scrubYamlText(pod);

    for (const kept of [
      "secretKeyRef:",
      "name: creds",
      "key: token",
      "optional: true",
      "fieldRef:",
      "fieldPath: metadata.name",
      "resourceFieldRef:",
      "containerName: app",
      "resource: limits.cpu",
    ]) {
      expect(out).toContain(kept);
    }
    expect(out).not.toContain(REDACTED);
  });
});

describe("scrubJsonValue — Docker/OCI spells the key Env", () => {
  // The scalar-entry handling exists because `KEY=VALUE` is the OCI/Docker env
  // encoding. Docker also spells the key `Env` (`Config.Env`), so recognizing
  // that encoding under the lowercase key only would cover half the shape it
  // was added for.
  it("redacts a capitalized Env list and keeps the name", () => {
    const out = JSON.stringify(scrubJsonValue({ Env: [`OPENAI_API_KEY=${LEAK}`] }));

    expectNoLeak(out);
    expect(out).toContain("OPENAI_API_KEY");
  });

  it("redacts a capitalized Env mapping", () => {
    expectNoLeak(JSON.stringify(scrubJsonValue({ Env: { OPENAI_API_KEY: LEAK } })));
  });
});

describe("the two paths must agree on what an env key is", () => {
  // The JSON path routed every env check through the case-insensitive
  // `isEnvKey`, while the YAML scanner matched a lowercase `env` literal. The
  // describe block above covers `Env` on the JSON path and passed while every
  // non-lowercase spelling was emitted in the clear on the YAML one — a fixture
  // for one path standing in for a rule that was only half-implemented. These
  // assert the rule on the path that lacked it, at each entry shape.
  for (const key of ["Env", "ENV", "eNv"]) {
    it(`redacts a '${key}:' block on the YAML path — scalar KEY=VALUE entry`, () => {
      const out = scrubYamlText(`    ${key}:\n    - OPENAI_API_KEY=${LEAK}\n`);

      expectNoLeak(out);
      expect(out).toContain("OPENAI_API_KEY");
    });

    it(`redacts a '${key}:' block on the YAML path — name/value entries`, () => {
      const out = scrubYamlText(
        `    ${key}:\n    - name: OPENAI_API_KEY\n      value: ${LEAK}\n`,
      );

      expectNoLeak(out);
      expect(out).toContain("OPENAI_API_KEY");
    });

    it(`redacts a '${key}:' block on the YAML path — inline flow sequence`, () => {
      expectNoLeak(
        scrubYamlText(`    ${key}: [{name: OPENAI_API_KEY, value: ${LEAK}}]\n`),
      );
    });
  }

  // The pre-filter decides whether a nested string is scanned at all, so it
  // failing open put the miss one step before any redaction rule.
  it("scans a nested OCI-shaped resource carried in content[].text", () => {
    const body = Buffer.from(
      JSON.stringify({
        content: [{ type: "text", text: `Env:\n- OPENAI_API_KEY=${LEAK}\n` }],
      }),
      "utf8",
    );

    expectNoLeak(scrubResponseBody(body, "application/json").toString("utf8"));
  });

  // Case-insensitivity must not cost the diagnostic: `ENV: production` is an
  // ordinary ConfigMap key, and a plain scalar with no `=` is prose, not
  // material. If this over-redacts, reading a ConfigMap stops being useful.
  it("leaves a ConfigMap data key named ENV intact", () => {
    for (const key of ["env", "ENV", "Env"]) {
      const out = scrubYamlText(
        `kind: ConfigMap\ndata:\n  ${key}: production\n  LOG_LEVEL: debug\n`,
      );

      expect(out).toContain(`${key}: production`);
      expect(out).toContain("LOG_LEVEL: debug");
      expect(out).not.toContain(REDACTED);
    }
  });
});

describe("the two paths must agree on what a Secret is", () => {
  // Found by probing the fix above rather than by reading for it: `isEnvKey` was
  // made case-insensitive on both paths while the Secret gates stayed literal.
  // Measured before this change, each spelling below emitted the Secret's
  // material verbatim while the canonical `kind: Secret` + `data:` redacted — so
  // the mechanism was sound and only the spelling defeated it. This gate gives
  // up more than the env one: a Secret's `data` is entirely material, where an
  // env block at least keeps its names.
  for (const kind of ["Secret", "secret", "SECRET", "SecretList"]) {
    it(`redacts Secret material on the YAML path — 'kind: ${kind}'`, () => {
      const out = scrubYamlText(`kind: ${kind}\ndata:\n  token: ${LEAK}\n`);

      expectNoLeak(out);
      expect(out).toContain(REDACTED);
    });

    it(`redacts Secret material on the JSON path — 'kind: ${kind}'`, () => {
      expectNoLeak(JSON.stringify(scrubJsonValue({ kind, data: { token: LEAK } })));
    });
  }

  // The `kind` key itself, not just its value.
  for (const key of ["Kind", "KIND"]) {
    it(`redacts Secret material on the YAML path — '${key}:' key`, () => {
      expectNoLeak(scrubYamlText(`${key}: Secret\ndata:\n  token: ${LEAK}\n`));
    });

    it(`redacts Secret material on the JSON path — '${key}:' key`, () => {
      expectNoLeak(
        JSON.stringify(scrubJsonValue({ [key]: "Secret", data: { token: LEAK } })),
      );
    });
  }

  // And the material key's own spelling.
  for (const dataKey of ["Data", "DATA", "StringData", "stringdata"]) {
    it(`redacts Secret material on the YAML path — '${dataKey}:' key`, () => {
      expectNoLeak(scrubYamlText(`kind: Secret\n${dataKey}:\n  token: ${LEAK}\n`));
    });

    it(`redacts Secret material on the JSON path — '${dataKey}:' key`, () => {
      expectNoLeak(
        JSON.stringify(scrubJsonValue({ kind: "Secret", [dataKey]: { token: LEAK } })),
      );
    });
  }

  // The reason the Secret gate is scoped to Secret documents at all: a
  // ConfigMap's `data` is the diagnostic payload and must survive, at every
  // spelling the widened gate now accepts. If this over-redacts, reading a
  // ConfigMap stops being useful — which is Door #5's whole subject.
  for (const dataKey of ["data", "Data", "DATA"]) {
    it(`leaves ConfigMap '${dataKey}:' intact on the YAML path`, () => {
      const out = scrubYamlText(
        `kind: ConfigMap\n${dataKey}:\n  LOG_LEVEL: debug\n`,
      );

      expect(out).toContain("LOG_LEVEL: debug");
      expect(out).not.toContain(REDACTED);
    });

    it(`leaves ConfigMap '${dataKey}:' intact on the JSON path`, () => {
      const out = JSON.stringify(
        scrubJsonValue({ kind: "ConfigMap", [dataKey]: { LOG_LEVEL: "debug" } }),
      );

      expect(out).toContain("debug");
      expect(out).not.toContain(REDACTED);
    });
  }

  // `kind: secretstore` is a different resource (external-secrets.io), not a
  // Secret. Widening the gate must not swallow neighbouring kinds by prefix.
  it("does not treat a 'secretstore' kind as a Secret", () => {
    const out = scrubYamlText(`kind: secretstore\ndata:\n  LOG_LEVEL: debug\n`);

    expect(out).toContain("LOG_LEVEL: debug");
    expect(out).not.toContain(REDACTED);
  });
});

/**
 * PEN-2431, door #5: `spec.containers[].command` / `args`.
 *
 * Every test here pairs the absence assertion with a positive one on the same
 * output. An assert-absence test passes when the harness is broken and produces
 * nothing at all, so "the marker is gone" is only evidence if something that
 * should have survived is demonstrably still there.
 */
describe("argv redaction inside a container list (PEN-2431 door #5)", () => {
  const podYaml = (key: string, listKey = "containers") =>
    [
      "spec:",
      `  ${listKey}:`,
      "  - name: server",
      "    image: ghcr.io/example/app:v1",
      `    ${key}:`,
      `    - --token=${LEAK}`,
      "    - --namespace=kube-system",
      "    restartCount: 3",
      "",
    ].join("\n");

  for (const listKey of ["containers", "initContainers", "ephemeralContainers"]) {
    for (const key of ["command", "args"]) {
      it(`redacts '${key}' in '${listKey}' on the YAML path`, () => {
        const out = scrubYamlText(podYaml(key, listKey));

        expectNoLeak(out);
        // Positive baseline: the surrounding diagnostics survive, so the
        // absence above is redaction and not an empty return.
        expect(out).toContain("name: server");
        expect(out).toContain("image: ghcr.io/example/app:v1");
        expect(out).toContain("restartCount: 3");
        // Design note 2: the flag name is the diagnostic, so it is kept.
        expect(out).toContain("--token=");
        expect(out).toContain("--namespace=");
      });

      it(`redacts '${key}' in '${listKey}' on the JSON path`, () => {
        const out = JSON.stringify(
          scrubJsonValue({
            spec: {
              [listKey]: [
                { name: "server", [key]: [`--token=${LEAK}`, "serve"] },
              ],
            },
          }),
        );

        expectNoLeak(out);
        expect(out).toContain("server");
        expect(out).toContain("--token=");
      });
    }
  }

  it("redacts a bare positional argument, which has no flag name to keep", () => {
    const out = JSON.stringify(
      scrubJsonValue({
        spec: { containers: [{ name: "c", args: [LEAK, "serve"] }] },
      }),
    );

    expectNoLeak(out);
    expect(out).toContain("c");
    // No name/value split exists for a positional, so the whole token goes.
    expect(out).toContain(REDACTED);
  });

  it("fails closed on a flow sequence rather than passing it through", () => {
    const out = scrubYamlText(
      `spec:\n  containers:\n  - name: c\n    args: [--token=${LEAK}]\n`,
    );

    expectNoLeak(out);
    expect(out).toContain("name: c");
  });

  /**
   * The regression that matters most, and the one the first cut of this fix
   * missed: `pods_get` does not return a bare pod document. It returns JSON-RPC
   * whose `content[].text` carries the YAML rendering, and a nested string is
   * only handed to a scanner when `mightContainSecrets` trips on it. A pod
   * whose only carrier is `args:` has no `env:` key and no `kind: Secret`, so
   * every argv rule above was unreachable in the production shape while passing
   * when called directly. A redaction rule is only as reachable as its
   * pre-filter.
   */
  it("redacts argv through the production JSON-RPC envelope, not just direct calls", () => {
    const body = JSON.stringify({
      result: { content: [{ type: "text", text: podYaml("args") }] },
    });

    const out = scrubResponseBody(Buffer.from(body), "application/json").toString();

    expectNoLeak(out);
    expect(out).toContain("name: server");
    expect(out).toContain("restartCount: 3");
  });

  /**
   * Shape parity between the two paths. The YAML scanner fails closed on a
   * scalar `command:` — any non-empty suffix is redacted wholesale — but the
   * JSON walker originally required `Array.isArray(value)`, so a `"command"`
   * holding a string or a mapping fell through the generic recursion and was
   * emitted in the clear. Both shapes are asserted here because the JSON path
   * exists precisely so an upstream shape change cannot silently turn this
   * scrubber into a no-op; a shape it passes through defeats its own reason to
   * exist. The array case above is the discriminator: it redacted before this
   * fix and still does, so these two are the change and not a broken harness.
   */
  it("redacts a scalar-string command inside a container list (JSON path)", () => {
    const out = JSON.stringify(
      scrubJsonValue({
        kind: "Pod",
        spec: { containers: [{ name: "server", command: `/bin/sh -c TOKEN=${LEAK}` }] },
      }),
    );

    expectNoLeak(out);
    expect(out).toContain("server");
  });

  it("redacts a mapping-shaped command inside a container list (JSON path)", () => {
    const out = JSON.stringify(
      scrubJsonValue({
        kind: "Pod",
        spec: { containers: [{ name: "server", command: { run: `TOKEN=${LEAK}` } }] },
      }),
    );

    expectNoLeak(out);
    expect(out).toContain("server");
  });

  it("leaves a null command untouched — no material, no name to invent", () => {
    const out = JSON.stringify(
      scrubJsonValue({
        kind: "Pod",
        spec: { containers: [{ name: "server", command: null }] },
      }),
    );

    expect(out).toContain('"command":null');
  });

  it("leaves 'args' outside a container list untouched", () => {
    // The shape this gateway carries constantly: an Actions workflow / MCP tool
    // schema. Redacting a bare `args:` would corrupt ordinary traffic on a key
    // far more common than `env:`.
    const out = JSON.stringify(
      scrubJsonValue({ jobs: { build: { steps: [{ args: ["--verbose"] }] } } }),
    );

    expect(out).toContain("--verbose");
    expect(out).not.toContain(REDACTED);
  });

  it("leaves a ConfigMap carrying an 'args' key intact", () => {
    // ConfigMap `data` stays preserved (recorded decision, residual risk), and
    // the argv gate must not reach into it just because a key is named `args`.
    const out = scrubYamlText(
      "kind: ConfigMap\ndata:\n  args: --log-level=debug\n",
    );

    expect(out).toContain("--log-level=debug");
    expect(out).not.toContain(REDACTED);
  });
});

describe("argv redaction — the fail-opens Ally's review found (PEN-2431 door #5)", () => {
  // All six reproduced against 6827796 before the fix. Reverting only
  // `response-scrub.ts` fails exactly these six and nothing else.

  it("does not print a block-scalar argv token beneath its own redaction marker", () => {
    // The Critical. A sequence entry's block-scalar content sits at *exactly*
    // the column after the dash, so a `> indent + dash.length` threshold was
    // false on the first continuation line: `- "<redacted>"` was emitted and the
    // plaintext printed directly under it. `command: ["/bin/sh","-c",<script>]`
    // is both the most common credential-bearing argv shape and the one
    // kubectl's serializer renders as a block scalar.
    const pod = [
      "spec:",
      "  containers:",
      "  - name: c",
      "    command:",
      "    - /bin/sh",
      "    - -c",
      "    - |",
      `      export TOKEN=${LEAK}`,
    ].join("\n");

    const out = scrubResponseBody(
      Buffer.from(
        JSON.stringify({ result: { content: [{ type: "text", text: pod }] } }),
      ),
      "application/json",
    ).toString("utf8");

    expectNoLeak(out);
    expect(out).toContain(REDACTED);
  });

  it("swallows a folded-scalar argv entry too, not just a literal one", () => {
    const out = scrubYamlText(
      [
        "spec:",
        "  containers:",
        "  - name: c",
        "    args:",
        "    - >",
        `      export TOKEN=${LEAK}`,
      ].join("\n"),
    );

    expectNoLeak(out);
  });

  it("fails closed on a scalar written directly under command:, where no dash arms the swallow", () => {
    // The argv in-block scanner had no default-deny arm, so a line that was
    // neither blank, a comment, nor a sequence entry fell out of the branch and
    // reached the final `emit(line)`. No dash means no swallow was ever set, so
    // the swallow fix alone does not cover this one.
    const out = scrubYamlText(
      [
        "spec:",
        "  containers:",
        "  - name: c",
        "    command:",
        `      export TOKEN=${LEAK}`,
      ].join("\n"),
    );

    expectNoLeak(out);
  });

  it("does not let a containers: key inside an env block escape the env default-deny", () => {
    // Regression against base ada8117, where this line was redacted: the
    // CONTAINERS_KEY branch is tested before the env in-block scanner, so three
    // key spellings were carved out of that scanner's default-deny.
    const out = scrubYamlText(
      [
        "spec:",
        "  containers:",
        "  - name: c",
        "    env:",
        "    - name: A",
        `      containers: ${LEAK}`,
        "      value: keepme",
      ].join("\n"),
    );

    expectNoLeak(out);
    expect(out).toContain("name: A");
  });

  it("fails closed on a flow-style container list instead of passing it through whole", () => {
    // `args: [...]` already fails closed one level down; the container list
    // above it emitted its suffix unclassified, so the same shape was
    // fail-closed inside and fail-open outside.
    const out = scrubYamlText(
      ["spec:", `  containers: [{name: c, args: ["--token=${LEAK}"]}]`].join(
        "\n",
      ),
    );

    expectNoLeak(out);
  });

  it("keeps the argv block open across a comment at the block's own indent", () => {
    // `continuesBlock` treated a same-indent comment as a sibling key, closing
    // the block before the scanner ran, so every entry after the comment
    // reached the final `emit(line)`.
    const out = scrubYamlText(
      [
        "spec:",
        "  containers:",
        "  - name: c",
        "    args:",
        "    # note",
        `    - --token=${LEAK}`,
      ].join("\n"),
    );

    expectNoLeak(out);
    expect(out).toContain("--token=");
  });

  it("still preserves the diagnostic fields the read-only grant exists for", () => {
    const out = scrubYamlText(
      [
        "spec:",
        "  containers:",
        "  - name: server",
        "    image: harbor/app:v1",
        "    restartCount: 3",
        "    command:",
        "    - /bin/sh",
        "    env:",
        "    - name: OPENAI_API_KEY",
        `      value: ${LEAK}`,
      ].join("\n"),
    );

    expectNoLeak(out);
    expect(out).toContain("name: server");
    expect(out).toContain("image: harbor/app:v1");
    expect(out).toContain("restartCount: 3");
    expect(out).toContain("name: OPENAI_API_KEY");
  });
});

describe("argv redaction in the production-shaped pod (Ally 9d6470b)", () => {
  // Ally's review of 9d6470b reported the Critical as still-present, on the
  // grounds that `continuesBlock(line, 2)` returns false on `image:` and so the
  // container block closes before `command:` is reached. That mechanism does not
  // hold: the container block is anchored at the `containers:` KEY indent (2),
  // not at the container item's field indent (4), so `image:` is deeper than the
  // block and `indent > blockIndent` keeps it open.
  //
  // The finding was not reproducible — but the coverage criticism behind it was
  // correct, and these are the tests it asked for. Every case below leaks at
  // 6827796 and passes here, which is what makes them regression tests rather
  // than restatements.

  it("redacts a block scalar that follows ordinary container fields", () => {
    const pod = [
      "spec:",
      "  containers:",
      "  - name: c",
      "    image: x",
      "    command:",
      "    - |",
      `      TOKEN=${LEAK}`,
    ].join("\n");

    const out = scrubResponseBody(
      Buffer.from(
        JSON.stringify({ result: { content: [{ type: "text", text: pod }] } }),
      ),
      "application/json",
    ).toString("utf8");

    expectNoLeak(out);
    expect(out).toContain(REDACTED);
  });

  it("redacts a folded scalar that follows ordinary container fields", () => {
    const out = scrubYamlText(
      [
        "spec:",
        "  containers:",
        "  - name: c",
        "    image: x",
        "    args:",
        "    - >",
        `      TOKEN=${LEAK}`,
      ].join("\n"),
    );

    expectNoLeak(out);
    expect(out).toContain(REDACTED);
  });

  it("redacts argv in the indented-list serialization style too", () => {
    const out = scrubYamlText(
      [
        "spec:",
        "  containers:",
        "    - name: c",
        "      image: x",
        "      command:",
        "      - |",
        `        TOKEN=${LEAK}`,
      ].join("\n"),
    );

    expectNoLeak(out);
    expect(out).toContain(REDACTED);
  });

  it("keeps the flag name after several ordinary fields", () => {
    const out = scrubYamlText(
      [
        "spec:",
        "  containers:",
        "  - name: c",
        "    image: x",
        "    imagePullPolicy: IfNotPresent",
        "    restartCount: 3",
        "    args:",
        `    - --token=${LEAK}`,
      ].join("\n"),
    );

    expectNoLeak(out);
    expect(out).toContain("--token=");
    expect(out).toContain(REDACTED);
  });

  it("redacts a post-comment argv token in the full mapping shape", () => {
    const out = scrubYamlText(
      [
        "spec:",
        "  containers:",
        "  - name: c",
        "    image: x",
        "    args:",
        "    # note",
        `    - --token=${LEAK}`,
      ].join("\n"),
    );

    expectNoLeak(out);
    expect(out).toContain(REDACTED);
  });

  it("scrubs the second container in the list, not just the first", () => {
    const out = scrubYamlText(
      [
        "spec:",
        "  containers:",
        "  - name: a",
        "    image: x",
        "    args:",
        "    - --one=ok",
        "  - name: b",
        "    image: y",
        "    args:",
        `    - --token=${LEAK}`,
      ].join("\n"),
    );

    expectNoLeak(out);
    expect(out).toContain("name: b");
  });
});

/**
 * PEN-2370 ask 3, "the method is the control": after each remediation, go
 * looking for another route to the same material rather than re-reading the
 * patch. Doors #5 and #6 were both found that way. These are the routes reached
 * by that method against this scrubber.
 *
 * Every one of them already passed the first time it was probed — none of these
 * tests is a bug fix, and that is the point worth stating. They are here because
 * the routes were *unlocked*: the scrubber earns them by keying on
 * `containers:` / `env:` by NAME at any depth, never on a pod-shaped
 * `spec.containers` path. Nothing pinned that property. A later change that
 * narrowed detection to the pod path — the obvious "tighten the match"
 * refactor — would reopen every route below while all 105 pre-existing tests
 * stayed green, because every one of them reads a bare pod.
 */
describe("alternate routes to the same material (PEN-2370 ask 3 method)", () => {
  it("YAML: a workload controller nests env one level deeper than a pod", () => {
    // resources_get(apps/v1, Deployment) is an advertised use of the same
    // read-only grant, and its material sits at
    // spec.template.spec.containers[] rather than spec.containers[].
    const out = scrubYamlText(
      [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        "  name: api",
        "spec:",
        "  replicas: 2",
        "  template:",
        "    spec:",
        "      containers:",
        "      - name: api",
        "        image: ghcr.io/example/api:v1",
        "        env:",
        "        - name: DATABASE_URL",
        `          value: ${LEAK}`,
        "        - name: LOG_LEVEL",
        `          value: ${LEAK}`,
      ].join("\n"),
    );

    expectNoLeak(out);
    // Names are the diagnostic value the grant exists for; they must survive.
    expect(out).toContain("name: DATABASE_URL");
    expect(out).toContain("name: LOG_LEVEL");
  });

  it("JSON: a workload controller nests env one level deeper than a pod", () => {
    const out = JSON.stringify(
      scrubJsonValue({
        apiVersion: "apps/v1",
        kind: "Deployment",
        spec: {
          template: {
            spec: {
              containers: [{ name: "api", env: [{ name: "DATABASE_URL", value: LEAK }] }],
            },
          },
        },
      }),
    );

    expectNoLeak(out);
    expect(out).toContain("DATABASE_URL");
    expect(out).toContain(REDACTED);
  });

  it("YAML: CronJob's doubly-nested template is still reached", () => {
    // The deepest nesting the core API ships:
    // spec.jobTemplate.spec.template.spec.containers[].
    const out = scrubYamlText(
      [
        "apiVersion: batch/v1",
        "kind: CronJob",
        "spec:",
        "  jobTemplate:",
        "    spec:",
        "      template:",
        "        spec:",
        "          containers:",
        "          - name: rotate",
        "            env:",
        "            - name: SIGNING_MATERIAL",
        `              value: ${LEAK}`,
      ].join("\n"),
    );

    expectNoLeak(out);
    expect(out).toContain("name: SIGNING_MATERIAL");
  });

  it("JSON: a list response scrubs every item, not just the document root", () => {
    // resources_list / pods_list return items[]. A root-only scrub would hand
    // back the whole namespace in one call rather than one pod at a time.
    const out = JSON.stringify(
      scrubJsonValue({
        apiVersion: "v1",
        kind: "PodList",
        items: [
          {
            kind: "Pod",
            spec: { containers: [{ name: "a", env: [{ name: "TOKEN_A", value: LEAK }] }] },
          },
          {
            kind: "Pod",
            spec: { containers: [{ name: "b", env: [{ name: "TOKEN_B", value: LEAK }] }] },
          },
        ],
      }),
    );

    expectNoLeak(out);
    expect(out).toContain("TOKEN_A");
    expect(out).toContain("TOKEN_B");
  });

  it("JSON: SecretList items are covered, not only a single Secret", () => {
    const out = JSON.stringify(
      scrubJsonValue({
        kind: "SecretList",
        items: [{ kind: "Secret", data: { token: "YWJj" }, stringData: { plain: LEAK } }],
      }),
    );

    expectNoLeak(out);
    expect(out).toContain(REDACTED);
  });

  it("JSON: material re-embedded as a string in an annotation does not pass through", () => {
    // kubectl stores the whole submitted object — values included — in
    // metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"]
    // as JSON *text*. A structural walker sees one long opaque string there,
    // not a container list, so this route sidesteps the env rule entirely.
    const lastApplied = JSON.stringify({
      apiVersion: "v1",
      kind: "Pod",
      spec: { containers: [{ name: "app", env: [{ name: "DSN", value: LEAK }] }] },
    });

    const out = JSON.stringify(
      scrubJsonValue({
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name: "app",
          annotations: { "kubectl.kubernetes.io/last-applied-configuration": lastApplied },
        },
        spec: { containers: [{ name: "app", env: [{ name: "DSN", value: LEAK }] }] },
      }),
    );

    expectNoLeak(out);
  });

  it("YAML: material re-embedded as an annotation scalar does not pass through", () => {
    const lastApplied = JSON.stringify({
      spec: { containers: [{ name: "app", env: [{ name: "DSN", value: LEAK }] }] },
    });

    const out = scrubYamlText(
      [
        "apiVersion: v1",
        "kind: Pod",
        "metadata:",
        "  annotations:",
        `    kubectl.kubernetes.io/last-applied-configuration: '${lastApplied}'`,
        "  name: app",
        "spec:",
        "  containers:",
        "  - name: app",
        "    env:",
        "    - name: DSN",
        `      value: ${LEAK}`,
      ].join("\n"),
    );

    expectNoLeak(out);
  });
});

/**
 * Block-termination fail-opens: a line that ENDS the env/argv block is never
 * seen by the in-block scanner, because the termination guard runs first. So
 * any line that wrongly reads as a sibling key re-exposes every value after it
 * — printing `value: "<redacted>"` for the entries before and the plaintext for
 * the entries after, which is worse than no scrubber at all because the marker
 * manufactures assurance.
 *
 * Both shapes below were live on `master` at `dc2bfaa4`, on the env block
 * (credential values) and the argv block (PEN-2431 door #5 material) alike,
 * because all three block guards share one predicate.
 */
describe("scrubYamlText — a line inside a block must not terminate it", () => {
  const podWith = (interruption: string[]): string =>
    [
      "apiVersion: v1",
      "kind: Pod",
      "spec:",
      "  containers:",
      "  - name: app",
      "    env:",
      "    - name: FIRST",
      `      value: ${LEAK}`,
      ...interruption,
      "    - name: SECOND",
      `      value: ${LEAK}`,
      "    image: example/app:1.2.3",
      "    ports:",
      "    - containerPort: 8080",
    ].join("\n");

  // YAML permits a comment at any column, including column 0 in the middle of a
  // nested block. Only a comment at exactly the block indent was held in.
  it.each([
    ["column 0", "# a comment at column zero"],
    ["column 2, shallower than the block", "  # a comment"],
    ["the block indent", "    # a comment"],
    ["deeper than the block", "        # a comment"],
  ])("holds the env block open across a comment at %s", (_label, comment) => {
    expectNoLeak(scrubYamlText(podWith([comment])));
  });

  // `leadingIndent` counts spaces, so a tab-indented line measured as indent 0.
  // YAML forbids tabs in indentation, so such a line is never a sibling key.
  it("holds the env block open across a tab-indented line", () => {
    expectNoLeak(scrubYamlText(podWith(["\tsomething: else"])));
  });

  it("holds the env block open across a comment and a tab line together", () => {
    expectNoLeak(scrubYamlText(podWith(["# note", "\tsomething: else"])));
  });

  it("holds the env block open across a column-0 comment with CRLF terminators", () => {
    expectNoLeak(scrubYamlText(podWith(["# note"]).replace(/\n/g, "\r\n")));
  });

  it("redacts a block scalar opened after a column-0 comment", () => {
    expectNoLeak(
      scrubYamlText(
        [
          "spec:",
          "  containers:",
          "  - name: app",
          "    env:",
          "    - name: A",
          "# note",
          "    - name: B",
          "      value: |",
          `        ${LEAK}`,
          "    image: example/app:1.2.3",
        ].join("\n"),
      ),
    );
  });

  // The argv block carries `--token=…` rather than `value:`, and shares the
  // same termination predicate, so the same two shapes reopened it.
  const argvWith = (interruption: string[]): string =>
    [
      "spec:",
      "  containers:",
      "  - name: app",
      "    args:",
      `    - --first=${LEAK}`,
      ...interruption,
      `    - --second=${LEAK}`,
      "    image: example/app:1.2.3",
    ].join("\n");

  it.each([
    ["a column-0 comment", "# note"],
    ["a tab-indented line", "\tsomething: else"],
  ])("holds the argv block open across %s", (_label, interruption) => {
    expectNoLeak(scrubYamlText(argvWith([interruption])));
  });

  // Tab-indented spellings of the value key itself, reachable only once the
  // block is correctly held open — so these would pass vacuously without the
  // fix above, and are asserted to keep the widened path honest.
  it.each([
    ["a tab-indented `value:` key", "\tvalue: "],
    ["a tab-indented quoted value key", '\t"value": '],
  ])("redacts %s inside an env block", (_label, prefix) => {
    expectNoLeak(
      scrubYamlText(
        [
          "spec:",
          "  containers:",
          "  - name: app",
          "    env:",
          "    - name: A",
          `${prefix}${LEAK}`,
          "    image: example/app:1.2.3",
        ].join("\n"),
      ),
    );
  });

  it.each([
    ["a tab-indented KEY=VALUE entry", `\t- A=${LEAK}`],
    ["a tab-indented flow mapping entry", `\t- {name: A, value: ${LEAK}}`],
  ])("redacts %s inside an env block", (_label, entry) => {
    expectNoLeak(
      scrubYamlText(
        [
          "spec:",
          "  containers:",
          "  - name: app",
          "    env:",
          entry,
          "    image: example/app:1.2.3",
        ].join("\n"),
      ),
    );
  });

  it("redacts a deeper-indented continuation of an unmeasurable line", () => {
    expectNoLeak(
      scrubYamlText(
        [
          "spec:",
          "  containers:",
          "  - name: app",
          "    env:",
          "    - name: A",
          "\tsomething: x",
          `        ${LEAK}`,
          "    image: example/app:1.2.3",
        ].join("\n"),
      ),
    );
  });
});

/**
 * The counter-direction. Widening what stays inside a block is fail-closed, but
 * a fail-closed rule that swallows the rest of the container spec removes the
 * diagnostics the grant exists for — and under-redaction and over-redaction are
 * both failures of this scrubber, so the limit needs pinning from both sides.
 *
 * A tab-indented line has no measurable depth, so it must not set a swallow
 * threshold either: `leadingIndent` reported 0 for it, which meant "drop every
 * following line indented deeper than 0" and ate image, ports, resources and
 * probes as far as the next column-0 key.
 */
describe("scrubYamlText — holding a block open does not swallow the spec", () => {
  const interrupted = scrubYamlText(
    [
      "apiVersion: v1",
      "kind: Pod",
      "spec:",
      "  containers:",
      "  - name: app",
      "    env:",
      "    - name: A",
      `      value: ${LEAK}`,
      "# column-zero comment",
      "\ttab: line",
      "    image: example/app:1.2.3",
      "    ports:",
      "    - containerPort: 8080",
      "    resources:",
      "      limits:",
      "        memory: 512Mi",
      "    livenessProbe:",
      "      httpGet:",
      "        path: /healthz",
      "status:",
      "  phase: Running",
      "  containerStatuses:",
      "  - name: app",
      "    restartCount: 7",
    ].join("\n"),
  );

  it("still redacts the value", () => {
    expectNoLeak(interrupted);
  });

  it.each([
    ["the env variable name", "name: A"],
    ["the image", "image: example/app:1.2.3"],
    ["ports", "containerPort: 8080"],
    ["resource limits", "memory: 512Mi"],
    ["probes", "path: /healthz"],
    ["status.phase", "phase: Running"],
    ["restartCount", "restartCount: 7"],
  ])("preserves %s", (_label, fragment) => {
    expect(interrupted).toContain(fragment);
  });

  it("preserves a valueFrom reference across a column-0 comment", () => {
    const out = scrubYamlText(
      [
        "spec:",
        "  containers:",
        "  - name: app",
        "    env:",
        "    - name: B",
        "      valueFrom:",
        "        secretKeyRef:",
        "          name: my-secret",
        "          key: token",
        "# note",
        "    - name: C",
        `      value: ${LEAK}`,
        "    image: example/app:1.2.3",
      ].join("\n"),
    );

    expectNoLeak(out);
    expect(out).toContain("secretKeyRef");
    expect(out).toContain("name: my-secret");
    expect(out).toContain("key: token");
    expect(out).toContain("image: example/app:1.2.3");
  });

  // A tab is only unmeasurable indentation when it is in the INDENT. A tab
  // inside a value is content, and must not hold the block open on its own.
  it("treats a tab inside a value as content, not indentation", () => {
    const out = scrubYamlText(
      [
        "spec:",
        "  containers:",
        "  - name: app",
        "    env:",
        "    - name: D",
        `      value: ${LEAK}`,
        "    image: has\ttab:1",
        "    ports:",
        "    - containerPort: 9090",
      ].join("\n"),
    );

    expectNoLeak(out);
    expect(out).toContain("has\ttab:1");
    expect(out).toContain("containerPort: 9090");
  });

  // A real sibling key after an interruption must still close the block,
  // otherwise the widening grows into swallowing the whole document.
  it("still ends the block on a real sibling key after a comment", () => {
    const out = scrubYamlText(
      [
        "spec:",
        "  containers:",
        "  - name: app",
        "    env:",
        "    - name: A",
        "# note",
        "    image: example/app:9.9.9",
        "    ports:",
        "    - containerPort: 1234",
      ].join("\n"),
    );

    expect(out).toContain("image: example/app:9.9.9");
    expect(out).toContain("containerPort: 1234");
  });
});

/**
 * The argv half of the over-redaction guard above (Ally review, PR #1501).
 *
 * `swallowFrom` was applied to the three env arms but not to either argv arm,
 * so a tab-indented line inside `command:`/`args:` still set a threshold of 0 —
 * "drop every following line indented deeper than 0" — and ate the rest of the
 * container spec to the next column-0 key. Both argv arms had it, not just the
 * unrecognized-line one the review named:
 *
 * - the sequence-entry arm, because `SEQUENCE_DASH` is `\s`-based and matches a
 *   tab-indented `- token`;
 * - the unrecognized-line fall-through, for any other tab-indented shape.
 *
 * The token stays redacted in both directions — this was diagnostic loss, not a
 * leak — but over-redaction is a failure of this scrubber too, so it is pinned
 * from both sides exactly as the env path is.
 */
describe("scrubYamlText — a tab inside an argv block does not swallow the spec", () => {
  const argvInterrupted = (interruption: string): string =>
    scrubYamlText(
      [
        "apiVersion: v1",
        "kind: Pod",
        "spec:",
        "  containers:",
        "  - name: app",
        "    args:",
        `    - --first=${LEAK}`,
        interruption,
        `    - --second=${LEAK}`,
        "    image: example/app:1.2.3",
        "    ports:",
        "    - containerPort: 8080",
        "    resources:",
        "      limits:",
        "        memory: 512Mi",
        "    livenessProbe:",
        "      httpGet:",
        "        path: /healthz",
        "status:",
        "  phase: Running",
      ].join("\n"),
    );

  // The two arms, driven by whether the tab-indented line parses as a sequence
  // entry. Both set the bogus 0 threshold before the fix.
  const interruptions: ReadonlyArray<readonly [string, string]> = [
    ["a tab-indented sequence entry", `\t- --tabbed=${LEAK}`],
    ["a tab-indented plain line", "\tsomething: else"],
  ];

  it.each(interruptions)(
    "still redacts every argv token across %s",
    (_label, interruption) => {
      expectNoLeak(argvInterrupted(interruption));
    },
  );

  describe.each(interruptions)("across %s", (_label, interruption) => {
    const out = argvInterrupted(interruption);

    it.each([
      ["the image", "image: example/app:1.2.3"],
      ["ports", "containerPort: 8080"],
      ["resource limits", "memory: 512Mi"],
      ["probes", "path: /healthz"],
      ["status.phase", "phase: Running"],
    ])("preserves %s", (_fragmentLabel, fragment) => {
      expect(out).toContain(fragment);
    });
  });

  // Skipping the swallow is only safe because the argv in-block default is
  // REDACT. A continuation line that is no longer swallowed must therefore be
  // redacted individually rather than passed through — otherwise this fix
  // would have traded over-redaction for the leak it was guarding against.
  it.each([
    ["a tab-indented sequence entry", "\t- --tabbed=x"],
    ["a tab-indented plain line", "\tsomething: else"],
    ["a block scalar opened on a tab-indented entry", "\t- |"],
  ])(
    "redacts a deeper continuation of %s rather than passing it through",
    (_label, interruption) => {
      const out = scrubYamlText(
        [
          "spec:",
          "  containers:",
          "  - name: app",
          "    args:",
          interruption,
          `        ${LEAK}`,
          "    image: example/app:1.2.3",
        ].join("\n"),
      );

      expectNoLeak(out);
      expect(out).toContain("image: example/app:1.2.3");
    },
  );
});

/**
 * Where `swallowFrom` may be applied, and — more importantly — where it may not.
 *
 * Auditing the arms around the two the review named turned up three more that
 * set a threshold from a regex `(\s*)` capture, which measures a tab as length
 * 1 rather than 0. Applying the guard uniformly is the obvious move and it is
 * WRONG: returning `null` means "swallow nothing", so the following lines are
 * re-scanned, which is fail-closed only when the re-scan lands on a
 * default-redact arm.
 *
 * - `env:` and `command:`/`args:` open blocks whose default IS redact, so
 *   dropping the swallow downgrades a silent deletion of the rest of the spec
 *   into a visible per-line redaction. Strictly better: nothing leaks, and the
 *   structure survives instead of vanishing.
 * - `containers:` opens a block that merely gates argv and does not redact its
 *   own contents. Dropping its swallow leaks the wrapped remainder of a flow
 *   value — measured, not theorized. It keeps its raw threshold.
 *
 * The asymmetry is the rule. These tests exist so that a later "make it
 * consistent" cleanup fails loudly rather than reopening the leak.
 */
describe("scrubYamlText — a tab-indented block key fails closed, not open", () => {
  it("redacts the contents of a tab-indented `env:` flow key instead of deleting them", () => {
    const out = scrubYamlText(
      [
        "spec:",
        "  containers:",
        "  - name: app",
        `\tenv: [{name: A, value: ${LEAK}}]`,
        "    image: example/app:1.2.3",
        "    ports:",
        "    - containerPort: 8080",
      ].join("\n"),
    );

    expectNoLeak(out);
    // The lines survive as redactions rather than being swallowed wholesale.
    // Three input lines followed the key; three lines must still follow it.
    expect(out.trimEnd().split("\n")).toHaveLength(7);
  });

  it("redacts the contents of a tab-indented `args:` flow key instead of deleting them", () => {
    const out = scrubYamlText(
      [
        "spec:",
        "  containers:",
        "  - name: app",
        `\targs: [--token=${LEAK}]`,
        "    image: example/app:1.2.3",
        "    ports:",
        "    - containerPort: 8080",
      ].join("\n"),
    );

    expectNoLeak(out);
    expect(out.trimEnd().split("\n")).toHaveLength(7);
  });

  // The counter-example. `containers:` does not default-redact its body, so it
  // must keep swallowing — an over-swallow is the acceptable failure here and a
  // leak is not.
  it.each([
    ["a wrapped flow value", `      args: ["--token=${LEAK}"]}]`],
    ["a plain continuation", `      ${LEAK}`],
  ])(
    "does not emit %s after a tab-indented `containers:` key",
    (_label, continuation) => {
      expectNoLeak(
        scrubYamlText(
          [
            "spec:",
            "\tcontainers: [{name: c,",
            continuation,
            "  image: example/app:1.2.3",
          ].join("\n"),
        ),
      );
    },
  );
});
