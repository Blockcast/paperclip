/**
 * Response scrubbing: strip secret material out of MCP tool results before
 * they reach the agent (PEN-2370).
 *
 * WHY THIS EXISTS
 *
 * `pods_get` and `resources_get` on the Kubernetes MCP servers return the full
 * resource, including `spec.containers[].env[].value`, in the clear. Any agent
 * holding the read-only k8s grant can read every other agent's pod, so one
 * read-only grant yields fleet-wide credentials. The reader cannot avoid it:
 * these tools have no field selector, so fetching a pod's image or phase — the
 * legitimate diagnostic use the grant exists for — returns the secrets anyway.
 * Correct, careful use causes the exposure.
 *
 * DESIGN CONSTRAINTS, each of which is load-bearing:
 *
 * 1. STRUCTURAL, NOT NAME-MATCHING. We redact *every* value inside an `env`
 *    block, whatever the variable is called. We deliberately do NOT match
 *    names against a `/(TOKEN|SECRET|KEY|PASSWORD|...)/i` fragment list: such a
 *    matcher falls through to the literal value for any name outside the list,
 *    so it is not default-deny and a credential named `SIGNING_MATERIAL` or
 *    `DSN` walks straight through. Redact everything; keep the names.
 *
 * 2. NAMES ARE PRESERVED. Knowing *which* variables are set is the diagnostic
 *    value of the grant. We return `value: "<redacted>"`, not a deleted key,
 *    and `valueFrom:` references (`secretKeyRef`, `configMapKeyRef`) are left
 *    intact — they name a source, they do not carry the material.
 *
 * 3. NO NEW DEPENDENCIES. This package ships `"dependencies": {}` on purpose:
 *    it is an unauthenticated-reachable proxy, and its supply chain is part of
 *    its threat model. So we do not pull in a YAML parser. The k8s MCP servers
 *    serialize resources as YAML text inside a JSON-RPC content block, so we
 *    walk that text with an indentation-aware scanner instead.
 *
 * 4. FAIL CLOSED. Where the scanner cannot confidently tell where a value ends
 *    (block scalars, wrapped plain/quoted scalars, flow mappings), it removes
 *    more rather than less — every line indented deeper than a redacted key is
 *    dropped, since it can only be a continuation of that value. A scrubber
 *    that guesses in the permissive direction is worse than none: emitting
 *    `value: "<redacted>"` above the plaintext manufactures false assurance.
 *
 *    Note that fail-closed substitution changes YAML *types*: `env:` becomes a
 *    string where a list was, and a dropped flow entry becomes a string where a
 *    mapping was. That is deliberate — a client that re-parses the scrubbed
 *    document may hit a type error rather than find a redaction marker, and a
 *    type error is the safe direction to fail in.
 *
 * 5. `Secret` IS COVERED, NOT JUST `env`. The same read-only grant serves
 *    `resources_get`/`resources_list` with an arbitrary `apiVersion`/`kind`, and
 *    a `v1 Secret` carries its material directly in `data` (base64) and
 *    `stringData` (plaintext). Scrubbing `pods_get` while leaving that path open
 *    would close the harder route and leave the easier one, so within a document
 *    whose `kind` is `Secret`/`SecretList` we redact both keys wholesale. Other
 *    kinds keep their `data` — a ConfigMap read stays fully diagnostic.
 *
 * 6. PASS-THROUGH IS BYTE-EXACT. When nothing was redacted we return the
 *    original Buffer rather than a re-serialized copy. This gateway also proxies
 *    the GitHub and Paperclip upstreams, where a diff or issue body mentioning
 *    `env:` is routine; re-stringifying those would silently round integers
 *    above 2^53 and rewrite `1.0` as `1`. Redaction still re-serializes — that
 *    cost is accepted only on bodies we actually had to change.
 *
 * SCOPE HONESTY: this closes the `env`-value and `Secret`-material paths on
 * responses that traverse this gateway. It is not a general secret detector, and
 * it does not by itself establish the fleet-wide invariant that agent-visible
 * tool output is systematically scrubbed — see PEN-2370 ask 3.
 *
 * Two paths through the same tools are known to be OUT of scope here, named so
 * that a reader does not mistake this module for covering them:
 *
 * - `spec.containers[].command` / `args`. A credential passed as `--token=…`
 *   rides the same `pods_get` response this module scrubs and is returned in the
 *   clear. Redacting argv wholesale would remove most of the diagnostic value of
 *   reading a pod, so it needs its own decision rather than a silent widening
 *   here.
 * - `ConfigMap` `data`. Deliberately preserved (see 5) because a ConfigMap read
 *   is a legitimate diagnostic; a ConfigMap used to carry a credential is
 *   therefore still exposed.
 *
 * Both are instances of ask 3's point: the invariant, not the instance.
 */

export const REDACTED = "<redacted>";

