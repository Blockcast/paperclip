# Dependabot Webhook Receipts

Paperclip accepts GitHub `dependabot_alert` deliveries at
`https://paperclip.blockcast.net/api/webhooks/github`. The route verifies
`X-Hub-Signature-256` with `GITHUB_WEBHOOK_SECRET` before processing payloads.

For `Blockcast/magma`, repository webhook `626142749` must remain active and
subscribed to `dependabot_alert`. Do not replace its URL or secret when changing
the event list. The Paperclip deployment routes alerts to the agent configured
by `PAPERCLIP_DEPENDABOT_AGENT_ID`.

Actions `created`, `reintroduced`, and `reopened` create or reuse one scoped
Paperclip remediation issue per repository and alert number. Actions `fixed`,
`dismissed`, and `auto_dismissed` add a system comment beginning with
`[github-dependabot-receipt]` and close that issue. If Paperclip did not receive
the opening action, the terminal delivery creates a closed receipt issue so the
evidence is not lost.

The receipt records the repository, alert number and URL, terminal action, and
GitHub delivery ID. QA may cite that comment as the permitted terminal-state
evidence path. The evidence comes entirely from the signed webhook payload; do
not call the Dependabot Alerts REST or GraphQL APIs to corroborate it.

To inspect delivery health without reading alert state, use the repository hook
delivery log and confirm the delivery received HTTP 200. A replay of the same
GitHub delivery is deduplicated by its delivery ID and does not add another
receipt comment.
