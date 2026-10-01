-- BLO-36819: durable re-drive for the comment-review gate.
--
-- The gate evaluation runs on a void-detached promise after the webhook ack and
-- has exactly one caller, so a lost evaluation (fetch failure past its bounded
-- retries, refused status POST, or an API pod restart mid-flight) leaves the
-- last verdict standing forever. Marking an outbox row `reevaluate` lets the
-- existing delivery poller re-drive the evaluation itself rather than replay a
-- verdict it never computed.
alter table github_commit_status_deliveries
  add column if not exists reevaluate boolean not null default false;
