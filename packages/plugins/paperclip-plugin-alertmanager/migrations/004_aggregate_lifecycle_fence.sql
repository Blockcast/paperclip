CREATE TABLE IF NOT EXISTS plugin_alertmanager_184163d1ba.alertmanager_aggregate_lifecycle_fences (
  company_id text NOT NULL,
  aggregate_key text NOT NULL,
  phase text NOT NULL DEFAULT 'active',
  firing_token text,
  resolution_token text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, aggregate_key)
);
