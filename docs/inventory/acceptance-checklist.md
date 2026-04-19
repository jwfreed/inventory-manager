# Acceptance Checklist

> Testable PASS/FAIL criteria for inventory system correctness.
> Every item is binary: it either passes or fails. No partial credit.

---

## How to Use

1. Run each criterion as a test or manual verification
2. Mark PASS or FAIL
3. Any FAIL blocks acceptance of the related change
4. All items must PASS before a change is considered complete

---

## 1. Transfer Correctness

### T-1: Zero-Sum Balance

**Test:** Post a transfer between two locations. Sum of on_hand across both locations before and after must be equal.

**PASS:** `Σ on_hand (before) = Σ on_hand (after)` for the transferred item across source + destination.

**FAIL:** Any difference in total on_hand.

### T-2: Source Decrement

**Test:** Post a transfer of quantity Q from location A to location B.

**PASS:** `on_hand(A, after) = on_hand(A, before) - Q`

**FAIL:** Source balance does not decrease by exactly Q.

### T-3: Destination Increment

**Test:** Post a transfer of quantity Q from location A to location B.

**PASS:** `on_hand(B, after) = on_hand(B, before) + Q`

**FAIL:** Destination balance does not increase by exactly Q.

### T-4: Movement Line Count

**Test:** Post a transfer.

**PASS:** Exactly 2 movement lines exist: one with negative delta (source), one with positive delta (destination). Absolute values are equal.

**FAIL:** Fewer or more than 2 lines, or deltas do not balance.

### T-5: Same-Location Rejection

**Test:** Attempt a transfer where source = destination.

**PASS:** Error `TRANSFER_SAME_LOCATION` returned. No movement created.

**FAIL:** Transfer succeeds or different error.

### T-6: Cross-Warehouse Rejection

**Test:** Attempt a transfer between locations in different warehouses.

**PASS:** Error `TRANSFER_CROSS_WAREHOUSE_NOT_ALLOWED` returned. No movement created.

**FAIL:** Transfer succeeds.

### T-7: Transfer Void Reversal

**Test:** Post a transfer, then void it.

**PASS:** Reversal movement exists. Original has `reversed_by_movement_id`. Source and destination balances return to pre-transfer state. Cost layers returned.

**FAIL:** Balances do not restore, or reversal movement missing.

### T-8: Transfer Void Consumed Destination

**Test:** Post a transfer, consume destination inventory (e.g., shipment), then attempt void.

**PASS:** Void rejected because destination cost layers are consumed.

**FAIL:** Void succeeds despite consumed inventory.

### T-9: Transfer FIFO Lot Chain

**Test:** Post a transfer of inventory with a known lot. Verify destination inventory unit inherits the lot.

**PASS:** Destination inventory unit has the same lot_key as the consumed source unit.

**FAIL:** Lot chain broken.

---

## 2. QC Correctness

### Q-1: QC Accept Creates Transfer

**Test:** Post a receipt to QA location. Accept via QC.

**PASS:** Transfer movement exists from QA to accept location. Receipt allocation status = AVAILABLE.

**FAIL:** No transfer movement, or allocation still in QA status.

### Q-2: QC Hold Creates Transfer

**Test:** Post a receipt to QA location. Hold via QC.

**PASS:** Transfer movement exists from QA to hold location. Receipt allocation status = HOLD. Reason code = `qc_hold`.

**FAIL:** No transfer, wrong allocation status, or wrong reason code.

### Q-3: QC Reject Creates Transfer + NCR

**Test:** Post a receipt to QA location. Reject via QC.

**PASS:** Transfer movement exists from QA to reject location. NCR record created. Reason code = `qc_reject`.

**FAIL:** Missing transfer, NCR, or wrong reason code.

### Q-4: Partial Acceptance Quantity Tracking

**Test:** Post a receipt for 100 units. Accept 60, hold 30, reject 10.

**PASS:** Three QC events exist. Cumulative = 100 (equals received). No further QC events accepted.

**FAIL:** Cumulative ≠ 100, or additional QC events allowed beyond total.

### Q-5: QC Exceeds Quantity Rejection

