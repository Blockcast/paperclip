-- A project id is globally reference-valid but must also share the issue's
-- company. Historical cross-company task fan-out bypassed that application
-- invariant, making the foreign project an authorization policy source.
UPDATE "issues" AS issue
SET "project_id" = NULL
FROM "projects" AS project
WHERE issue."project_id" = project."id"
  AND issue."company_id" <> project."company_id";
