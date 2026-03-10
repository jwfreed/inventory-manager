# Safe Repo Change Prompt

Use this prompt when asking an AI agent to change repository structure, tooling, or documentation.

```
Audit the repository first. Do not change business logic, ledger mutation rules, database schema, or core services.

Preserve these invariants:
- inventory_movements is authoritative
- inventory_movement_lines stores deltas
- ledger is append-only
- replay and hashing must remain deterministic
- multi-step mutations must stay inside withTransaction(...) or withTransactionRetry(...)
- ledger inserts must stay inside createInventoryMovement(...) and createInventoryMovementLine(...)

Only implement repository-level improvements:
- docs
- CI
- test tiering
- AI guardrails
- editor tooling

Before finalizing, report exactly what changed and what verification ran.
```