**Test:** Post a receipt for 50 units. Attempt to accept 60 units.

**PASS:** Error `QC_EXCEEDS_RECEIPT` returned. No transfer created.

**FAIL:** Accept succeeds for 60 units.

### Q-6: QC Blocks Allocation

**Test:** Post a receipt. Verify that inventory at QA location cannot be allocated.

**PASS:** Reservation attempt fails or returns zero available. Inventory at QA not included in ATP.

**FAIL:** Inventory at QA is allocatable.

### Q-7: QC Blocks Putaway

**Test:** Post a receipt. Attempt putaway before QC accept.

**PASS:** Error `PUTAWAY_BLOCKED` returned. No transfer created.

**FAIL:** Putaway succeeds while inventory is still in QA.

### Q-8: QC Accept Enables Putaway

**Test:** Post a receipt, accept via QC, then putaway.

**PASS:** Putaway succeeds. Inventory at final storage location. Allocation status reflects new location.

**FAIL:** Putaway fails after acceptance, or inventory not at storage location.

### Q-9: QC Source Location Validation

**Test:** Attempt QC accept from a non-QA location.

**PASS:** Error `QC_SOURCE_MUST_BE_QA` returned.

**FAIL:** QC action succeeds from non-QA location.

### Q-10: QC Destination Validation

**Test:** Attempt QC accept to a non-sellable location.

**PASS:** Error `QC_ACCEPT_REQUIRES_SELLABLE_ROLE` or `QC_ACCEPT_REQUIRES_SELLABLE_FLAG` returned.

**FAIL:** Accept routes to non-sellable location.

### Q-11: QC Hold Re-Evaluation to Accept

**Test:** Post receipt, hold via QC, then accept from hold location.

**PASS:** Transfer from hold to accept location. Inventory state = available.

**FAIL:** Re-evaluation fails or creates wrong transfer.

### Q-12: Receipt Void After Partial QC

**Test:** Post receipt for 100 units, accept 50, then attempt void.

**PASS:** Void blocked if putaways exist. If no putaways, void reverses full receipt.

**FAIL:** Void succeeds with putaways, or void creates inconsistent state.

---

## 3. Work Order Correctness

### W-1: Issue Decrements Source

**Test:** Post WO issue for component quantity Q from location L.

**PASS:** `on_hand(L, after) = on_hand(L, before) - Q`. Issue movement exists with negative delta.

**FAIL:** Balance does not decrease by Q.

### W-2: Completion Increments Output

**Test:** Post WO completion for output quantity Q to location L.

**PASS:** `on_hand(L, after) = on_hand(L, before) + Q`. Receive movement exists with positive delta.

**FAIL:** Balance does not increase by Q.

### W-3: Issue Before Completion Required

**Test:** Post WO completion without prior issue.

**PASS:** Error `WO_WIP_COST_NO_CONSUMPTIONS` returned. No receive movement created.

**FAIL:** Completion succeeds without components issued.

### W-4: WIP Cost Flow

**Test:** Issue components (cost $100), complete output.

**PASS:** Output cost layer = $100 (sum of consumed component costs). WIP layers allocated.

**FAIL:** Output cost ≠ sum of consumed costs.

### W-5: WIP Proportional Allocation

**Test:** Issue components (cost $120), complete 2 output lines: 40 units + 80 units.

**PASS:** Line 1 cost ≈ $40 (40/120 × $120). Line 2 cost ≈ $80 (80/120 × $120). Remainder on final line.

**FAIL:** Cost allocation not proportional.

### W-6: Partial Production Status

**Test:** WO planned for 100 units. Complete 50.

**PASS:** WO status = `partially_completed`. Progress = 50%.

**FAIL:** Status is `completed` or `in_progress`.

### W-7: Over-Production Status

**Test:** WO planned for 100 units. Complete 120.

**PASS:** WO status = `completed`.

**FAIL:** Error on over-production.

### W-8: Void Returns Components

**Test:** Post issue + completion. Void the execution.

**PASS:** Components returned to original locations. Output removed from QA. Original movements have `reversed_by_movement_id`. Reversal movements exist.

**FAIL:** Components not returned, output not removed, or missing reversal linkage.

