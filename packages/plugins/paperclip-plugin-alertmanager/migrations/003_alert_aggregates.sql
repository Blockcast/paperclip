CREATE TABLE alert_aggregates (
  aggregate_key text PRIMARY KEY,
  company_id text NOT NULL,
  paperclip_issue_id text,
  alertname text NOT NULL,
  severity text NOT NULL,
  assignee_user_id text,
  assignee_agent_id text,
  resolution_claim text,
  resolution_claimed_at timestamptz,
  final_resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alert_members (
  aggregate_key text NOT NULL REFERENCES alert_aggregates(aggregate_key) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  firing boolean NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_fired_at timestamptz NOT NULL,
  resolved_at timestamptz,
  PRIMARY KEY (aggregate_key, fingerprint)
);

CREATE INDEX alert_members_active_idx
  ON alert_members (aggregate_key)
  WHERE firing;
