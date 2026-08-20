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
