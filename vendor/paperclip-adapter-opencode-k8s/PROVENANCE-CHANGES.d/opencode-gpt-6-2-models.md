# Add openai/gpt-6.2-sol and openai/gpt-6.2-astra to the opencode_k8s model list

Files: `src/server/models.ts`, `src/server/models.test.ts`, `src/server/execute.test.ts`,
`package.json`, `package-lock.json`, `PROVENANCE.md`.

Adds the GPT-6.2 Sol and Astra rows to `STATIC_MODELS`, newest first, so they appear in the
`opencode_k8s` model picker and can be set on an agent. The existing `^gpt-6` context-window
pattern already covers both ids, so the model-aware compact threshold applies; `execute.test.ts`
now asserts it for them.

Pricing rows are deliberately NOT added to `OPENAI_PRICING_USD_PER_MTOK`: the 6.2 rates are not
known here. Per `pricing.ts`, a missing row only drops the cost line and cannot produce a negative
or wrong cost, whereas a guessed row would report wrong spend. Add them when the rates are published.

Same change was merged upstream as kkroo/paperclip-adapter-opencode-k8s#66; production builds this
vendored tree, so it is applied here as well. Version `0.2.8-blockcast.2` -> `0.2.8-blockcast.3`,
recorded in `package.json`, `package-lock.json` and the Origin table in `PROVENANCE.md`.