### W-9: Void Blocked After QC Accept

**Test:** Post completion, accept output via QC, then attempt void.

**PASS:** Error `WO_VOID_OUTPUT_NOT_QA` returned. No reversal.

**FAIL:** Void succeeds after output has been accepted.

### W-10: Void Blocked After Putaway

**Test:** Post completion, accept via QC, putaway, then attempt void.

**PASS:** Error `WO_VOID_OUTPUT_NOT_QA` returned.

**FAIL:** Void succeeds after putaway.

### W-11: Batch Record Atomicity

**Test:** Post batch record (consume + produce). Verify both movements exist.

**PASS:** Issue movement and receive movement both exist in same transaction. Single idempotency key covers both.

**FAIL:** Only one movement exists, or different transactions.

### W-12: Disassembly Input Validation

**Test:** Attempt disassembly with input item ≠ WO disassembly item.

**PASS:** Error `WO_DISASSEMBLY_INPUT_MISMATCH` returned.

**FAIL:** Disassembly proceeds with wrong input.

---

## 4. Cross-Workflow Interaction Correctness

### X-1: Receipt → QC → Putaway → Ship

**Test:** Execute full inbound-to-outbound flow.

**PASS:** Receipt creates inventory at QA. QC accept moves to sellable. Putaway moves to storage. Shipment issues from storage. All movements traceable. Cost chain: receipt → putaway → shipment.

**FAIL:** Any step fails or breaks traceability.

### X-2: Receipt → QC → WO Issue → WO Completion → Ship

**Test:** Execute inbound → manufacturing → outbound flow.

**PASS:** Raw material received, QC'd, issued to WO, output produced, shipped. Cost chain: receipt → WO issue → WO completion → shipment.

**FAIL:** Any step fails or cost chain breaks.

### X-3: QC Hold Does Not Leak to Allocation

**Test:** Receipt posted. Partial QC: 50 accepted, 50 held. Create reservation.

**PASS:** Only 50 units available for reservation (the accepted units). Held units excluded from ATP.

**FAIL:** Held units included in available quantity.

### X-4: Transfer Does Not Affect Allocation

**Test:** Allocate inventory at location A. Transfer other inventory from location A to B.

**PASS:** Allocated quantity unchanged. Transfer only moves non-allocated inventory.

**FAIL:** Allocated quantity affected by transfer.

### X-5: Count After Shipment

**Test:** Ship 10 units from a location. Run cycle count at that location.

**PASS:** System on-hand reflects post-shipment quantity. Count records actual physical quantity. Variance = physical - system (post-shipment).

**FAIL:** System on-hand does not reflect shipment.

### X-6: WO Void After Partial Ship

**Test:** Produce output, QC accept, ship partial, attempt void.

**PASS:** Void blocked because output is no longer at QA (it was accepted and partially shipped).

**FAIL:** Void succeeds after acceptance.

### X-7: Concurrent Receipts Same Item

**Test:** Two concurrent receipts for the same item at the same warehouse.

**PASS:** Both succeed. Balances reflect sum of both receipts. No duplicate movements. ATP locks serialize the balance updates.

**FAIL:** Deadlock, missing receipt, or incorrect balance.

### X-8: Return Creates Fresh Inventory

**Test:** Ship inventory, then post a return receipt.

**PASS:** Return creates new receive movement (not a reversal of shipment). New cost layer created. Inventory at return QA location. Original shipment unchanged.

**FAIL:** Return modifies original shipment or reuses cost layers.

---

## 5. Replay Correctness

### R-1: Idempotent Receipt

**Test:** Post same receipt with same idempotency key twice.

**PASS:** Second call returns same result as first. Only one movement in ledger. `replayed: true` on second call.

**FAIL:** Duplicate movement, or different result.

### R-2: Idempotent Transfer

**Test:** Post same transfer with same idempotency key twice.

**PASS:** Second call returns same movement ID. No duplicate lines. Balances unchanged on replay.

**FAIL:** Duplicate movement or balance change.

### R-3: Idempotent WO Execution

**Test:** Post same WO issue with same idempotency key twice.

**PASS:** Second call returns cached result. No duplicate issue movement. WIP cost unchanged.

