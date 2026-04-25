# Test Suite Realignment Report

## Audit Summary

| Category | Outcome |
| --- | --- |
| Category A: obsolete architecture tests | No active failing tests in this slice still asserted nullable hashes, post-write hash mutation, mutable ledger rows, or projections as authority. No deletions were required. |
| Category B: contract drift | Rewritten around current contracts: deterministic movement hashes, session bootstrapping with durable tenant membership, current transfer gate naming, and receipt seed UOM canonicalization. |
| Category C: real regressions | Preserved as failures: `tests/ops/negative-stock.test.mjs`, `tests/ops/receipt-void-reversal.test.mjs`, `tests/ops/transfer-cost-relocation.test.mjs`, and downstream `tests/ops/go-live-gates*.test.mjs` when the receipt-void gate is exercised. |
| Category D: weak or brittle tests | Repaired by removing teardown double-close behavior, replacing stale fixture SQL with current-schema-compatible helpers, and centralizing legacy ledger fixture creation. |

## Modified Test Disposition

| Test name | Category | Action | Reason | Replacement |
| --- | --- | --- | --- | --- |
| `GET /uoms returns canonical registry list` | D | Rewritten via shared session helper | Unique-tenant API setup drifted after bootstrap hardening and no longer guaranteed membership creation. | Same test, now running through `ensureSession()` with DB-backed tenant membership fallback. |
| `POST /uoms/convert supports preview and rejects cross-dimension conversion` | D | Rewritten via shared session helper | Same bootstrap/session drift as above. | Same test. |
| `PATCH /items/:id/uom updates stock UOM policy and applies registry enforcement when enabled` | D | Rewritten via shared session helper | Same bootstrap/session drift as above. | Same test. |
| `POST /uoms/convert returns actionable unknown UOM context when enforcement is enabled` | D | Rewritten via shared session helper | Same bootstrap/session drift as above. | Same test. |
| `inventory adjustment validation rejects blank uom with UOM_REQUIRED` | D | Rewritten via shared session helper | Same bootstrap/session drift as above. | Same test. |
| `receive/transfer movements require source_type and source_id` | B | Rewritten | The legacy fixture failed on `movement_deterministic_hash NOT NULL` before reaching the intended source metadata constraint. | Same test, now using a current-schema-compatible movement hash fixture. |
| `inventory_balance and inventory_movement_lines reject blank and whitespace uom` | B | Rewritten | The parent movement fixture assumed pre-hardening nullable hashes. | Same test, now anchored to a valid posted movement fixture. |
| `snapshot summary aggregates mixed convertible UOM rows when stock UOM is configured` | B | Rewritten | Legacy ledger fixture inserts omitted deterministic hashes. | Same test, now using a centralized current-schema-compatible legacy ledger fixture helper. |
| `snapshot normalization keeps analytics precision before final output rounding` | B | Rewritten | Legacy ledger fixture inserts omitted deterministic hashes. | Same test. |
| `snapshot summary keeps watch diagnostics when legacy fallback conversion is used` | B | Rewritten | Legacy ledger fixture inserts omitted deterministic hashes. | Same test. |
| `snapshot summary fails conservative when any row is non-convertible` | B | Rewritten | Legacy ledger fixture inserts omitted deterministic hashes. | Same test. |
| `negative_on_hand check detects negative ledger position and strict mode fails loudly` | D | Rewritten | The corruption fixture inserted legacy movement rows that now violate hash constraints before the invariant check runs. | Same test, now using a centralized corruption fixture helper. |
| `Phase 5 go-live readiness gates enforce production checklist behaviors` | B | Rewritten | The representative transfer subprocess assertion still referenced the retired test title. | Same test, updated to the current transfer contract output. |
| `siamaya_factory seed with receipts in clean mode is deterministic and idempotent` | B | Rewritten | The receipt seed path still posted `piece` even though the current mutation contract expects canonical `each` for those factory items. | Same test, now seeded through canonicalized receipt UOMs. |
| `partial_then_close_short mode remains deterministic and closes residual PO lines explicitly` | B | Rewritten | Same receipt seed UOM drift as above. | Same test. |
| `auditMovementHashCoverage reports universal hash gaps and replay failures without transitional tolerances` | D | Rewritten | The file carried duplicated raw movement insert SQL. | Same test, now using the shared movement fixture helper. |
| `inventory_movements rejects NULL deterministic hashes at schema level` | D | Rewritten | The file carried duplicated raw movement insert SQL. | Same test, now using the shared movement fixture helper with explicit `NULL` hash override. |
| `inventory transfer idempotency: replay and payload conflict stay deterministic without HTTP` | D | Rewritten | The file carried duplicated raw movement insert SQL for replay fixtures. | Same test, now using the shared movement fixture helper. |
| `inventory transfer schema rejects missing hashes and replay fails closed on mismatches` | D | Rewritten | The file carried duplicated raw movement insert SQL for replay fixtures. | Same test, now using the shared movement fixture helper with explicit hash overrides. |
| `inventory_movements store deterministic hashes under a NOT NULL schema contract` | B | Rewritten | The old test name and fixture path overfit the internal `persistInventoryMovement()` implementation. | Same contract, renamed and re-centered on the public schema guarantee. |
| `movement_deterministic_hash remains immutable after insert` | D | Rewritten | The file relied on an internal ledger writer fixture. | Same test, now using the shared movement fixture helper. |
| `ledger tables reject UPDATE/DELETE and remain insertable` | D | Rewritten | The file carried duplicated raw movement insert SQL. | Same test, now using the shared movement fixture helper. |

## Harness Changes

| Subject | Category | Action | Reason |
| --- | --- | --- | --- |
| `tests/ops/atp-concurrency-hardening.test.mjs` file teardown | D | Rewritten | Local teardown closed pools already closed by `tests/setup.mjs`, which produced `Called end on pool more than once`. |
| `tests/helpers/movementFixture.mjs` | D | Added | Centralizes current-schema-compatible movement fixtures so legacy ledger-state tests stop depending on stale insert shapes. |
| `tests/api/helpers/ensureSession.mjs` | D | Rewritten | API tests now recover tenant membership deterministically when bootstrap does not provision it. |

## Remaining Category C Failures

| Test name | Why it remains |
| --- | --- |
| `posting work order issue and batch blocks on insufficient usable stock` | Still returns `500` from canonical availability resolution instead of the contract `409`. |
| `posting negative inventory adjustment blocks on insufficient stock` | Still returns `500` from canonical availability resolution instead of the contract `409`. |
| `voiding a receipt posts an exact reversal and remains idempotent under concurrency` | Still returns `500` and logs `INVENTORY_EVENT_AGGREGATE_ID_REQUIRED:movementId` on the receipt-void replay path. |
| `concurrent shipment posting cannot over-consume a single FIFO layer` | Still returns `500` on the hardened shipment availability path. |
| `go-live summaries publish stable gate shapes and tenant pinning` | Downstream failure only; it shells into the go-live gate suite and currently inherits the receipt-void regression. |
