-- BLO-16120: durable, race-safe membership + resolution state for batched
-- alert escalation covers. Replaces the prior model where a cover was owned
-- only by the winning source alert (originId) and losing siblings existed
-- only as free-form comments — that made cascade cleanup on resolve blind to
-- still-firing siblings and gave the sweep nothing durable to retry against.
--
-- plugin_alertmanager_184163d1ba = derivePluginDatabaseNamespace(
--   "paperclip-plugin-alertmanager", "alertmanager"
-- ) — deterministic from the plugin id + namespaceSlug in manifest.ts.

CREATE TABLE plugin_alertmanager_184163d1ba.alert_escalation_covers (
  cover_issue_id uuid PRIMARY KEY REFERENCES public.issues(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  dedup_fingerprint text NOT NULL,
  -- Doubles as the atomic claim marker for "who gets to post the resolution
  -- audit comment": claimed via a single UPDATE ... WHERE resolution_comment_posted_at
  -- IS NULL AND NOT EXISTS (unresolved members), so exactly one concurrent
  -- caller wins the claim under real Postgres row-level locking.
  resolution_comment_posted_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX alert_escalation_covers_company_idx
  ON plugin_alertmanager_184163d1ba.alert_escalation_covers (company_id);

-- Backstop for the sweep's reconciliation pass: covers whose comment claim
-- succeeded but whose terminal transition never completed (crash/failure
-- between the two steps) — durable retry work, scanned via an index instead
-- of the free-form comment parsing the old cleanup path relied on.
CREATE INDEX alert_escalation_covers_pending_finalize_idx
  ON plugin_alertmanager_184163d1ba.alert_escalation_covers (cover_issue_id)
  WHERE resolution_comment_posted_at IS NOT NULL AND cancelled_at IS NULL;

CREATE TABLE plugin_alertmanager_184163d1ba.alert_escalation_cover_members (
  id uuid PRIMARY KEY,
  cover_issue_id uuid NOT NULL REFERENCES plugin_alertmanager_184163d1ba.alert_escalation_covers(cover_issue_id) ON DELETE CASCADE,
  alert_issue_id uuid NOT NULL REFERENCES public.issues(id) ON DELETE CASCADE,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Idempotency arbiter for join-or-attach: a second attach attempt for the
  -- same (cover, alert) is a no-op INSERT ... ON CONFLICT DO NOTHING instead
  -- of a duplicate membership row or duplicate sibling comment.
  UNIQUE (cover_issue_id, alert_issue_id)
);

-- Cascade-cleanup lookup: "which cover(s) does this resolving alert belong
-- to" without listing/paginating through Paperclip issues at all.
CREATE INDEX alert_escalation_cover_members_alert_idx
  ON plugin_alertmanager_184163d1ba.alert_escalation_cover_members (alert_issue_id);

-- "Are there any unresolved members left for this cover" — the predicate the
-- atomic claim UPDATE evaluates; keep it cheap regardless of how many
-- resolved (historical) members a long-lived cover has accumulated.
CREATE INDEX alert_escalation_cover_members_open_idx
  ON plugin_alertmanager_184163d1ba.alert_escalation_cover_members (cover_issue_id)
  WHERE resolved_at IS NULL;
