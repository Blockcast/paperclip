-- Restart-safety for the aggregate lifecycle fence (BLO-31036).
--
-- The fence is claimed before a firing delivery mutates member state and
-- released in that delivery's `finally`. Nothing between the claim and the
-- `try` can throw, so an *exception* can never wedge it — only death of the
-- owning process between claim and release can, which is exactly what a
-- rollout does. Those fences then refuse every later firing for that
-- aggregate forever, and the only drain was an operator-only recovery route
-- that needs the dead process's token.
--
-- These two columns record *who* holds the fence, so a release can be
-- justified by the owner's provable death rather than by elapsed time. A
-- TTL/lease steal is explicitly rejected by the design comment in
-- `beginAggregateFiring`: a merely-slow owner could resume and attach a member
-- after a newer resolver had begun the terminal transition. Identity closes
-- that race instead of reopening it, because a process that has been replaced
-- cannot resume.
--
--   owner_instance_id — random per-*process* id, minted once at worker module
--                       load. All concurrent deliveries inside one worker
--                       process share it, so they can never steal each other's
--                       fences (the intra-process interleaving is real: the RPC
--                       layer pipelines `handleWebhook` calls into the single
--                       worker child).
--   owner_slot        — the worker's pod name (`HOSTNAME`). Ownership is only
--                       ever stolen within the *same* slot, so the release
--                       rests on the Kubernetes StatefulSet guarantee that
--                       ordinal 0 is recreated only after the previous pod has
--                       fully terminated — not on the api-tier plugin stub
--                       being configured correctly. A process in a different
--                       slot is never assumed dead.
--
-- Both are nullable: rows written before this migration carry NULL, and the
-- one-shot startup reconciliation treats a NULL owner as an owner that
-- predates instance fencing (necessarily an older image, therefore replaced).
ALTER TABLE plugin_alertmanager_184163d1ba.alertmanager_aggregate_lifecycle_fences
  ADD COLUMN IF NOT EXISTS owner_instance_id text;

ALTER TABLE plugin_alertmanager_184163d1ba.alertmanager_aggregate_lifecycle_fences
  ADD COLUMN IF NOT EXISTS owner_slot text;

-- Supports the startup reconciliation sweep, which scans held fences across
-- every company rather than by primary key.
CREATE INDEX IF NOT EXISTS alertmanager_aggregate_fences_held_phase_idx
  ON plugin_alertmanager_184163d1ba.alertmanager_aggregate_lifecycle_fences (phase)
  WHERE phase IN ('firing', 'cancelling');
