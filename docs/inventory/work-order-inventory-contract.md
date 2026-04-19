# Work Order Inventory Contract

> Complete behavioral specification for work order inventory interactions.
> Defines consume vs produce sequencing, partial production, backflush vs explicit issue,
> lot genealogy, WIP handling, reversal behavior, and concurrency rules.

---

## Work Order Lifecycle

### States

| Status | Meaning | Inventory Actions Allowed |
|--------|---------|--------------------------|
| `draft` | Created, not committed | None |
| `ready` | Materials planned, ready to start | None |
| `in_progress` | Execution started | Issue, completion, batch record |
| `partially_completed` | Some output produced, not all | Issue, completion, batch record |
| `completed` | All planned output produced | Close only |
| `closed` | Final; no further activity | None |
| `canceled` | Canceled before completion | None |

### Allowed State Transitions

| From | To | Trigger |
|------|-----|---------|
| `draft` | `ready` | Manual readiness confirmation |
| `draft` | `in_progress` | First execution posted |
| `draft` | `canceled` | Cancellation |
| `ready` | `in_progress` | First execution posted |
| `ready` | `canceled` | Cancellation |
| `in_progress` | `partially_completed` | Partial output produced |
| `in_progress` | `completed` | Full output produced |
| `in_progress` | `canceled` | Cancellation |
| `partially_completed` | `in_progress` | Additional issue without new output |
| `partially_completed` | `completed` | Remaining output produced |
| `partially_completed` | `canceled` | Cancellation |
| `completed` | `closed` | Administrative close |

### Terminal States

- `closed`: immutable
- `canceled`: immutable

### Status Validation

Error `WO_STATUS_TRANSITION_INVALID` thrown on any transition not in the table above.

---

## Work Order Types

### Standard Production

- BOM defines components (inputs) and output (finished goods)
- Components are issued (consumed) from storage
- Output is produced (received) to QA or production location

### Disassembly

- Reverse of production: input is the assembled item, outputs are components
- Uses `disassembly_issue` and `disassembly_completion` reason codes
- Input item must match the WO disassembly specification (`WO_DISASSEMBLY_INPUT_MISMATCH`)

---

## Consume vs Produce Sequencing

### Rule: Issue Before Completion (Standard Flow)

1. **Issue** (consume components): `postWorkOrderIssue()` creates `issue` movement
2. **Completion** (produce output): `postWorkOrderCompletion()` creates `receive` movement
3. WIP cost allocated from consumed cost layers to produced output

**Constraint:** Completion requires prior consumptions for WIP cost allocation. If no components have been issued, `WO_WIP_COST_NO_CONSUMPTIONS` is thrown.

### Rule: Batch Record (Combined Flow)

`recordWorkOrderBatch()` executes consume + produce in a single atomic transaction:

1. Creates `issue` movement for consumeLines (negative deltas)
2. Creates `receive` movement for produceLines (positive deltas)
3. WIP cost allocated within the same transaction

**Constraint:** Both consume and produce must be present in a batch record.

### Rule: Production Report (Two-Transaction Flow)

`reportWorkOrderProduction()` uses two sequential transactions:

- **TX-1 (Inventory):** Issue + completion movements, WIP cost allocation, idempotency claim
- **TX-2 (Traceability):** Lot traceability records, execution metadata

**Failure semantics:**
- TX-1 failure: entire operation aborts, no inventory changes
- TX-2 failure: TX-1 inventory changes persist; traceability recorded as incomplete
- TX-2 is retryable separately

### Sequencing Invariant

Within a single execution, the issue movement is always created before the receive movement. This ensures:
- Cost layers from consumed components exist before output cost allocation
- WIP balance is positive before production receipt

---

## Explicit Issue vs Backflush

### Explicit Issue

- Operator manually specifies which components to consume, from which locations, in which quantities
- Uses `postWorkOrderIssue()` workflow
- Creates `issue` movement with reason code `work_order_issue`
- Operator has full control over source locations and quantities

### Backflush

- System automatically calculates component consumption based on BOM quantities and actual output
- Triggered during completion/production report
- Uses BOM explosion to determine component quantities from produced output quantity
- Reason code: `work_order_backflush`
- Source location: production location or BOM-specified location

### Backflush Override

- Operator can override backflush quantities for specific components
- Reason code: `work_order_backflush_override`
- Override must still result in valid inventory (sufficient available quantity)

### Selection Rules

| Scenario | Method | Reason Code |
|----------|--------|-------------|
| Manual component issue before production | Explicit | `work_order_issue` |
| Auto-consume on completion | Backflush | `work_order_backflush` |
| Modified auto-consume | Backflush override | `work_order_backflush_override` |
| Disassembly input | Explicit | `disassembly_issue` |

---

## Partial Production

### Rules