/**
 * Annotations whose value embeds a serialized copy of the whole resource, and
 * therefore a second copy of every env value in it.
 *
 * `kubectl.kubernetes.io/last-applied-configuration` is the one that matters:
 * kubectl writes the entire applied manifest into it as a single-line JSON
 * string. Redacting `env:` in the YAML body while leaving this annotation
 * intact would leak exactly what we just removed, one field further down the
 * same response. It is a client-side bookkeeping detail with little diagnostic
 * value, so we drop the value wholesale rather than try to rewrite JSON
 * embedded in a YAML scalar.
 */
const RESOURCE_ECHO_ANNOTATIONS = [
  "kubectl.kubernetes.io/last-applied-configuration",
];

/**
 * Cheap pre-filter for *decoded* strings.
 *
 * Used to decide whether to recurse into a string field that may itself hold a
 * serialized resource (`content[].text`, an annotation map). It is deliberately
 * NOT used to gate parsing of a whole response body: on a raw body a nested
 * JSON resource appears escaped (`\"env\":`), which matches neither an `env:`
 * nor an `"env"` probe, so gating on the raw bytes made the JSON path
 * unreachable from the only entry point the proxy uses. `scrubResponseBody`
 * dispatches on the body's *shape* instead and relies on this filter — which
 * only ever sees decoded strings — to keep the walk cheap.
 */
function mightContainSecrets(text: string): boolean {
  if (ENV_KEY_PROBE.test(text)) return true;
  if (SECRET_KIND_PROBE.test(text)) return true;
  return RESOURCE_ECHO_ANNOTATIONS.some((a) => text.includes(a));
}

/**
 * An `env` key in any of the spellings the scanners below accept: bare,
 * double-quoted, or single-quoted. A plain `includes("env:")` missed `'env':`
 * entirely, so a single-quoted resource nested in a text field was never even
 * scanned.
 *
 * Case-insensitive for the reason given at `isEnvKey`: Docker/OCI spells the key
 * `Env`. This probe gates whether a nested string is scanned at all, so leaving
 * it case-sensitive meant an OCI-shaped resource carried in `content[].text` was
 * never handed to a scanner — a fail-open one step before any redaction rule.
 */
