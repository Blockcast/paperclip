CREATE TABLE plugin_alertmanager_184163d1ba.alert_aggregates (
  company_id text NOT NULL,
  aggregate_key text NOT NULL,
  paperclip_issue_id text,
  alertname text NOT NULL,
  severity text NOT NULL,
  assignee_user_id text,
  assignee_agent_id text,
  resolution_claim text,
  resolution_claimed_at timestamptz,
  generation bigint NOT NULL DEFAULT 0,
  resolution_generation bigint,
  active_fingerprints text[] NOT NULL DEFAULT '{}',
  final_resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, aggregate_key)
);

CREATE TABLE plugin_alertmanager_184163d1ba.alert_members (
  company_id text NOT NULL,
  aggregate_key text NOT NULL,
  fingerprint text NOT NULL,
  firing boolean NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_fired_at timestamptz NOT NULL,
  resolved_at timestamptz,
  PRIMARY KEY (company_id, aggregate_key, fingerprint),
  FOREIGN KEY (company_id, aggregate_key)
    REFERENCES plugin_alertmanager_184163d1ba.alert_aggregates(company_id, aggregate_key) ON DELETE CASCADE
);

CREATE INDEX alert_members_active_idx
  ON plugin_alertmanager_184163d1ba.alert_members (company_id, aggregate_key)
  WHERE firing;
