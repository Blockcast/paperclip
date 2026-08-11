-- BLO-20649: `checkout` promotes an issue to `in_progress` on entry, but every
-- lock-release path clears only the execution-lock columns and leaves `status`
-- behind, so `in_progress` degrades into a high-water mark of every issue any
-- wake has ever touched.
--
-- Record the status the issue held immediately before checkout so a release that
-- did not advance the issue can put it back exactly (a `backlog` issue returns to
-- `backlog`, not `todo`). NULL means "no checkout-promotion to undo".
ALTER TABLE "issues" ADD COLUMN "checkout_restore_status" text;
