# Kimi Code subscription provider (`penstock-kimi`) through Penstock

Files: `src/server/job-manifest.ts`, `src/server/job-manifest.test.ts`.

`providerConfig()` now also writes a `penstock-kimi` provider into the runtime `opencode.json`
(both the no-MCP and the MCP/Secret path), so an agent whose model is `penstock-kimi/<id>`
(`kimi-for-coding`, `kimi-for-coding-highspeed`, `k3`, `k3-256k`, `k3.1-pro`, `k3.1-pro-highspeed`)
can use a Kimi Code (kimi.ai) subscription held by a Penstock vault node.

- SDK `@ai-sdk/openai-compatible`; `baseURL` is `{env:OPENAI_BASE_URL}/providers/kimi/coding/v1`
  (Penstock's custom-provider relay, `/v1/providers/<id>/<upstream path>`), `apiKey` is
  `{env:OPENAI_API_KEY}` (the Penstock org key every Job already holds). The Kimi key itself never
  leaves the vault node.
- Host and key are NOT configurable from adapterConfig: a config-supplied `baseURL` would let an
  agent editor aim the org key at an arbitrary host. Pinned by a test that tries to.
- Inert for every other agent: opencode only uses a provider the model names.
- Needs a vault node that registers custom provider `kimi` (host api.kimi.ai or api.kimi.com depending on the account, bearer) and holds
  a Kimi Code API key; Penstock treats custom traffic as passthrough (no usage parser or 429 pacing).
- Model ids from the `kimi-code-plan-global` entry on models.dev; context windows are the live `/models` values from a global (kimi.ai) subscription, and every model sets `temperature: false` because Kimi rejects any temperature other than 1.
