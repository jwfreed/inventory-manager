# Manufacturing Report Production (Phase 2)

## No LINE_SIDE Policy (Current Decision)
- SIAMAYA does **not** model `LINE_SIDE` or line-staging locations in production.
- There is no `issue-to-line` or `return-from-line` workflow in the current system.
- `report-production` is backflush-only: component consumption must come from locations with `is_sellable = true` (today this is the warehouse `SELLABLE` default).
- This is enforced in schema + service guards and must fail loud if violated.

## Future Introduction (Deliberate Change Only)
- Adding `LINE_SIDE` requires an explicit project change, including:
  - schema migration(s) and role/location policy updates
  - new domain endpoints/workflows for issue-to-line and return-from-line
  - strict invariants + ops tests proving cost and inventory conservation
- Until those changes are merged, any line-side style role/workflow is intentionally unsupported.

## Report Production
- Endpoint: `POST /work-orders/:id/report-production`
- Purpose: backflush component consumption from BOM and receive finished goods into warehouse `QA`.
- Posting model (ledger-authoritative):
  - component issue movement (`issue`) for BOM consumptions
  - production receipt movement (`receive`) for finished output to `QA`
- Idempotency: `Idempotency-Key` header (and optional `idempotencyKey` body field) replays safely.
- Deterministic locking: advisory locks are acquired across all touched `(tenant, warehouse, item)` scopes before stock validation/posting.

## QC Convenience Endpoints
- `POST /qc/accept`: moves stock `QA -> SELLABLE` for one item/warehouse.
- `POST /qc/reject`: moves stock `QA -> HOLD` for one item/warehouse.
- Both routes call existing transfer posting logic (FIFO relocation in-transaction) and support idempotency.

## Exception Handling
- `POST /work-orders/:id/void-report-production`
  - Requires `workOrderExecutionId`, `reason`, and idempotency key.
  - Posts compensating ledger movements:
    - output reversal (`issue`) from QA
    - component return (`receive`) back to original issue locations
  - Fails loud with `WO_VOID_OUTPUT_ALREADY_MOVED` if produced output has already moved out of QA.
- `POST /work-orders/:id/report-scrap`
  - Posts a transfer `QA -> SCRAP` for the execution output item.
  - Uses the same transfer FIFO relocation path and keeps ATP unaffected (SCRAP is non-sellable).
  - Enforces per-execution QA availability before posting.
