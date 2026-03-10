# Test Tier Change Prompt

Use this prompt when changing tests, manifests, or CI workflows.

```
Preserve the repository test contract:
- truth = invariant-only checks
- contracts = representative mutation-family tests
- scenarios = heavy workflows

Do not move a test between tiers without explaining why.
Do not remove truth coverage for ledger immutability, migration lint, idempotency, or invariant drift.
Do not add CI commands that are not backed by npm scripts.

Update all of the following together when needed:
- package.json scripts
- tests/*/manifest.json
- .github/workflows/*
- docs/runbooks/ci.md
- CONTRIBUTING.md
```
