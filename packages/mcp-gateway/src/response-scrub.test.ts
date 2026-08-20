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
});
