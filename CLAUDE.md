# Claude Code Guidance

This repository is Paperclip, the open-source control plane for managing AI-agent companies.

## Read First

Before changing code, read these documents in order:

1. `AGENTS.md` for repository-wide contributor rules and architecture.
2. `doc/GOAL.md` and `doc/PRODUCT.md` for product intent.
3. `doc/SPEC-implementation.md` for the V1 implementation contract.
4. `doc/DEVELOPING.md` and `doc/DATABASE.md` when the change touches development or persistence.

`AGENTS.md` is the source of truth for commands, invariants, API/auth boundaries, pull-request requirements, and the fork-specific guidance. Do not duplicate or override it here.

## Repository Map

- `server/`: REST API and orchestration
- `ui/`: React/Vite board UI
- `packages/db/`: Drizzle schema, migrations, and database clients
- `packages/shared/`: shared types, validators, and API constants
- `packages/adapters/`: agent adapter implementations
- `doc/`: product, implementation, and operational documentation

## Change Discipline

Keep changes company-scoped and preserve the control-plane invariants in `AGENTS.md`, especially single-assignee checkout, approval gates, budget hard stops, and activity logging. When changing a contract, update every affected layer rather than relying on an implicit compatibility path.

Prefer the smallest relevant verification first. For broad or PR-ready changes, follow the full verification and pull-request checklist in `AGENTS.md`. Never expose credentials or weaken authorization checks to make a test or local workflow pass.
