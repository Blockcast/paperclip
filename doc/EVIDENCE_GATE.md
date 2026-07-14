# Evidence Gate Operations

Transitions into `in_review` are rejected with HTTP 422 when required artifact evidence is missing. The response identifies the missing evidence shapes:

```json
{"error":"missing-evidence","missing":["test-output","checklist:done-when"]}
```

An operator can authorize a time-limited exception by adding a user-authored issue comment in this exact form:

```text
evidence-gate: override <reason>
```

The comment must be less than one hour old when the transition is attempted. Agent-authored comments, empty reasons, future timestamps, and expired comments are ignored. A successful override is recorded in `lastEvidenceVerdict` with `overridden: true` and `overrideReason`, and those fields are included in the server audit log. The gate only runs when entering `in_review`; updates to an issue already in review are grandfathered.
