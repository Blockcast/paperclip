CREATE TABLE IF NOT EXISTS plugin_alertmanager_184163d1ba.alertmanager_aggregate_creation_claims (
  company_id text NOT NULL,
  aggregate_key text NOT NULL,
  claim_token text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, aggregate_key)
);

CREATE TABLE IF NOT EXISTS plugin_alertmanager_184163d1ba.alertmanager_aggregate_members (
  company_id text NOT NULL,
  aggregate_key text NOT NULL,
  fingerprint text NOT NULL,
  issue_id text NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, aggregate_key, fingerprint)
);

CREATE INDEX IF NOT EXISTS alertmanager_aggregate_members_issue_unresolved_idx
  ON plugin_alertmanager_184163d1ba.alertmanager_aggregate_members (company_id, aggregate_key, issue_id)
  WHERE resolved_at IS NULL;