**FAIL:** Duplicate issue or WIP double-counted.

### R-4: Idempotent Count Post

**Test:** Post same count with same idempotency key twice.

**PASS:** Second call returns cached result. No duplicate adjustment movement.

**FAIL:** Duplicate adjustment or double variance.

### R-5: Idempotent Shipment Post

**Test:** Post same shipment with same idempotency key twice.

**PASS:** Second call returns cached result. No duplicate issue movement. Reservation not double-fulfilled.

**FAIL:** Duplicate movement or double fulfillment.

### R-6: Deterministic Hash Stability

**Test:** Create a movement, compute its deterministic hash. Replay the same inputs.

**PASS:** Hash on replay matches original hash exactly.

**FAIL:** Different hash on replay → `REPLAY_CORRUPTION_DETECTED`.

### R-7: Key Reuse Cross-Endpoint

**Test:** Use same idempotency key for a receipt and then a transfer.

**PASS:** Second call returns `IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS` (409).

**FAIL:** Second call succeeds.

### R-8: Key Reuse Different Payload

**Test:** Use same idempotency key for a receipt with quantity 10, then again with quantity 20.

**PASS:** Second call returns `IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD` (409).

**FAIL:** Second call succeeds with modified payload.

### R-9: Concurrent First Execution

**Test:** Two simultaneous requests with the same idempotency key (first execution, not replay).

**PASS:** One succeeds, the other gets `IDEMPOTENCY_REQUEST_IN_PROGRESS` (409). The failing request can retry.

**FAIL:** Both succeed, or data corruption.

### R-10: Inventory Unit Rebuild Consistency

**Test:** Run `rebuildInventoryUnitsFromEvents()` and compare with current `inventory_units` state.

**PASS:** Rebuilt state matches current state for every unit (record_quantity, state, location, lot_key).

**FAIL:** Any divergence between rebuilt and current state.

---

## 6. Concurrency Safety

### C-1: ATP Lock Serialization

**Test:** Two concurrent reservations for the same item at the same warehouse. Available = 100. Each requests 80.

**PASS:** First succeeds (80 reserved). Second fails with `ATP_INSUFFICIENT_AVAILABLE` (only 20 remaining). Total reserved never exceeds 100.

**FAIL:** Both succeed (160 reserved > 100 available).

### C-2: ATP Lock Deadlock Prevention

**Test:** Two concurrent transactions locking items A and B in different orders.

**PASS:** No deadlock. Locks are always acquired in sorted (key1, key2) order.

**FAIL:** Deadlock detected by PostgreSQL.

### C-3: Serializable Retry

**Test:** Concurrent shipment posts that trigger serialization failures.

**PASS:** Failed transactions retry with exponential backoff. Eventually succeed if stock is sufficient. Retry count ≤ `ATP_SHIPMENT_POST_RETRIES`.

**FAIL:** Transaction abandoned without retry, or infinite retry loop.

### C-4: Concurrent QC on Same Receipt

**Test:** Two QC accept events on the same receipt, same item, at the same time.

**PASS:** Serialized by ATP lock. First succeeds. Second sees updated allocation state. Total accepted ≤ received.

**FAIL:** Both succeed for full quantity (over-acceptance).

### C-5: Concurrent WO Issue + Void

**Test:** Concurrent issue post and void for the same work order.

**PASS:** Serialized by ATP locks. Operations execute sequentially. Final state is consistent.

**FAIL:** Data corruption or inconsistent WIP state.

### C-6: Lock Target Limit

**Test:** Attempt operation requiring > 5000 lock targets.

**PASS:** Error `ATP_LOCK_TARGETS_TOO_MANY` returned. No locks acquired.

**FAIL:** Operation proceeds with > 5000 locks.

---

## 7. Idempotency Correctness

### I-1: Every Ledger Mutation Has Idempotency Key

**Test:** Audit all command paths through `runInventoryCommand()`.

**PASS:** Every call provides `idempotencyKey` and `requestHash`. No mutation path skips idempotency.

**FAIL:** Any mutation path lacks idempotency key.

### I-2: Idempotency Finalization on Success

