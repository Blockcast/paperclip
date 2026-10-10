-- BLO-28635, sibling of 0221_repair_cross_company_issue_projects.sql.
-- A parent id is globally reference-valid but must also share the child's
-- company. Every read that follows parent_id is company-scoped, so a foreign
-- parent is inert for the owning company — except issueService.getAncestors,
-- which walked it unscoped and leaked the foreign ancestor's title,
-- description, assignee, project and goal through GET /issues/:id. That walk is
-- now scoped; this clears the pointers it used to follow.
UPDATE "issues" AS issue
SET "parent_id" = NULL
FROM "issues" AS parent
WHERE issue."parent_id" = parent."id"
  AND issue."company_id" <> parent."company_id";
