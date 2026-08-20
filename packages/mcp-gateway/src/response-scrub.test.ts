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