1. A work order can produce output in multiple batches
2. Each execution creates its own issue + completion movement pair
3. Work order status tracks cumulative progress:
   - `quantityCompleted / quantityPlanned` determines status
   - `< 100%` → `partially_completed`
   - `≥ 100%` → `completed`
4. Over-production (> planned quantity) is allowed; status becomes `completed`

### WIP Cost Accumulation

- Each issue adds to WIP balance
- Each completion draws from accumulated WIP
- WIP cost allocation is proportional across output lines within a single execution
- Remainder (rounding) goes to the final output line (deterministic)

### Partial Production Edge Cases

| Scenario | Behavior |
|----------|----------|
| Issue without subsequent completion | WIP accumulates; stays in WIP until completion or void |
| Completion without sufficient WIP | `WO_WIP_COST_NO_CONSUMPTIONS` — must issue first |
| Multiple completions from single issue | WIP drawn down across completions |
| Issue after partial completion | New WIP added; future completions draw from total |

---

## WIP Handling

### WIP Cost Flow

```
Storage Cost Layers → (issue) → WIP Cost Layers → (completion) → Finished Goods Cost Layers
```

### WIP Cost Layer Lifecycle

1. **Creation:** When components are issued, cost layers are consumed via FIFO and WIP cost layers are created
2. **Allocation:** When output is produced, WIP cost is allocated proportionally to output lines
3. **Voiding:** When production is voided, WIP cost layers are reversed

### WIP Valuation

- WIP valuation = sum of unallocated WIP cost layers for the work order
- Tracked by `wipAccountingEngine.ts`
- Error `WO_WIP_VALUATION_RECORD_MISSING` if WIP tracking is inconsistent

### WIP Accounting Rules

1. WIP cost layers are scoped to a work order execution
2. Each issue execution creates WIP cost entries
3. Each completion execution allocates from WIP
4. Proportional allocation: each output line gets `(line_quantity / total_output_quantity) × total_WIP_cost`
5. Final line absorbs rounding remainder (deterministic, not stochastic)

---

## Lot Genealogy

### Input Lots

- Components may have lot assignments from their cost layers
- When issued, the lot is consumed (FIFO by lot-within-item)
- Input lot IDs recorded for traceability

### Output Lots

- Production output can be assigned a new lot ID
- `lotId` specified at completion time
- Lot record created or referenced in `lots` table

### Genealogy Links

- `lotTraceabilityEngine.ts` manages input → output lot mapping
- Recorded in TX-2 of production report (separate from inventory TX)
- Links: `(inputLotId, inputItemId, inputQuantity) → (outputLotId, outputItemId, outputQuantity)`

### Lot Validation

| Error Code | Condition |
|-----------|-----------|
| `WO_REPORT_OUTPUT_LOT_NOT_FOUND` | Specified output lot does not exist |
| `WO_REPORT_OUTPUT_LOT_ITEM_MISMATCH` | Output lot's item ≠ WO output item |
| `WO_REPORT_INPUT_LOT_NOT_FOUND` | Input lot does not exist |
| `WO_REPORT_INPUT_LOT_ITEM_MISMATCH` | Input lot's item ≠ component item |

### Inventory Unit Lot Chain

- Inventory units track `lot_key` (deterministic identifier)
- On issue: units consumed carry their lot information
- On completion: new units created with output lot_key
- Transfer within QC preserves lot_key

---

## Scrap and Reject

### Production Scrap

- Output can be recorded as scrap during production
- Reason code: `work_order_scrap`
- Scrap quantity does not count toward planned output completion
- Scrap creates a receive movement at the designated scrap location
- Cost allocated to scrap (WIP cost absorbed by scrap output)

### Production Reject

- Output fails QC inspection
- Reason code: `work_order_reject`
- Rejected output stays at reject location
- NCR created for disposition
- Does not count toward planned output completion unless disposition resolves to rework

---

## Reversal Behavior

### Void Production Execution

**Entry:** `voidWorkOrderProductionReport()` in `src/services/workOrderVoidProduction.workflow.ts`

**What is reversed:**
1. Output receive movement → reversed by issue movement (removes output)
2. Component issue movement → reversed by receive movement (returns components)
3. WIP cost layers → voided
4. Production cost layers → voided

### Void Preconditions

| Condition | Error Code |
|-----------|-----------|
| Execution exists | `WO_VOID_EXECUTION_NOT_FOUND` |
| Execution is posted | `WO_VOID_EXECUTION_NOT_POSTED` |
| Execution belongs to WO | `WO_VOID_EXECUTION_WORK_ORDER_MISMATCH` |
| Execution has movements | `WO_VOID_EXECUTION_MOVEMENTS_MISSING` |
| Output still at QA location | `WO_VOID_OUTPUT_NOT_QA` |
| Production cost layers exist | `WO_VOID_PRODUCTION_LAYER_MISSING` |
| Movement types valid | `WO_VOID_EXECUTION_MOVEMENT_TYPE_INVALID` |