**Test:** Post a receipt. Check `transactional_idempotency_keys` table.

**PASS:** Row exists with `status` = 200/201, `response_body` contains result.

**FAIL:** Row missing or status = -1 (in-progress).

### I-3: Idempotency Rollback on Failure

**Test:** Post a receipt that fails validation.

**PASS:** No idempotency key row persisted (transaction rolled back).

**FAIL:** Stale in-progress row left behind.

### I-4: Request Hash Canonicalization

**Test:** Post same request with keys in different JSON order.

**PASS:** Same request hash produced. Replay detected.

**FAIL:** Different hash → treated as different payload.

---

## 8. Ledger Immutability

### L-1: No Movement Updates

**Test:** Attempt to UPDATE a row in `inventory_movements`.

**PASS:** UPDATE blocked by application constraints (only `reversed_by_movement_id` can be set, and only once).

**FAIL:** Arbitrary column updates succeed.

### L-2: No Movement Line Updates

**Test:** Attempt to UPDATE a row in `inventory_movement_lines`.

**PASS:** UPDATE fails.

**FAIL:** Update succeeds.

### L-3: No Movement Deletes

**Test:** Attempt to DELETE from `inventory_movements`.

**PASS:** DELETE fails.

**FAIL:** Delete succeeds.

### L-4: No Unit Event Updates

**Test:** Attempt to UPDATE a row in `inventory_unit_events`.

**PASS:** UPDATE fails (immutability trigger: `prevent_ledger_mutation`).

**FAIL:** Update succeeds.

### L-5: No Unit Event Deletes

**Test:** Attempt to DELETE from `inventory_unit_events`.

**PASS:** DELETE fails (immutability trigger: `prevent_ledger_mutation`).

**FAIL:** Delete succeeds.

### L-6: Write Boundary Enforcement

**Test:** Run `npm run lint:inventory-writes`.

**PASS:** No violations. All inventory_movement/inventory_movement_line writes go through `ledgerWriter.ts`.

**FAIL:** Any write detected outside `ledgerWriter.ts`.

---

## 9. Projection Consistency

### P-1: Balance Matches Ledger

**Test:** For a given (tenant, item, location, uom), sum all `quantity_delta` from `inventory_movement_lines`.

**PASS:** Sum matches `inventory_balance.on_hand` for that scope.

**FAIL:** Divergence between ledger sum and balance projection.

### P-2: Unit Rebuild Matches Projection

**Test:** Run `rebuildInventoryUnitsFromEvents()` for a scope.

**PASS:** Rebuilt units match current `inventory_units` rows.

**FAIL:** Any divergence.

### P-3: Balance Non-Negative (Default)

**Test:** Query all `inventory_balance` rows.

**PASS:** All `on_hand >= 0`, `reserved >= 0`, `allocated >= 0` (unless override was used).

**FAIL:** Negative balance without explicit override.

---

## 10. Cost Layer Integrity

### CL-1: Receipt Creates Cost Layer

**Test:** Post a receipt.

**PASS:** Cost layer exists for each receipt line with matching quantity and unit cost.

**FAIL:** Missing cost layer.

### CL-2: FIFO Consumption Order

**Test:** Receive 10 @ $5, then 10 @ $8. Ship 10.

**PASS:** Cost consumption takes the first layer ($5). Second layer ($8) remains.

**FAIL:** Wrong layer consumed.

### CL-3: Transfer Relocates Cost Layer

**Test:** Transfer inventory from location A to B.

**PASS:** Cost layers at location B. No cost layers at location A for transferred quantity.

**FAIL:** Cost layers not relocated.

### CL-4: Void Restores Cost Layer

**Test:** Void a transfer or receipt.

**PASS:** Original cost layers restored. Voided cost layers marked.

**FAIL:** Cost layers not restored.

---

## Verification Summary Template

```
| # | Criterion | Status | Notes |
|---|-----------|--------|-------|
| T-1 | Transfer zero-sum | PASS/FAIL | |
| T-2 | Source decrement | PASS/FAIL | |
| ... | ... | ... | |
```

All criteria must PASS for acceptance. Any FAIL requires resolution before the change is merged.