const ENV_KEY_PROBE = /(^|[^A-Za-z0-9_])(["']?)env\2\s*:/i;

/**
 * A `Secret`/`SecretList` document, in YAML or JSON spelling. Needed because a
 * Secret body contains no `env` key at all — the pre-filter did not trip on one
 * before, so `resources_get kind=Secret` was never scanned.
 *
 * Case-insensitive for the same reason as `ENV_KEY_PROBE`: this decides whether
 * a body is scanned at all, so a non-canonical `kind` spelling here skipped
 * every downstream Secret rule rather than just one of them.
 */
const SECRET_KIND_PROBE = /(["']?)kind\1\s*:\s*(["']?)Secret(List)?\2(\s|,|}|$)/i;

function leadingIndent(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === " ") i += 1;
  return i;
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/**
 * True when `line` still belongs to the `env:` block that opened at
 * `blockIndent`.
 *
 * YAML permits a sequence to sit at the same indentation as the key that owns
 * it, which is exactly how kubectl renders env:
 *
 *     env:
 *     - name: A
 *       value: B
 *
 * so "indent <= blockIndent ends the block" would terminate it immediately, on
 * the first entry. A line at the block indent continues the block only when it
 * opens a sequence entry; anything else at that indent or shallower is a
 * sibling key and ends it.
 */
function continuesBlock(line: string, blockIndent: number): boolean {
  if (isBlank(line)) return true;
  const indent = leadingIndent(line);
  if (indent > blockIndent) return true;
  if (indent < blockIndent) return false;
  return line.slice(indent).startsWith("- ");
}

/**
 * Matches a `value:` key, optionally as the first key of a sequence entry.
 *
 * The key name may be quoted. YAML allows `"value": x` and `'value': x`, and
 * both reached the plaintext before this was accounted for — the same quoting
 * allowance `ECHO_ANNOTATION_KEY` already made.
 */
const VALUE_KEY = /^(\s*)(-\s+)?(["']?)value\3:(.*)$/;
/** Matches a sequence entry whose content opens a flow mapping or sequence. */
const FLOW_SEQUENCE_ENTRY = /^(\s*)(-\s+)[{[]/;
/**
 * Matches an `env:` key, whatever follows it.
 *
 * This was two patterns — one for a block-opening `env:` and one for an inline
 * value — and two patterns have to be tested in some order. Both matched
 * `env: # vars`, the inline one was tested first, and because its suffix was
 * neither `[` nor `{` the line was emitted *without opening the block*: every
 * `value:` line below it then missed the in-block guard and printed in the
 * clear. The same held for `env: &anchor` and `env: !!seq`.
 *
 * One pattern that matches every spelling, with the suffix classified after the
 * match, removes the ordering from the design rather than reordering it.
 *
 * Case-insensitive to agree with `isEnvKey`, which the JSON path uses. The two
 * paths disagreeing about what counts as an env key is itself a fail-open: every
 * non-lowercase spelling (`Env`, the Docker/OCI one) was redacted on the JSON
 * path and emitted in the clear on this one, at every entry shape.
 */
const ENV_KEY = /^(\s*)(-\s+)?(["']?)env\3:(.*)$/i;
/**
 * Leading YAML node properties: an anchor (`&name`) and/or a tag (`!!seq`).
 * These *label* a node without carrying its content, so an `env:` line whose
 * suffix is nothing but properties still opens a block below it.
 */
const NODE_PROPERTIES = /^(?:[&!]\S*[ \t]*)+/;
/** A comment-only line. */
const COMMENT_LINE = /^\s*#/;
/**
 * Keys that may pass through an env block untouched: the variable's `name` (the
 * diagnostic the grant exists for) and `valueFrom`, which names a source
 * without carrying it.
 */
const NAME_KEY = /^(\s*)(-\s+)?(["']?)name\3:(.*)$/;
const VALUE_FROM_KEY = /^(\s*)(-\s+)?(["']?)valueFrom\3:(.*)$/;
/**
 * The keys a `valueFrom` subtree may legally contain — the four `EnvVarSource`
 * selectors and their scalar leaves. Enumerating them is not the denylist this
 * module argues against: `EnvVarSource` is closed by the Kubernetes schema, so
 * this is the same closed-allowlist argument the env block itself rests on, and
 * `value` is deliberately absent from it.
 */
const REF_SUBTREE_KEY = new RegExp(
  `^(\\s*)(-\\s+)?(["']?)(${[
    "configMapKeyRef",
    "fieldRef",
    "resourceFieldRef",
    "secretKeyRef",
    "name",
    "key",
    "optional",
    "apiVersion",
    "fieldPath",
    "containerName",
    "resource",
    "divisor",
  ].join("|")})\\3:(.*)$`,
);
/** A sequence entry's `- ` introducer, and a dash with nothing after it. */
const SEQUENCE_DASH = /^\s*(-\s+)/;
const BARE_SEQUENCE_DASH = /^\s*-\s*$/;
/**
 * The OCI/Docker `KEY=VALUE` env entry shape. The name is kept and only the
 * value dropped, matching design note 2 and the JSON path.
 */
const ENV_KEY_VALUE_ENTRY = /^(\s*)(-\s+)(["']?)([A-Za-z_][A-Za-z0-9_.-]*)=/;
/**
 * An `env:` scalar that can carry material: a flow collection, an alias (which
 * may resolve to an anchor we never scrubbed), a block scalar, or the
 * `KEY=VALUE` encoding. A plain scalar without `=` is prose in some other
 * body this proxy carries, not a Kubernetes env value.
 */
const MATERIAL_BEARING_ENV_SCALAR = /^[[{*|>]|=/;
/**
 * Kubernetes spells this key `env`; Docker/OCI spells it `Env` (`Config.Env`).
 * The scalar-entry handling below exists precisely because `KEY=VALUE` is the
 * OCI/Docker env encoding, so recognizing that encoding while missing the key
 * that carries it would leave the shape half-covered.
 */
function isEnvKey(key: string): boolean {
  return key.toLowerCase() === "env";
}
/** Matches an annotation key we drop wholesale. */
const ECHO_ANNOTATION_KEY = new RegExp(
  `^(\\s*)(-\\s+)?(["']?)(${RESOURCE_ECHO_ANNOTATIONS.map(escapeRegExp).join("|")})\\3:(.*)$`,
);
/**
 * Matches the `data:`/`stringData:` key of a Secret, block or inline. Only
 * consulted inside a document already identified as a Secret, so a ConfigMap's
 * `data` is untouched.
 */
const SECRET_DATA_KEY = /^(\s*)(-\s+)?(["']?)(data|stringData)\3:(.*)$/i;
/** A YAML document separator. */
const DOC_SEPARATOR = /^---(\s|$)/;
/** A `kind: Secret` / `kind: SecretList` line. */
const SECRET_KIND_LINE = /^\s*(-\s+)?(["']?)kind\2:\s*(["']?)Secret(List)?\3\s*(#.*)?$/i;

/**
 * Names whose value is the Secret's material, in the JSON shape.
 *
 * Compared case-insensitively, via `isSecretMaterialKey`/`isSecretKind` below,
 * for the same reason `isEnvKey` is: a case-sensitive literal that gates
 * *whether material is scanned at all* fails open on every other spelling.
 * This gate gave up strictly more than the env one did — a Secret's `data` is
 * pure credential material, where an env block at least keeps its names as the
 * diagnostic payload. Measured before the change: `Kind: Secret`, `kind: secret`
 * and `Data:` each emitted the Secret's material verbatim, while the canonical
 * `kind: Secret` + `data:` redacted, so the mechanism worked and only the
 * spelling defeated it.
 */
const SECRET_MATERIAL_KEYS = new Set(["data", "stringdata"]);
const SECRET_KINDS = new Set(["secret", "secretlist"]);

function isSecretMaterialKey(key: string): boolean {
  return SECRET_MATERIAL_KEYS.has(key.toLowerCase());
}

function isSecretKind(kind: unknown): boolean {
  return typeof kind === "string" && SECRET_KINDS.has(kind.toLowerCase());
}

/**
 * The `kind` key itself, found without assuming its case. `source.kind` is an
 * exact-property lookup, so a `Kind`-spelled document was never even a
 * candidate for the Secret branch.
 */
function readKind(source: Record<string, unknown>): unknown {
  for (const [key, value] of Object.entries(source)) {
    if (key.toLowerCase() === "kind") return value;
  }
  return undefined;
}

/** Threaded through the scrubbers so a pure pass-through can be detected. */
type ScrubContext = { changed: boolean };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Flag every line belonging to a document whose `kind` is `Secret`.
 *
 * This needs a pass of its own because the key order works against a streaming
 * scanner: Kubernetes serializes fields alphabetically, so `data:` arrives
 * *before* `kind: Secret`. A single forward pass would have to redact `data`
 * before it could know the document was a Secret.
 */
function markSecretDocuments(lines: string[]): boolean[] {
  const flags = new Array<boolean>(lines.length).fill(false);
  let start = 0;

  const finish = (end: number): void => {
    let isSecret = false;
    for (let i = start; i < end; i += 1) {
      if (SECRET_KIND_LINE.test(lines[i]!)) {
        isSecret = true;
        break;
      }
    }
    if (isSecret) for (let i = start; i < end; i += 1) flags[i] = true;
  };

  for (let i = 0; i < lines.length; i += 1) {
    if (DOC_SEPARATOR.test(lines[i]!)) {
      finish(i);
      start = i + 1;
    }
  }
  finish(lines.length);
  return flags;
}

/**
 * Redact env values in a YAML-serialized Kubernetes resource.
 *
 * Operates line by line, tracking the indentation of any open `env:` block.
 * Only `value:` keys *inside* such a block are touched, so the rest of the
 * spec — images, phases, restart counts, resource limits — survives intact.
 */
export function scrubYamlText(text: string): string {
  return scrubYamlTextTracked(text, { changed: false });
}

function scrubYamlTextTracked(text: string, ctx: ScrubContext): string {
  // Split so that each line's own terminator is preserved and re-emitted. A
  // plain `split("\n")` left a trailing `\r` glued to the line content, and
  // since `.` does not match `\r` and these patterns are not `/m`-flagged,
  // `value: SECRET\r` failed to match while `env:\r` still matched (its `\s*`
  // absorbed the `\r`). The block was entered and every value line inside it
  // was then emitted verbatim — a silent fail-open on any CRLF upstream. A lone
  // `\r` is a YAML line break too, so it is split on as well.
  const parts = text.split(/(\r\n|\n|\r)/);
  const lines: string[] = [];
  const seps: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    lines.push(parts[i]!);
    seps.push(parts[i + 1] ?? "");
  }

  const secretDoc = markSecretDocuments(lines);
  const out: string[] = [];

  // Indentation of the currently open `env:` block, or null when outside one.
  let envBlockIndent: number | null = null;
  // Indentation of an open `valueFrom:` key inside that block. Its subtree is
  // references only, so it passes through the in-block allowlist in full.
  let refSubtreeIndent: number | null = null;
  // While set, we are swallowing the continuation lines of a value we already
  // replaced; every line indented deeper than this belongs to that value.
  let swallowDeeperThan: number | null = null;

  const emit = (content: string, index: number): void => {
    out.push(content + seps[index]!);
  };
  const redact = (content: string, index: number): void => {
    ctx.changed = true;
    emit(content, index);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    if (swallowDeeperThan !== null) {
      if (isBlank(line) || leadingIndent(line) > swallowDeeperThan) {
        // Part of the block scalar we already replaced. Drop it.
        continue;
      }
      swallowDeeperThan = null;
    }

    if (envBlockIndent !== null && !continuesBlock(line, envBlockIndent)) {
      envBlockIndent = null;
      refSubtreeIndent = null;
    }

    // Inside a `valueFrom:` subtree. Its keys are references, but the subtree
    // is NOT a hole in the in-block default: an unrecognized key here is
    // redacted exactly as it would be one level up. Passing the whole subtree
    // through unclassified was measurably worse than the code it replaced —
    // `valueFrom:` / `value: <secret>` is redacted by the plain in-block
    // scanner, so a blanket pass-through re-opened a case that was already
    // closed. Deeper lines are classified, not trusted.
    if (refSubtreeIndent !== null) {
      if (!isBlank(line) && leadingIndent(line) > refSubtreeIndent) {
        if (COMMENT_LINE.test(line) || REF_SUBTREE_KEY.test(line)) {
          emit(line, index);
          continue;
        }
        const indent = leadingIndent(line);
        const dash = SEQUENCE_DASH.exec(line)?.[1] ?? "";
        redact(`${" ".repeat(indent)}${dash}"${REDACTED}"`, index);
        swallowDeeperThan = indent + dash.length;
        continue;
      }
      refSubtreeIndent = null;
    }

    // Drop annotations that echo the entire resource (and thus its env values).
    const echo = ECHO_ANNOTATION_KEY.exec(line);
    if (echo) {
      const [, indent, dash = "", quote, key] = echo;
      redact(`${indent}${dash}${quote}${key}${quote}: "${REDACTED}"`, index);
      // Same reasoning as `value:` below: any deeper-indented line that follows
      // is a continuation of this scalar, never a sibling annotation, so drop it
      // whatever style it was written in.
      swallowDeeperThan = leadingIndent(line) + (dash?.length ?? 0);
      continue;
    }

    // A Secret carries its material in `data`/`stringData` rather than in an
    // `env` block, so it needs its own key. Redacting the whole subtree rather
    // than each entry is the fail-closed choice and costs no diagnostics: unlike
    // env, where the *names* are the diagnostic value, a Secret's keys are
    // already visible in the pods that mount it.
    if (secretDoc[index]) {
      const secretData = SECRET_DATA_KEY.exec(line);
      if (secretData) {
        const [, indent, dash = "", quote, key] = secretData;
        redact(`${indent}${dash}${quote}${key}${quote}: "${REDACTED}"`, index);
        swallowDeeperThan = indent!.length + dash.length;
        continue;
      }
    }

    // Any `env:` key, in a single branch, tested before the in-block scanner so
    // that a nested one still opens its own block rather than being treated as
    // unrecognized content.
    const envKey = ENV_KEY.exec(line);
    if (envKey) {
      const [, indent, dash = "", quote, suffix] = envKey;
      const ownIndent = indent!.length + dash.length;
      // Strip anchors and tags before classifying: they label the node that
      // follows, so `env: &shared` and `env: !!seq` open a block exactly as a
      // bare `env:` does. Trim first — the suffix keeps the space after the
      // colon, and an anchored pattern will not match past it.
      const rest = suffix!.trim().replace(NODE_PROPERTIES, "").trim();
      if (rest === "" || rest.startsWith("#")) {
        emit(line, index);
        envBlockIndent = ownIndent;
        refSubtreeIndent = null;
        continue;
      }
      // A plain scalar with no `=` in it is not a Kubernetes env value —
      // `env` is a list there, never a scalar — so it is prose in a body this
      // proxy happens to carry, and redacting it is a net loss. Not a stylistic
      // point: redaction sets `ctx.changed`, which re-serializes the *whole*
      // body, and `JSON.stringify` rounds integers above 2^53 and normalizes
      // `1.0`. Failing closed here measurably corrupted
      // `{"nodeId":9007199254740993,"ratio":1.0,"note":"env: none here"}`.
      // So the fail-closed net is cast at the shapes that can actually carry
      // material: flow collections, aliases (which may resolve to one), block
      // scalars, and the `KEY=VALUE` encoding.
      if (!MATERIAL_BEARING_ENV_SCALAR.test(rest)) {
        emit(line, index);
        continue;
      }
      // Fail closed on the whole value and swallow any continuation of it — and
      // open the block as well, so that if content does follow (a shape we did
      // not anticipate) it is still guarded rather than emitted in the clear.
      redact(`${indent}${dash}${quote}env${quote}: "${REDACTED}"`, index);
      swallowDeeperThan = ownIndent;
      envBlockIndent = ownIndent;
      refSubtreeIndent = null;
      continue;
    }

    if (envBlockIndent !== null) {
      // Inside an env block the default is to REDACT, not to emit.
      //
      // Every fail-open this module has had was a line that reached the final
      // `emit(line)` because it matched no redact pattern: a CRLF-terminated
      // `value:`, a quoted key spelling, a `KEY=VALUE` scalar entry. A denylist
      // has to enumerate every spelling secret material can take, and the
      // enumeration is never finished. An allowlist only has to enumerate the
      // three keys a Kubernetes env entry can legally carry, and that list is
      // closed by the schema. Anything else in here is an upstream shape change
      // or an attempt to smuggle material past the scanner; both are safer
      // redacted than emitted.
      //
      // Blank lines and comments carry nothing and keep the output readable.
      if (isBlank(line) || COMMENT_LINE.test(line)) {
        emit(line, index);
        continue;
      }

      // `valueFrom:` names a source — a ConfigMap/Secret key, a field path —
      // without carrying its content, so the key itself passes through. What
      // follows it is classified against `REF_SUBTREE_KEY` rather than trusted
      // wholesale; see the subtree branch above for why.
      const ref = VALUE_FROM_KEY.exec(line);
      if (ref) {
        emit(line, index);
        refSubtreeIndent = leadingIndent(line) + (ref[2]?.length ?? 0);
        continue;
      }

      // The variable's name is the diagnostic value the grant exists for:
      // knowing *which* variables are set, without their values.
      if (NAME_KEY.test(line) || BARE_SEQUENCE_DASH.test(line)) {
        emit(line, index);
        continue;
      }

      const value = VALUE_KEY.exec(line);
      if (value) {
        const [, indent, dash = "", quote] = value;
        redact(`${indent}${dash}${quote}value${quote}: "${REDACTED}"`, index);
        // Swallow every following line indented deeper than this key, whatever
        // scalar style produced it. `value: |` is the obvious case, but a plain
        // or quoted scalar wraps across lines too — kubectl's serializer folds
        // long values at spaces — and a deeper-indented line after `value:` can
        // only be a continuation of it. A sibling key (`valueFrom:`) sits at the
        // *same* indent, so it survives.
        //
        // Restricting this to `|`/`>` was a real leak: we printed
        // `value: "<redacted>"` and then the plaintext on the next line, which
        // is worse than not scrubbing at all because the marker manufactures
        // false assurance.
        swallowDeeperThan = indent!.length + dash.length;
        continue;
      }

      // A sequence entry that opens a flow mapping (`- {name: A, value: B}`).
      // The value sits inside a construct we do not parse, so fail closed and
      // drop the entry rather than pass the literal through. Rare from
      // kubectl's serializer, which emits block style, but this scanner runs on
      // whatever the upstream sends, not on what we expect it to send.
      const flowEntry = FLOW_SEQUENCE_ENTRY.exec(line);
      if (flowEntry) {
        const [, indent, dash] = flowEntry;
        redact(`${indent}${dash}"${REDACTED}"`, index);
        swallowDeeperThan = indent!.length + dash!.length;
        continue;
      }

      // Unrecognized inside an env block: fail closed. `- A=LEAKED` — the
      // OCI/Docker `KEY=VALUE` shape — lands here, as does any spelling not yet
      // imagined. Keep the variable name when the entry has the `KEY=` shape.
      const indent = leadingIndent(line);
      const dash = SEQUENCE_DASH.exec(line)?.[1] ?? "";
      const keyValue = ENV_KEY_VALUE_ENTRY.exec(line);
      const replacement = keyValue
        ? `${" ".repeat(indent)}${dash}"${keyValue[4]}=${REDACTED}"`
        : `${" ".repeat(indent)}${dash}"${REDACTED}"`;
      redact(replacement, index);
      swallowDeeperThan = indent + dash.length;
      continue;
    }

    emit(line, index);
  }

  return out.join("");
}

/**
 * Redact env values in a structurally-parsed JSON resource.
 *
 * The k8s MCP servers currently emit YAML, but the format is theirs to change
 * and other upstreams may return JSON directly. Handling both means a server
 * upgrade cannot silently turn this scrubber into a no-op.
 */
export function scrubJsonValue(node: unknown): unknown {
  return scrubJsonValueTracked(node, { changed: false }, false);
}

function scrubJsonValueTracked(node: unknown, ctx: ScrubContext, inSecret: boolean): unknown {
  if (Array.isArray(node)) return node.map((n) => scrubJsonValueTracked(n, ctx, inSecret));
  if (!node || typeof node !== "object") return node;

  const source = node as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  // A `SecretList`'s items usually carry no `kind` of their own, so the flag has
  // to descend rather than be re-derived at each level.
  const kind = readKind(source);
  const nowSecret = inSecret || isSecretKind(kind);

  for (const [key, value] of Object.entries(source)) {
    if (nowSecret && isSecretMaterialKey(key)) {
      result[key] = REDACTED;
      ctx.changed = true;
      continue;
    }
    if (isEnvKey(key) && Array.isArray(value)) {
      result[key] = value.map((entry) => {
        if (entry === null || entry === undefined) return entry;
        // `KEY=VALUE` is the OCI/Docker env shape, and the generic recursion
        // returned it untouched: a scalar is not an object, so the `value`
        // lookup below never ran. This is the same hole the mapping case was
        // added for — the JSON path exists so an upstream shape change cannot
        // silently turn the scrubber into a no-op, and a shape it passes through
        // in the clear defeats that. Keep the name, drop the material.
        if (typeof entry === "string") {
          ctx.changed = true;
          const eq = entry.indexOf("=");
          return eq > 0 ? `${entry.slice(0, eq)}=${REDACTED}` : REDACTED;
        }
        // A nested array (`[["A", "LEAKED"]]`) or any other non-object entry
        // carries no name we can identify, so there is nothing to preserve.
        if (typeof entry !== "object" || Array.isArray(entry)) {
          ctx.changed = true;
          return REDACTED;
        }
        const envVar = entry as Record<string, unknown>;
        // Preserve `name` and any `valueFrom` reference; drop only the literal.
        if (!("value" in envVar)) return envVar;
        ctx.changed = true;
        return { ...envVar, value: REDACTED };
      });
      continue;
    }
    // An `env` that is a *mapping* rather than a list. Kubernetes never
    // serializes env this way, but the JSON path exists precisely so that an
    // upstream changing its shape cannot silently turn this scrubber into a
    // no-op, and the generic recursion below carries no "inside an env block"
    // state — so a mapping fell through it with every value in the clear. Redact
    // the values and keep the names, matching the list case and design note 2.
    if (isEnvKey(key) && value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      result[key] = Object.fromEntries(
        entries.map(([name, inner]) => [
          name,
          // A nested object here is a `valueFrom`-shaped reference, which names a
          // source without carrying it; anything scalar is the material itself.
          inner && typeof inner === "object"
            ? scrubJsonValueTracked(inner, ctx, nowSecret)
            : REDACTED,
        ]),
      );
      if (entries.some(([, inner]) => !inner || typeof inner !== "object")) ctx.changed = true;
      continue;
    }
    if (RESOURCE_ECHO_ANNOTATIONS.includes(key) && typeof value === "string") {
      result[key] = REDACTED;
      ctx.changed = true;
      continue;
    }
    // An `env` serialized as a single scalar rather than a list or a mapping.
    // Same discriminator as the YAML path: `KEY=VALUE` carries material, a
    // plain string does not and belongs to some other body this proxy carries.
    if (isEnvKey(key) && typeof value === "string" && value.includes("=")) {
      ctx.changed = true;
      const eq = value.indexOf("=");
      result[key] = `${value.slice(0, eq)}=${REDACTED}`;
      continue;
    }
    if (typeof value === "string") {
      // Resource echoes also appear as YAML/JSON text nested in string fields
      // (annotation maps, `content[].text`). Recurse into the text.
      result[key] = mightContainSecrets(value) ? scrubTextTracked(value, ctx) : value;
      continue;
    }
    result[key] = scrubJsonValueTracked(value, ctx, nowSecret);
  }

  return result;
}

/**
 * Scrub a text payload that may be YAML, JSON, or several YAML documents.
 */
export function scrubText(text: string): string {
  return scrubTextTracked(text, { changed: false });
}

function scrubTextTracked(text: string, ctx: ScrubContext): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      const nested: ScrubContext = { changed: false };
      const scrubbed = JSON.stringify(scrubJsonValueTracked(parsed, nested, false));
      if (nested.changed) {
        ctx.changed = true;
        return scrubbed;
      }
      // Nothing to redact in this nested document. Return the original text so a
      // pass-through stays byte-exact rather than being silently re-serialized.
      return text;
    } catch {
      // Not valid JSON after all — fall through to the YAML scanner, which
      // degrades gracefully on arbitrary text.
    }
  }
  return scrubYamlTextTracked(text, ctx);
}

/**
 * Scrub a full MCP response body.
 *
 * Handles both plain JSON-RPC bodies and SSE framing (`event:`/`data:` lines),
 * which is how the streamable-HTTP MCP transport delivers most tool results.
 * Anything we cannot parse is returned unchanged: this is a proxy, and a
 * scrubber that corrupts unrelated traffic is a worse failure than one that
 * misses a body we did not recognize. The formats we *do* recognize are the
 * ones that carry k8s resources.
 *
 * Dispatch is on the body's *shape*, not on a content probe. Probing the raw
 * bytes for `env:`/`"env"` skipped any body whose resource arrived as JSON
 * nested in `content[].text`, because there the key is escaped (`\"env\":`) and
 * matches neither form — which made the entire JSON path dead code from this
 * entry point. The per-string filter inside the walk sees decoded strings and is
 * sound, so that is where the cheap check belongs.
 */
export function scrubResponseBody(body: Buffer, contentType?: string | null): Buffer {
  const isSse = (contentType ?? "").includes("text/event-stream") || startsWithSseField(body);
  if (!isSse && !startsWithJsonPunctuation(body)) return body;

  const text = body.toString("utf8");
  const ctx: ScrubContext = { changed: false };
  const scrubbed = isSse ? scrubSseFrames(text, ctx) : scrubJsonRpcBody(text, ctx);

  // Returning the original Buffer — not a re-serialized equal-looking one — is
  // what keeps pass-through byte-exact. `JSON.parse`/`JSON.stringify` is lossy
  // for integers above 2^53 and normalizes `1.0` to `1`, and this gateway also
  // proxies GitHub and Paperclip bodies that legitimately mention `env:`.
  if (scrubbed === null || !ctx.changed) return body;
  return Buffer.from(scrubbed, "utf8");
}

/** First non-whitespace byte is `{` or `[`, checked without allocating. */
function startsWithJsonPunctuation(body: Buffer): boolean {
  for (const byte of body) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    return byte === 0x7b /* { */ || byte === 0x5b /* [ */;
  }
  return false;
}

/**
 * Body opens an SSE field line, checked on the Buffer.
 *
 * This sniff is the fallback for when the upstream omits `content-type`, so it
 * has to cover every field an event stream may legally open on — not just the
 * two we expect. A stream that opened on `id:`, `retry:` or a `:` comment line
 * was classified as neither SSE nor JSON, and `scrubResponseBody` returns such
 * bodies unchanged: the whole stream, including its `data:` payloads, passed
 * through unscrubbed.
 *
 * Widening this is safe in the other direction. A non-SSE body that happens to
 * open on one of these tokens still has no `data:` lines for `scrubSseFrames`
 * to rewrite, so it comes back unchanged and `ctx.changed` stays false — which
 * returns the original Buffer byte-for-byte.
 */
const SSE_FIELD_HEAD = /^(?:event|data|id|retry):|^:/;

/**
 * The window is 8 bytes: `retry:` already consumes six, and skipping leading
 * bytes below shifts the field name later in the buffer.
 */
function startsWithSseField(body: Buffer): boolean {
  let start = 0;
  // The SSE spec requires a client to strip one leading BOM, so a stream that
  // carries one is well-formed, not malformed.
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) start = 3;
  // And a leading blank line is an empty event dispatch. Neither shifted the
  // field name out of an anchored 6-byte window before this: the sniff missed,
  // the JSON sniff saw `e`, and the whole stream — `data:` payloads included —
  // was returned unscrubbed. `startsWithJsonPunctuation` already skips
  // whitespace, and that asymmetry was the entire gap.
  while (start < body.length) {
    const byte = body[start]!;
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) start += 1;
    else break;
  }
  return SSE_FIELD_HEAD.test(body.subarray(start, start + 8).toString("latin1"));
}

function scrubJsonRpcBody(text: string, ctx: ScrubContext): string | null {
  try {
    return JSON.stringify(scrubJsonValueTracked(JSON.parse(text), ctx, false));
  } catch {
    return null;
  }
}

/**
 * Rewrite the JSON payload of each SSE `data:` line, preserving framing.
 *
 * SSE payloads may be split across consecutive `data:` lines that concatenate
 * into one JSON document, so we buffer a run of them and scrub the join. Blank
 * lines terminate an event and are emitted verbatim to keep the stream valid.
 *
 * Note that a buffered run is re-emitted as a *single* `data:` line, joined with
 * `""`. The SSE spec joins multi-line data with `"\n"`, so this is only
 * equivalent because the payloads here are JSON, where whitespace between tokens
 * is insignificant. Do not reuse this helper for a non-JSON `data:` stream.
 *
 * Line splitting accepts CRLF, LF *and* a lone CR, because all three terminate a
 * line in an event stream. Splitting on `"\n"` alone made a CR-only stream a
 * single unsplit line, so no line ever began with `data:`, nothing was scrubbed,
 * and the body passed through with its payloads in the clear. This is the same
 * fail-open class as the CRLF hole in `scrubYamlTextTracked` — fixing that one
 * scanner's line handling and leaving this one's is how the class survives a
 * fix. Terminators are normalized to LF, which only ever reaches the client on a
 * body we actually redacted; an untouched body is returned as the original
 * Buffer.
 *
 * The field match tolerates a leading BOM and indentation for the same reason.
 * Teaching only the *sniff* to skip those bytes moved the fail-open one step
 * down rather than closing it: the body was then correctly classified as SSE,
 * but `"﻿data: …"` does not start with `data:`, so the payload was emitted
 * in the clear anyway. Detection and framing have to agree about where a line
 * begins.
 */
const SSE_DATA_FIELD = /^[﻿\s]*data:/;

function scrubSseFrames(text: string, ctx: ScrubContext): string {
  const out: string[] = [];
  let pending: string[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    const joined = pending.join("");
    const scrubbed = scrubJsonRpcBody(joined, ctx);
    out.push(`data: ${scrubbed ?? joined}`);
    pending = [];
  };

  for (const line of text.split(/\r\n|\n|\r/)) {
    const field = SSE_DATA_FIELD.exec(line);
    if (field) {
      pending.push(line.slice(field[0].length).trimStart());
      continue;
    }
    flush();
    out.push(line);
  }
  flush();

  return out.join("\n");
}