### Critical Rule: Output Must Be at QA

Production void is only allowed when output inventory is still at the QA location:
- If output has been QC-accepted and put away → void is **blocked** (`WO_VOID_OUTPUT_NOT_QA`)
- If output has been shipped → void is **impossible**
- This ensures reversal does not create negative inventory at downstream locations

### Reversal Movements

| Original | Reversal | Reason Code |
|----------|----------|-------------|
| Issue (components consumed) | Receive (components returned) | `work_order_void_component_return` |
| Receive (output produced) | Issue (output removed) | `work_order_void_output` |

### Post-Void State

- Original movements marked with `reversed_by_movement_id`
- Reversal movements have `reversal_of_movement_id` and `reversal_reason`
- Components returned to original storage locations with restored cost layers
- Output removed from QA location
- Execution status = voided
- Work order status may revert (e.g., `completed` → `partially_completed` → `in_progress`)

### Void Limitations

1. Cannot void individual lines within an execution — entire execution is voided
2. Cannot void if downstream operations consumed the output
3. Cannot partially void an execution
4. Multiple executions can be voided independently (in reverse chronological order recommended)

---

## Concurrency Behavior

### ATP Locking

All WO inventory operations acquire ATP advisory locks:
- Issue: locks (tenantId, warehouseId, componentItemId) per component
- Completion: locks (tenantId, warehouseId, outputItemId) per output
- Void: locks both component and output items

### Transaction Isolation

- Standard: `READ COMMITTED` (default)
- With retry: `withTransactionRetry()` with configurable isolation level
- Production report TX-1 uses standard transaction boundary

### Concurrent Execution Scenarios

| Scenario | Behavior |
|----------|----------|
| Two issues for same WO, same component | Serialized by ATP lock; second sees updated balance |
| Issue + completion for same WO | Independent if different items locked; serialized if overlapping |
| Void + new execution for same WO | Serialized by ATP locks on shared items |
| Two WOs consuming same component | Serialized by ATP lock on component item; FIFO order preserved |

### Idempotency

- Each execution has unique idempotency key
- Key format: `${endpoint}:${workOrderId}:${requestHash}`
- On replay: cached result returned, no duplicate movements
- On concurrent first execution: `IDEMPOTENCY_REQUEST_IN_PROGRESS` (409)

---

## Reservation Integration

### Work Order Reservations

- Work orders can reserve components via `inventoryReservation.service.ts`
- Reservation status: RESERVED → consumed on issue
- Reservation sync reason code: `work_order_reservation_sync`

### Reservation Errors

| Error Code | Condition |
|-----------|-----------|
| `WO_RESERVATION_CORRUPT` | Reservation state inconsistent |
| `WO_RESERVATION_MISSING` | Expected reservation not found |
| `WO_RESERVATION_SHORTAGE` | Insufficient reserved quantity |

### Reservation-Issue Interaction

1. Components may be pre-reserved against WO
2. On issue: reserved quantity consumed, reservation updated
3. If not reserved: issue consumes from available balance directly
4. Reservation is not mandatory for issue

---

## Movement Summary

| Operation | Movement Type | Quantity Direction | Reason Code |
|-----------|--------------|-------------------|-------------|
| Component issue | `issue` | Negative (consume) | `work_order_issue` |
| Disassembly input | `issue` | Negative (consume) | `disassembly_issue` |
| Production output | `receive` | Positive (produce) | `work_order_completion` |
| Disassembly output | `receive` | Positive (produce) | `disassembly_completion` |
| Backflush consume | `issue` | Negative (consume) | `work_order_backflush` |
| Backflush override | `issue` | Negative (consume) | `work_order_backflush_override` |
| Production receipt | `receive` | Positive (produce) | `work_order_production_receipt` |
| Scrap output | `receive` | Positive (at scrap location) | `work_order_scrap` |
| Reject output | `receive` | Positive (at reject location) | `work_order_reject` |
| Void component return | `receive` | Positive (return) | `work_order_void_component_return` |
| Void output removal | `issue` | Negative (remove) | `work_order_void_output` |

---

## BOM Validation

### Pre-Execution Checks

| Error Code | Condition |
|-----------|-----------|
| `WO_BOM_NOT_FOUND` | BOM does not exist |
| `WO_BOM_ITEM_MISMATCH` | BOM output item ≠ WO output item |
| `WO_BOM_VERSION_NOT_FOUND` | BOM version not found |
| `WO_BOM_VERSION_MISMATCH` | BOM version ≠ WO BOM version |
| `WO_BOM_LEGACY_UNSUPPORTED` | Legacy BOM format not supported for operation |

### Routing

- Stage routing may override default locations for specific operations
- Error `WO_ROUTING_LOCATION_OVERRIDE_FORBIDDEN` if routing override is not permitted
