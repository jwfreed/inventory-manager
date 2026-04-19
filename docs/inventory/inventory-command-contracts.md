# Inventory Command Contracts

> Canonical behavioral specification for every inventory-mutating command.
> Each command is fully constrained: inputs, preconditions, locking, state transitions, movements, idempotency, failure modes, and replay expectations.

---

## Orchestration Boundary

All commands execute through `runInventoryCommand()` in `src/modules/platform/application/runInventoryCommand.ts`.

**Execution sequence (invariant):**

1. Open transaction via `withTransactionRetry()`
2. Claim idempotency key via `claimTransactionalIdempotency()`
3. If replayed → execute `onReplay` callback, return cached result
4. Acquire ATP locks via `acquireAtpLocks()` (sorted by key1 ASC, key2 ASC)
5. Execute command logic
6. Persist movement via `persistInventoryMovement()` in `ledgerWriter.ts`
7. Apply inventory unit events via `applyPersistedMovementToInventoryUnits()`
8. Append inventory events via `appendInventoryEventsWithDispatch()`
9. Execute queued projection operations
10. Finalize idempotency key via `finalizeTransactionalIdempotency()`
11. Commit transaction

**Violation of this sequence is forbidden.**

---

## Common Definitions

### Movement Types

| Type | Usage |
|------|-------|
| `receive` | Inbound: PO receipts, production output, returns |
| `issue` | Outbound: shipments, WO component consumption, scrap |
| `transfer` | Internal relocation between locations |
| `adjustment` | Physical count correction |
| `count` | Cycle count line item recording |

### Inventory States

`received` · `qc_hold` · `available` · `allocated` · `picked` · `shipped` · `adjusted`

### Movement Line Actions

`INCREASE_ON_HAND` · `DECREASE_ON_HAND` · `ALLOCATE` · `RELEASE` · `MOVE_LOCATION`

### Deterministic Hashing

Every movement has a `movement_deterministic_hash` computed via `buildMovementDeterministicHash()`:
- Inputs: tenantId, movementType, occurredAt (ISO 8601), sourceType, sourceId
- Lines sorted by: itemId → locationId → canonicalUom → quantityDelta → unitCost → reasonCode
- Numbers normalized to `toFixed(12)`
- Hash: SHA-256 hex

### Idempotency Protocol

- Every command requires `idempotencyKey` + `requestHash`
- `requestHash` = SHA-256 of canonicalized request body (sorted keys, ISO dates)
- On replay: cached `responseBody` returned; no mutations re-executed
- On key reuse with different endpoint: `IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS` (409)
- On key reuse with different payload: `IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD` (409)
- On concurrent execution: `IDEMPOTENCY_REQUEST_IN_PROGRESS` (409)

---

## Command: Receive

### Purpose
Post a purchase order receipt to the QA location, creating inbound inventory and receipt allocations.

### Entry Point
`createPurchaseOrderReceipt()` in `src/services/receipts.service.ts`

### Inputs

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| tenantId | uuid | yes | Tenant scope |
| purchaseOrderId | uuid | yes | Source PO |
| warehouseId | uuid | yes | Receiving warehouse |
| lines | array | yes | Receipt lines (itemId, quantity, uom, unitCost) |
| occurredAt | timestamptz | yes | Event timestamp |
| idempotencyKey | string | yes | Deduplication key |
| actorId | uuid | no | Receiving operator |
| notes | string | no | Freeform notes |
| lotId | uuid | no | Lot assignment |

### Preconditions

1. Purchase order exists and status = `approved`
2. PO lines match receipt lines by itemId
3. Warehouse has a configured QA location (`qa_location_id`)
4. Receipt quantity > 0 for each line
5. UOM is valid and convertible to item canonical UOM

### Locking

| Target | Scope |
|--------|-------|
| ATP advisory lock | (tenantId, warehouseId, itemId) per line |

### State Transitions

| From | To | Condition |
|------|-----|-----------|
| (none) | `received` | New inventory created at QA location |

### Inventory Movements Created

| Movement | Type | Status |
|----------|------|--------|
| Receipt | `receive` | `posted` |

**Movement fields:**
- `source_type` = `purchase_order`
- `source_id` = purchaseOrderId
- `movement_deterministic_hash` = computed

**Movement lines (per receipt line):**
- `quantity_delta` = +received quantity (canonical)
- `location_id` = warehouse QA location
- `reason_code` = (derived from receipt context)
- `unit_cost` = PO line unit cost
- `source_line_id` = `computeSourceLineId([poLineId, receiptLineId])`

### Inventory Unit Events

- One `inventory_unit_event` per line with `state_transition` = `received->available` or `received->qc_hold`
- Creates new `inventory_unit` at QA location

### Side Effects

1. Receipt allocations created with `status` = `QA`
2. Cost layers created (`source_type` = `receipt`)
3. Inventory balance projection updated (on_hand +delta)
4. PO lifecycle evaluated: may transition PO to `partially_received` or `received`

### Idempotency

- Key: receipt-scoped
- Replay: returns existing receipt ID and movement ID
- No duplicate movements or allocations on replay

### Failure Conditions

| Error Code | Trigger | HTTP |
|------------|---------|------|
| `RECEIPT_PO_NOT_FOUND` | PO does not exist for tenant | 404 |
| `RECEIPT_PO_NOT_APPROVED` | PO status ≠ approved | 409 |
| `RECEIPT_LOCATION_REQUIRED` | Missing receiving location config | 400 |
| `QA_LOCATION_REQUIRED` | Warehouse has no QA location | 400 |
| `RECEIPT_ALREADY_REVERSED` | Receipt previously voided | 409 |
| `INVENTORY_MOVEMENT_LINES_REQUIRED` | Empty lines array | 400 |
| `INVENTORY_MOVEMENT_LINE_REASON_CODE_REQUIRED` | Missing reason code | 400 |

### Postconditions

1. Exactly one `inventory_movement` (type=receive, status=posted) exists
2. One `inventory_movement_line` per receipt line exists with quantity_delta > 0
3. Receipt allocations exist with status=QA at QA location
4. Cost layers exist for each line
5. Inventory balance at QA location reflects +quantity
6. Inventory unit(s) created at QA location

### Replay Expectations

- Deterministic hash matches original
- Same movement ID returned
- No duplicate ledger rows
- Receipt allocations unchanged

### Audit Requirements

- Movement linked to PO via `source_type`/`source_id`
- Each line has `source_line_id` tracing to PO line
- `occurred_at` reflects actual receiving timestamp
- Actor ID recorded when provided

---

## Command: Receipt Void

### Purpose
Reverse a posted receipt, returning inventory and invalidating cost layers.

### Entry Point
`voidReceipt()` in `src/services/receipts.service.ts`

### Inputs

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| tenantId | uuid | yes | Tenant scope |
| receiptId | uuid | yes | Receipt to void |
| reason | string | yes | Void reason |
| actorId | uuid | no | Operator |
| idempotencyKey | string | yes | Deduplication key |

### Preconditions

1. Receipt exists and is not already voided
2. No putaways have been posted against this receipt (`RECEIPT_HAS_PUTAWAYS_POSTED`)
3. Cost layers from receipt are not consumed (`RECEIPT_REVERSAL_NOT_POSSIBLE_CONSUMED`)

### Locking

| Target | Scope |
|--------|-------|
| ATP advisory lock | (tenantId, warehouseId, itemId) per original line |

### State Transitions

| From | To | Condition |
|------|-----|-----------|
| `received` or `qc_hold` or `available` | (removed) | Reversal decrements quantity |

### Inventory Movements Created

| Movement | Type | Status |
|----------|------|--------|
| Reversal | `receive` | `posted` |

**Movement fields:**
- `reversal_of_movement_id` = original movement ID
- `reversal_reason` = provided reason
- Lines mirror original with negated `quantity_delta`
- `reason_code` = `receipt_void_reversal`

### Failure Conditions

| Error Code | Trigger | HTTP |
|------------|---------|------|
| `RECEIPT_NOT_FOUND` | Receipt does not exist | 404 |
| `RECEIPT_ALREADY_REVERSED` | Already voided | 409 |
| `RECEIPT_HAS_PUTAWAYS_POSTED` | Putaways exist | 409 |
| `RECEIPT_REVERSAL_NOT_POSSIBLE_CONSUMED` | Cost layers consumed | 409 |

### Postconditions

1. Original movement has `reversed_by_movement_id` set
2. Reversal movement exists with `reversal_of_movement_id`
3. Cost layers voided
4. Receipt status = `voided`
5. Receipt allocations invalidated

---

## Command: QC Accept

### Purpose
Release inventory from QC hold to available/sellable location.

### Entry Point
`createQcEvent()` with action=`accept` in `src/services/qc.service.ts`

### Inputs

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| tenantId | uuid | yes | Tenant scope |
| sourceType | string | yes | `receipt`, `work_order`, or `execution_line` |
| sourceId | uuid | yes | Source entity ID |
| action | string | yes | `accept` |
| itemId | uuid | yes | Item being accepted |
| quantity | number | yes | Quantity to accept |
| uom | string | yes | Unit of measure |
| locationId | uuid | yes | QA source location |
| acceptLocationId | uuid | no | Override destination (defaults to warehouse accept location) |
| idempotencyKey | string | yes | Deduplication key |
| lotId | uuid | no | Lot reference |
| notes | string | no | QC notes |

### Preconditions

1. Source entity exists and is eligible for QC
2. Source location has role = QA (`QC_SOURCE_MUST_BE_QA`)
3. Destination location has role = sellable (`QC_ACCEPT_REQUIRES_SELLABLE_ROLE`) and `is_sellable` flag (`QC_ACCEPT_REQUIRES_SELLABLE_FLAG`)
4. Sufficient quantity in QA status at source location
5. For receipt source: receipt not voided (`QC_RECEIPT_VOIDED`)
6. Quantity does not exceed unprocessed QC quantity (`QC_EXCEEDS_RECEIPT` / `QC_EXCEEDS_WORK_ORDER`)
7. UOM matches source UOM (`QC_UOM_MISMATCH`)

### Locking

| Target | Scope |
|--------|-------|
| ATP advisory lock | (tenantId, warehouseId, itemId) |

### State Transitions

| From | To | Condition |
|------|-----|-----------|
| `qc_hold` | `available` | QC accept transfers to sellable location |
| `received` | `available` | Direct accept from received state |

### Inventory Movements Created

| Movement | Type | Status |
|----------|------|--------|
| QC transfer | `transfer` | `posted` |

**Movement fields:**
- `source_type` = `qc_event`
- `source_id` = qc event ID
- Two lines: OUT from QA location (negative delta), IN to accept location (positive delta)
- `reason_code` = `qc_release`

### Side Effects

1. QC event record created
2. Receipt allocations moved: QA → AVAILABLE (for receipt source)
3. Inventory balance updated at both locations
4. Inventory units relocated via transfer logic

### Idempotency

- Key: QC-event-scoped
- Replay: returns existing QC event and transfer movement
- No duplicate transfers on replay

### Failure Conditions

| Error Code | Trigger | HTTP |
|------------|---------|------|
| `QC_SOURCE_REQUIRED` | Missing sourceType/sourceId | 400 |
| `QC_ITEM_ID_REQUIRED` | Missing itemId | 400 |
| `QC_LOCATION_REQUIRED` | Missing locationId | 400 |
| `QC_SOURCE_MUST_BE_QA` | Source not a QA location | 400 |
| `QC_ACCEPT_REQUIRES_SELLABLE_ROLE` | Destination not sellable role | 400 |
| `QC_ACCEPT_REQUIRES_SELLABLE_FLAG` | Destination not flagged sellable | 400 |
| `QC_RECEIPT_VOIDED` | Receipt already voided | 409 |
| `QC_EXCEEDS_RECEIPT` | Quantity exceeds unprocessed | 400 |
| `QC_UOM_MISMATCH` | UOM does not match source | 400 |
| `QC_RECEIPT_ALLOCATION_INSUFFICIENT_QA` | Insufficient QA allocation | 409 |

### Postconditions

1. QC event record exists with action=accept
2. Transfer movement exists from QA → accept location
3. Receipt allocations (if receipt source) transitioned QA → AVAILABLE
4. Inventory at QA location decreased; at accept location increased
5. Inventory units updated with new location

### Audit Requirements

- QC event linked to source (receipt/WO/execution)
- Transfer movement linked to QC event via `source_type`/`source_id`
- Timestamp records when QC decision was made

---

## Command: QC Hold

### Purpose
Place inventory on hold at a non-sellable hold location.

### Entry Point
`createQcEvent()` with action=`hold` in `src/services/qc.service.ts`

### Inputs

Same as QC Accept, with `action` = `hold` and `holdLocationId` as optional destination override.

### Preconditions

1. Source entity exists and is eligible for QC
2. Source location has role = QA
3. Destination location has role = hold (`QC_HOLD_REQUIRES_HOLD_ROLE`) and is NOT sellable (`QC_HOLD_MUST_NOT_BE_SELLABLE`)
4. Sufficient quantity in QA status

### State Transitions

| From | To | Condition |
|------|-----|-----------|
| `received` | `qc_hold` | Explicit hold |
| `qc_hold` | `qc_hold` | Location change within hold |

### Inventory Movements Created

| Movement | Type | Status |
|----------|------|--------|
| QC transfer | `transfer` | `posted` |

- `reason_code` = `qc_hold`
- Two lines: OUT from QA, IN to hold location

### Side Effects

1. QC event created with action=hold
2. Receipt allocations moved: QA → HOLD (for receipt source)

### Failure Conditions

| Error Code | Trigger | HTTP |
|------------|---------|------|
| `QC_HOLD_REQUIRES_HOLD_ROLE` | Destination not hold role | 400 |
| `QC_HOLD_MUST_NOT_BE_SELLABLE` | Destination is sellable | 400 |

### Postconditions

1. Inventory at hold location; not available for allocation or shipment
2. Receipt allocations in HOLD status

---

## Command: QC Reject

### Purpose
Reject inventory and move to reject location. Creates a non-conformance record (NCR).

### Entry Point
`createQcEvent()` with action=`reject` in `src/services/qc.service.ts`

### Inputs

Same as QC Accept, with `action` = `reject` and `rejectLocationId` as optional destination override.

### Preconditions

1. Source location has role = QA
2. Destination location has role = reject (`QC_REJECT_REQUIRES_REJECT_ROLE`) and is NOT sellable (`QC_REJECT_MUST_NOT_BE_SELLABLE`)
3. Sufficient quantity in QA status

### State Transitions

| From | To | Condition |
|------|-----|-----------|
| `received` | `qc_hold` | Rejected inventory held at reject location |

### Inventory Movements Created

| Movement | Type | Status |
|----------|------|--------|
| QC transfer | `transfer` | `posted` |

- `reason_code` = `qc_reject`
- Two lines: OUT from QA, IN to reject location

### Side Effects

1. QC event created with action=reject
2. NCR record created
3. Receipt allocations moved: QA → HOLD

### Postconditions

1. Inventory at reject location; not available for any demand
2. NCR record exists for tracking disposition

---

## Command: Putaway

### Purpose
Relocate accepted inventory from QA/staging location to final storage location.

### Entry Point
`postPutaway()` in `src/services/putaways.service.ts`

### Inputs

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| tenantId | uuid | yes | Tenant scope |
| receiptId | uuid | yes | Source receipt |
| lines | array | yes | Putaway lines (allocationId, toLocationId, toBinId, quantity) |
| idempotencyKey | string | yes | Deduplication key |
| actorId | uuid | no | Operator |
| occurredAt | timestamptz | no | Override timestamp |

### Preconditions

1. Receipt exists and is not voided (`PUTAWAY_RECEIPT_VOIDED`)
2. Each allocation exists and has status = AVAILABLE
3. `fromLocationId` is the allocation's current location (`PUTAWAY_FROM_LOCATION_REQUIRED`)
4. `toLocationId` ≠ `fromLocationId` (`PUTAWAY_SAME_LOCATION`)
5. Quantity ≤ allocation remaining quantity (`PUTAWAY_QUANTITY_EXCEEDED`)
6. UOM matches allocation UOM (`PUTAWAY_UOM_MISMATCH`)
7. No duplicate allocation IDs in lines (`PUTAWAY_DUPLICATE_LINE`)
8. Putaway not blocked by pending QC (`PUTAWAY_BLOCKED`)

### Locking

| Target | Scope |
|--------|-------|
| ATP advisory lock | (tenantId, warehouseId, itemId) per line |

### State Transitions

| From | To | Condition |
|------|-----|-----------|
| `available` | `available` | Location change only; state preserved |

### Inventory Movements Created

| Movement | Type | Status |
|----------|------|--------|
| Putaway transfer | `transfer` | `posted` |

- `source_type` = `putaway`
- Per line: OUT from staging location (negative delta), IN to storage location (positive delta)
- `reason_code` = `transfer`

### Side Effects

1. Cost layers relocated from source to destination location
2. Receipt allocation `location_id` and `bin_id` updated
3. Inventory balance projection updated at both locations
4. Inventory units relocated

### Failure Conditions

| Error Code | Trigger | HTTP |
|------------|---------|------|
| `PUTAWAY_RECEIPT_VOIDED` | Receipt voided | 409 |
| `PUTAWAY_UOM_MISMATCH` | UOM mismatch with allocation | 400 |
| `PUTAWAY_FROM_LOCATION_REQUIRED` | Missing from location | 400 |
| `PUTAWAY_SAME_LOCATION` | Source = destination | 400 |
| `PUTAWAY_DUPLICATE_LINE` | Duplicate allocation in lines | 400 |
| `PUTAWAY_BLOCKED` | Pending QC blocks putaway | 409 |
| `PUTAWAY_QUANTITY_EXCEEDED` | Quantity > allocation remaining | 400 |
| `PUTAWAY_NOT_FOUND` | Putaway record not found | 404 |
| `PUTAWAY_ALLOCATION_INSUFFICIENT_QA` | Insufficient available allocation | 409 |

### Postconditions

1. Inventory at final storage location
2. Cost layers at new location
3. Receipt allocation updated with new location/bin
4. Original location quantity decreased

---

## Command: Transfer

### Purpose
Relocate inventory between locations within a warehouse.

### Entry Point
`transferInventory()` in `src/services/transfers.service.ts`

### Inputs

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| tenantId | uuid | yes | Tenant scope |
| sourceLocationId | uuid | yes | From location |
| destinationLocationId | uuid | yes | To location |
| warehouseId | uuid | no | Warehouse scope |
| itemId | uuid | yes | Item to transfer |
| quantity | number | yes | Transfer quantity (> 0) |
| uom | string | yes | Unit of measure |
| sourceType | string | yes | e.g., `manual_transfer`, `qc_event` |
| sourceId | uuid | yes | Source entity ID |
| reasonCode | string | no | Override reason code (default: `transfer`) |
| qcAction | string | no | `accept`, `hold`, or `reject` (QC transfers only) |
| idempotencyKey | string | yes | Deduplication key |
| lotId | uuid | no | Lot constraint |
| overrideNegative | boolean | no | Allow negative balance |
| overrideReason | string | no | Required when overrideNegative=true |
| occurredAt | timestamptz | no | Override timestamp |
| actorId | uuid | no | Operator |

### Preconditions

1. Source location exists (`TRANSFER_SOURCE_NOT_FOUND`)
2. Destination location exists (`TRANSFER_DESTINATION_NOT_FOUND`)
3. Source ≠ destination (`TRANSFER_SAME_LOCATION`)
4. Quantity > 0 (`TRANSFER_INVALID_QUANTITY`)
5. Same warehouse unless cross-warehouse is allowed (`TRANSFER_CROSS_WAREHOUSE_NOT_ALLOWED`)
6. If qcAction specified: source must be QA location (`QC_SOURCE_MUST_BE_QA`)
7. If qcAction=accept: destination must be sellable
8. If qcAction=hold: destination must be hold role, not sellable
9. If qcAction=reject: destination must be reject role, not sellable

### Locking

| Target | Scope |
|--------|-------|
| ATP advisory lock | (tenantId, sourceWarehouseId, itemId) |
| ATP advisory lock | (tenantId, destWarehouseId, itemId) — if cross-warehouse |

### State Transitions

| From | To | Condition |
|------|-----|-----------|
| `available` | `available` | Standard transfer |
| `qc_hold` | `available` | QC accept transfer |
| `received` | `qc_hold` | QC hold transfer |
| `received` | `available` | QC accept from received |

### Inventory Movements Created

| Movement | Type | Status |
|----------|------|--------|
| Transfer | `transfer` | `posted` |

**Movement lines:**
- Line 1 (OUT): `quantity_delta` = -quantity at source location
- Line 2 (IN): `quantity_delta` = +quantity at destination location
- `reason_code` = provided or `transfer` (default); QC transfers use `qc_release`/`qc_hold`/`qc_reject`
- `source_line_id` = `computeSourceLineId([sourceType, sourceId, 'out'|'in'])`

### Inventory Unit Events

- FIFO consumption at source location via `appendNegativeUnitEventsFifo()`
- New/updated unit at destination location
- Lot chaining: destination unit inherits lot from consumed source unit

### Side Effects

1. Cost layers relocated via `transferCosting.service.ts`
2. Inventory balance updated at both locations
3. Inventory units relocated with lot chain preserved

### Idempotency

- Key: transfer-scoped
- Replay: returns existing movement ID + `replayed: true`

### Failure Conditions

| Error Code | Trigger | HTTP |
|------------|---------|------|
| `TRANSFER_SOURCE_NOT_FOUND` | Source location missing | 404 |
| `TRANSFER_DESTINATION_NOT_FOUND` | Destination location missing | 404 |
| `TRANSFER_SAME_LOCATION` | Source = destination | 400 |
| `TRANSFER_INVALID_QUANTITY` | Quantity ≤ 0 | 400 |
| `TRANSFER_CROSS_WAREHOUSE_NOT_ALLOWED` | Different warehouses | 400 |
| `TRANSFER_VOID_REASON_REQUIRED` | Void without reason | 400 |
| `TRANSFER_VOID_CONFLICT` | Transfer already voided | 409 |

### Postconditions

1. Exactly one transfer movement with 2 lines (OUT + IN)
2. Source location balance decreased
3. Destination location balance increased
4. Net on-hand unchanged (zero-sum)
5. Cost layers at new location

### Replay Expectations

- Deterministic hash matches
- Same movement ID returned
- No duplicate lines

### Audit Requirements

- `source_type`/`source_id` trace to originating action
- Both locations recorded in movement lines
- `occurred_at` reflects actual transfer time

---

## Command: Transfer Void

### Purpose
Reverse a previously posted transfer movement.

### Entry Point
`voidTransfer()` in `src/services/transfers.service.ts`

### Inputs

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| tenantId | uuid | yes | Tenant scope |
| transferMovementId | uuid | yes | Movement to reverse |
| reason | string | yes | Void reason |
| idempotencyKey | string | yes | Deduplication key |

### Preconditions

1. Original movement exists, type=transfer, status=posted
2. Movement is not itself a reversal (`reversal_of_movement_id` must be null)
3. Movement not already reversed (`TRANSFER_VOID_CONFLICT`)
4. Original has exactly 2 lines (1 OUT, 1 IN)
5. Items match between lines
6. Destination cost layers not consumed
7. Void reason provided (`TRANSFER_VOID_REASON_REQUIRED`)

### Locking

| Target | Scope |
|--------|-------|
| ATP advisory lock | (tenantId, sourceWarehouseId, itemId) |
| ATP advisory lock | (tenantId, destWarehouseId, itemId) |

### Inventory Movements Created

Reversal movement with inverted quantity deltas. `reversal_of_movement_id` = original. `reversal_reason` = provided reason.

### Failure Conditions

| Error Code | Trigger | HTTP |
|------------|---------|------|
| `TRANSFER_VOID_REASON_REQUIRED` | Missing reason | 400 |
| `TRANSFER_VOID_CONFLICT` | Already reversed | 409 |

### Postconditions

1. Reversal movement exists
2. Original movement has `reversed_by_movement_id` set
3. Inventory returned to original locations
4. Cost layers returned

---

## Command: Allocate (Reserve)

### Purpose
Reserve available inventory against demand (sales order line).

### Entry Point
`createReservations()` in `src/services/orderToCash.service.ts`

### Inputs

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| tenantId | uuid | yes | Tenant scope |
| warehouseId | uuid | yes | Warehouse scope |
| lines | array | yes | (itemId, quantity, uom, demandId, demandType) |
| expiresAt | timestamptz | no | Reservation expiration |
| idempotencyKey | string | yes | Deduplication key |

### Preconditions

1. Sufficient available quantity at warehouse (on_hand - reserved - allocated ≥ requested)
2. Item exists and is active
3. Warehouse scope valid

### Locking

| Target | Scope |
|--------|-------|
| ATP advisory lock | (tenantId, warehouseId, itemId) per line |
| Isolation level | SERIALIZABLE |
| Retry | Up to `ATP_RESERVATION_CREATE_RETRIES` (default 10) with exponential backoff |

### State Transitions

| From | To | Condition |
|------|-----|-----------|
| `available` | `allocated` | Quantity reserved against demand |

### Inventory Movements Created

None. Reservation is a balance-layer operation:
- `inventory_balance.reserved` += quantity

### Side Effects

1. `inventory_reservations` row created with status=RESERVED
2. Balance projection: reserved quantity incremented

### Failure Conditions

| Error Code | Trigger | HTTP |
|------------|---------|------|
| `ATP_INSUFFICIENT_AVAILABLE` | Not enough available | 409 |
| `ATP_CONCURRENCY_EXHAUSTED` | Exceeded retry budget | 503 |
| `WAREHOUSE_SCOPE_MISMATCH` | Wrong warehouse | 400 |

### Postconditions

1. Reservation exists with status=RESERVED
2. Available quantity decreased by reserved amount
3. On-hand unchanged

---

## Command: Deallocate (Cancel Reservation)

### Purpose
Release reserved/allocated inventory back to available.

### Entry Point
`cancelReservation()` in `src/services/orderToCash.service.ts`

### Inputs

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| tenantId | uuid | yes | Tenant scope |
| reservationId | uuid | yes | Reservation to cancel |
| warehouseId | uuid | yes | Warehouse scope |

### Preconditions

1. Reservation exists (`RESERVATION_NOT_FOUND`)
2. Reservation status = RESERVED or ALLOCATED (not FULFILLED or CANCELED)
3. Warehouse scope matches

### Locking

| Target | Scope |
|--------|-------|
| ATP advisory lock | (tenantId, warehouseId, itemId) |
| Isolation level | SERIALIZABLE |

### State Transitions

| From | To | Condition |
|------|-----|-----------|
| `allocated` | `available` | Allocated quantity released |

### Inventory Movements Created

None. Balance-layer operation:
- `inventory_balance.reserved` -= quantity
- `inventory_balance.allocated` -= quantity (if was allocated)

### Failure Conditions

| Error Code | Trigger | HTTP |
|------------|---------|------|
| `RESERVATION_NOT_FOUND` | Missing reservation | 404 |
| `RESERVATION_CANCEL_IN_PROGRESS` | Concurrent cancel | 409 |

### Postconditions

1. Reservation status = CANCELED
2. Reserved/allocated quantities freed
3. Available quantity increased

---

## Command: Allocate Reservation

### Purpose
Transition a reservation from RESERVED to ALLOCATED, confirming warehouse commitment.

### Entry Point
`allocateReservation()` in `src/services/orderToCash.service.ts`

### Inputs

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| tenantId | uuid | yes | Tenant scope |
| reservationId | uuid | yes | Reservation to allocate |
| warehouseId | uuid | yes | Warehouse scope |

### Preconditions

1. Reservation exists with status = RESERVED
2. Location must be sellable

### Locking

| Target | Scope |
|--------|-------|
| ATP advisory lock | (tenantId, warehouseId, itemId) |
| Isolation level | SERIALIZABLE |

### State Transitions

| From | To | Condition |
|------|-----|-----------|
| `available` | `allocated` | Soft reservation → firm allocation |

### Inventory Movements Created

None. Balance-layer operation:
- `inventory_balance.allocated` += quantity

### Failure Conditions

| Error Code | Trigger | HTTP |
|------------|---------|------|
| `RESERVATION_NOT_FOUND` | Missing reservation | 404 |
| `RESERVATION_ALLOCATE_IN_PROGRESS` | Concurrent allocation | 409 |

### Postconditions

1. Reservation status = ALLOCATED
2. Balance allocated quantity increased

---

## Command: Pick

### Purpose
Create pick tasks that stage allocated inventory for shipment.

### Entry Point
`createPickBatch()` / `createPickTask()` in `src/services/picking.service.ts`

### Inputs (Pick Task)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| tenantId | uuid | yes | Tenant scope |
| pickBatchId | uuid | yes | Parent batch |
| itemId | uuid | yes | Item to pick |
| uom | string | yes | Unit of measure |
| fromLocationId | uuid | yes | Storage location |
| quantityRequested | number | yes | Quantity to pick |
| inventoryReservationId | uuid | no | Linked reservation |
| salesOrderLineId | uuid | no | Demand reference |

### Preconditions

1. Pick batch exists with status = `draft` or `active`
2. Sufficient available/allocated quantity at location
3. Item exists

### State Transitions

| From | To | Condition |
|------|-----|-----------|
| `allocated` | `picked` | Pick task completed |

### Pick Task Statuses

`pending` → `picked` → (shipped via shipment)
`pending` → `cancelled`

### Postconditions

1. Pick task record created with quantityRequested
2. When picked: quantityPicked recorded, pickedAt timestamped
3. Pick batch status tracks completion

---

## Command: Ship (Post Shipment)

### Purpose
Post a shipment, issuing inventory and consuming cost layers via FIFO.

### Entry Point
`postShipment()` in `src/services/orderToCash.service.ts`

### Inputs

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| tenantId | uuid | yes | Tenant scope |
| shipmentId | uuid | yes | Shipment to post |
| warehouseId | uuid | yes | Shipping warehouse |
| idempotencyKey | string | yes | Deduplication key |

### Preconditions

1. Shipment exists and not canceled (`SHIPMENT_CANCELED`)
2. Shipment has lines (`SHIPMENT_NO_LINES`)
3. Line quantities > 0 (`SHIPMENT_INVALID_QUANTITY`)
4. All items in same warehouse (`CROSS_WAREHOUSE_LEAKAGE_BLOCKED`)
5. Sufficient available quantity at ship-from location

### Locking

| Target | Scope |
|--------|-------|
| ATP advisory lock | (tenantId, warehouseId, itemId) per line |
| Isolation level | SERIALIZABLE |
| Retry | Up to `ATP_SHIPMENT_POST_RETRIES` (default 8) |

### State Transitions

| From | To | Condition |
|------|-----|-----------|
| `picked` | `shipped` | Shipment of picked inventory |
| `available` | `shipped` | Direct shipment (no prior pick) |

### Inventory Movements Created

| Movement | Type | Status |
|----------|------|--------|
| Shipment | `issue` | `posted` |

**Movement lines (per shipment line):**
- `quantity_delta` = -shipped quantity
- `location_id` = ship-from location
- `reason_code` = `shipment`
- `source_type` = `sales_order_shipment`
- `source_id` = shipmentId

### Side Effects

1. Cost layers consumed via FIFO
2. Reservations fulfilled (quantity_fulfilled incremented)
3. Reservations auto-transition to FULFILLED when fully shipped
4. Inventory balance: on_hand decreased, allocated decreased
5. Inventory units consumed

### Failure Conditions

| Error Code | Trigger | HTTP |
|------------|---------|------|
| `SHIPMENT_NOT_FOUND` | Missing shipment | 404 |
| `SHIPMENT_CANCELED` | Shipment canceled | 409 |
| `SHIPMENT_NO_LINES` | No shipment lines | 400 |
| `SHIPMENT_INVALID_QUANTITY` | Quantity ≤ 0 | 400 |
| `CROSS_WAREHOUSE_LEAKAGE_BLOCKED` | Cross-warehouse items | 400 |
| `ATP_INSUFFICIENT_AVAILABLE` | Not enough stock | 409 |
| `SHIPMENT_POST_FAILED` | Post failed | 500 |

### Postconditions

1. Issue movement exists with negative quantity_delta per line
2. On-hand decreased
3. Cost layers consumed in FIFO order
4. Reservations updated/fulfilled
5. Shipment status = posted

### Audit Requirements

- Movement linked to shipment via `source_type`/`source_id`
- Each line traces to sales order line
- FIFO cost consumption chain auditable

---

## Command: Return

### Purpose
Receive returned goods and create disposition records.

### Entry Point
`postReturnReceipt()` in `src/services/returnPostingOrchestrator.ts`

### Inputs

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| tenantId | uuid | yes | Tenant scope |
| returnReceiptId | uuid | yes | Return receipt |
| warehouseId | uuid | yes | Receiving warehouse |
| idempotencyKey | string | yes | Deduplication key |

### Preconditions

1. Return receipt exists and not canceled (`RETURN_RECEIPT_CANCELED`)
2. Has lines (`RETURN_RECEIPT_NO_LINES`)
3. Disposition policy specified (`RETURN_RECEIPT_POLICY_REQUIRED`)

### State Transitions

| From | To | Condition |
|------|-----|-----------|
| (none) | `received` | Returned inventory arrives at QA/return location |

### Inventory Movements Created

| Movement | Type | Status |
|----------|------|--------|
| Return receipt | `receive` | `posted` |

- Positive quantity_delta at receiving location
- Cost layers created for returned goods

### Side Effects

1. Disposition record created for downstream QC
2. Return receipt status updated

### Failure Conditions

| Error Code | Trigger | HTTP |
|------------|---------|------|
| `RETURN_RECEIPT_NOT_FOUND` | Missing return receipt | 404 |
| `RETURN_RECEIPT_CANCELED` | Already canceled | 409 |
| `RETURN_RECEIPT_NO_LINES` | No lines | 400 |
| `RETURN_RECEIPT_POLICY_REQUIRED` | No disposition policy | 400 |
| `RETURN_RECEIPT_RECOVERY_IRRECOVERABLE` | Cannot recover | 500 |

### Postconditions

1. Inventory at return receiving location
2. Cost layers created
3. Disposition record awaiting QC decision

---

## Command: Adjust (Inventory Adjustment)

### Purpose
Post an approved inventory adjustment to correct recorded stock.

### Entry Point
`postAdjustment()` in `src/services/adjustments/posting.service.ts`

### Inputs

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| tenantId | uuid | yes | Tenant scope |
| adjustmentId | uuid | yes | Draft adjustment to post |
| idempotencyKey | string | yes | Deduplication key |

### Preconditions

1. Adjustment exists (`ADJUSTMENT_NOT_FOUND`)
2. Status = draft, not posted/canceled (`ADJUSTMENT_ALREADY_POSTED`, `ADJUSTMENT_ALREADY_CANCELED`)
3. Has lines (`ADJUSTMENT_NO_LINES`)
4. Each line has reason_code (`ADJUSTMENT_REASON_REQUIRED`)
5. No zero-quantity lines (`ADJUSTMENT_LINE_ZERO`)

### Locking

| Target | Scope |
|--------|-------|
| ATP advisory lock | (tenantId, warehouseId, itemId) per line |

### State Transitions

| From | To | Condition |
|------|-----|-----------|
| `available` | `adjusted` | Adjustment decreases on-hand |
| `adjusted` | `available` | Adjustment increases on-hand |

### Inventory Movements Created

| Movement | Type | Status |
|----------|------|--------|
| Adjustment | `adjustment` | `posted` |

**Movement lines (per adjustment line):**
- `quantity_delta` = adjustment delta (positive or negative)
- `location_id` = adjustment location
- `reason_code` = line reason code

### Side Effects

1. Cost layers consumed (negative adjustment) or created (positive adjustment)
2. Inventory balance updated
3. Adjustment status → posted
4. Inventory units updated

### Failure Conditions

| Error Code | Trigger | HTTP |
|------------|---------|------|
| `ADJUSTMENT_NOT_FOUND` | Missing adjustment | 404 |
| `ADJUSTMENT_ALREADY_POSTED` | Already posted | 409 |
| `ADJUSTMENT_ALREADY_CANCELED` | Already canceled | 409 |
| `ADJUSTMENT_NO_LINES` | No lines | 400 |
| `ADJUSTMENT_LINE_ZERO` | Zero-quantity line | 400 |
| `ADJUSTMENT_REASON_REQUIRED` | Missing reason | 400 |
| `ADJUSTMENT_POST_INCOMPLETE` | Post failed mid-way | 500 |

### Postconditions

1. Adjustment movement exists
2. On-hand reflects corrected quantity
3. Cost layers adjusted
4. Adjustment record status = posted

---

## Command: Recount (Cycle Count Post)

### Purpose
Post a completed cycle count, creating adjustment movements for variances.

### Entry Point
`postInventoryCount()` in `src/services/counts.service.ts`

### Inputs

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| tenantId | uuid | yes | Tenant scope |
| countId | uuid | yes | Draft count to post |
| idempotencyKey | string | yes | Deduplication key |

### Preconditions

1. Count exists (`COUNT_NOT_FOUND`)
2. Status = draft (`COUNT_NOT_DRAFT`)
3. Not canceled (`COUNT_CANCELED`)
4. Has lines (`COUNT_NO_LINES`)
5. Variance lines have reason_code (`COUNT_REASON_REQUIRED`)
6. Positive variance lines have unit_cost (`CYCLE_COUNT_UNIT_COST_REQUIRED`)
7. Variance within auto-adjust limit or override provided (`COUNT_RECONCILIATION_ESCALATION_REQUIRED`)
8. Warehouse scope valid

### Locking

| Target | Scope |
|--------|-------|
| ATP advisory lock | (tenantId, warehouseId, itemId) per variance line |

### State Transitions

| From | To | Condition |
|------|-----|-----------|
| `available` | `adjusted` | Negative variance (shrink) |
| `adjusted` | `available` | Positive variance (found) |

### Inventory Movements Created

| Movement | Type | Status |
|----------|------|--------|
| Count adjustment | `adjustment` | `posted` |

- One line per variance (where counted ≠ system)
- `quantity_delta` = counted - system
- `reason_code` = `cycle_count_adjustment`
- `source_type` = `cycle_count`
- `source_id` = countId

### Side Effects

1. Variance metrics computed (weightedVariancePct, weightedAccuracyPct, hitRate)
2. Cost layers: consumed (shrink) or created (found) with FIFO
3. Count execution record created with status SUCCEEDED
4. Inventory balance updated

### Failure Conditions

| Error Code | Trigger | HTTP |
|------------|---------|------|
| `COUNT_NOT_FOUND` | Missing count | 404 |
| `COUNT_NOT_DRAFT` | Not in draft status | 409 |
| `COUNT_CANCELED` | Count canceled | 409 |
| `COUNT_NO_LINES` | No lines | 400 |
| `COUNT_REASON_REQUIRED` | Variance line missing reason | 400 |
| `CYCLE_COUNT_UNIT_COST_REQUIRED` | Positive variance needs cost | 400 |
| `COUNT_RECONCILIATION_ESCALATION_REQUIRED` | Variance exceeds auto-adjust limit | 409 |
| `CYCLE_COUNT_RECONCILIATION_FAILED` | Reconciliation error | 500 |
| `INV_COUNT_POST_IDEMPOTENCY_CONFLICT` | Concurrent post | 409 |

### Postconditions

1. Adjustment movement exists for each variance
2. Recorded stock matches counted stock
3. Cost layers adjusted
4. Count execution record with metrics

### Audit Requirements

- Each variance line traceable to count line
- Reason code mandatory for all variance adjustments
- Metrics recorded for accuracy trending

---

## Command: Work Order Issue

### Purpose
Consume components from inventory for a work order (explicit material issue).

### Entry Point
`postWorkOrderIssue()` in `src/services/workOrderIssuePost.workflow.ts`

### Inputs

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| tenantId | uuid | yes | Tenant scope |
| workOrderId | uuid | yes | Work order |
| issueId | uuid | yes | Issue batch to post |
| idempotencyKey | string | yes | Deduplication key |

### Preconditions

1. Work order exists (`WO_NOT_FOUND`)
2. Issue batch exists and not canceled (`WO_ISSUE_NOT_FOUND`, `WO_ISSUE_CANCELED`)
3. Has lines (`WO_ISSUE_NO_LINES`)
4. Line quantities > 0 (`WO_ISSUE_INVALID_QUANTITY`)
5. Component items exist and match WO BOM
6. Sufficient available quantity at source locations
7. For disassembly: input items match disassembly WO type (`WO_DISASSEMBLY_INPUT_MISMATCH`)

### Locking

| Target | Scope |
|--------|-------|
| ATP advisory lock | (tenantId, warehouseId, itemId) per component |

### State Transitions

| From | To | Condition |
|------|-----|-----------|
| `available` | (consumed) | Component issued from storage |

### Inventory Movements Created

| Movement | Type | Status |
|----------|------|--------|
| Issue | `issue` | `posted` |

**Movement lines (per component line):**
- `quantity_delta` = -issued quantity
- `location_id` = source (production/storage) location
- `reason_code` = `work_order_issue` or `disassembly_issue`
- `source_type` = `work_order`
- `source_id` = workOrderId

### Side Effects

1. WIP cost layers created from consumed cost layers
2. Work order status may transition: draft/ready → in_progress
3. Cost layer consumption via FIFO
4. Inventory balance decremented
5. Inventory units consumed

### Failure Conditions

| Error Code | Trigger | HTTP |
|------------|---------|------|
| `WO_NOT_FOUND` | Missing work order | 404 |
| `WO_ISSUE_NOT_FOUND` | Missing issue batch | 404 |
| `WO_ISSUE_CANCELED` | Issue canceled | 409 |
| `WO_ISSUE_NO_LINES` | No issue lines | 400 |
| `WO_ISSUE_INVALID_QUANTITY` | Quantity ≤ 0 | 400 |
| `WO_ISSUE_LINE_NOT_FOUND` | Issue line missing | 404 |
| `WO_WIP_COST_LAYERS_MISSING` | Cost layers not created | 500 |

### Postconditions

1. Issue movement exists with negative deltas
2. Source inventory decreased
3. WIP cost layers created
4. Work order execution record created
5. Work order status reflects activity

### Audit Requirements

- Movement links to WO via `source_type`/`source_id`
- Each line traces to BOM component
- Cost layer chain: storage → WIP

---

## Command: Work Order Production (Completion)

### Purpose
Record finished goods production output from a work order.

### Entry Point
`postWorkOrderCompletion()` in `src/services/workOrderCompletionPost.workflow.ts`

### Inputs

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| tenantId | uuid | yes | Tenant scope |
| workOrderId | uuid | yes | Work order |
| lines | array | yes | Output lines (itemId, quantity, uom, toLocationId) |
| idempotencyKey | string | yes | Deduplication key |
| lotId | uuid | no | Output lot assignment |
| occurredAt | timestamptz | no | Production timestamp |

### Preconditions

1. Work order exists and status allows production (in_progress or partially_completed)
2. Output items match WO output specification
3. Quantities > 0
4. Destination location exists

### Locking

| Target | Scope |
|--------|-------|
| ATP advisory lock | (tenantId, warehouseId, outputItemId) per line |

### State Transitions

| From | To | Condition |
|------|-----|-----------|
| (none) | `received` | Output goes to QA location for QC |
| (none) | `available` | Output goes directly to sellable location |

### Inventory Movements Created

| Movement | Type | Status |
|----------|------|--------|
| Completion | `receive` | `posted` |

**Movement lines (per output line):**
- `quantity_delta` = +produced quantity
- `location_id` = output location (QA or sellable)
- `reason_code` = `work_order_completion` or `disassembly_completion`
- `source_type` = `work_order`
- `source_id` = workOrderId

### Side Effects

1. WIP cost allocated proportionally to output lines (remainder to final line)
2. Cost layers created for finished goods
3. Work order status may transition to partially_completed or completed
4. Lot traceability records if lot specified
5. Inventory units created at output location

### Failure Conditions

| Error Code | Trigger | HTTP |
|------------|---------|------|
| `WO_NOT_FOUND` | Missing work order | 404 |
| `WO_INVALID_STATE` | WO not in valid state for completion | 409 |
| `WO_WIP_COST_NO_CONSUMPTIONS` | No WIP to allocate | 409 |

### Postconditions

1. Receive movement exists with positive deltas
2. Output inventory at destination location
3. WIP cost allocated to finished goods cost layers
4. Work order progress updated
5. Lot genealogy recorded if applicable

---

## Command: Work Order Batch Record

### Purpose
Combined consume + produce in a single atomic operation.

### Entry Point
`recordWorkOrderBatch()` in `src/services/workOrderBatchRecord.workflow.ts`

### Inputs

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| tenantId | uuid | yes | Tenant scope |
| workOrderId | uuid | yes | Work order |
| consumeLines | array | yes | Components to consume |
| produceLines | array | yes | Outputs to produce |
| occurredAt | timestamptz | yes | Event timestamp |
| overrideNegative | boolean | no | Allow negative |
| overrideReason | string | no | Override reason |
| idempotencyKey | string | yes | Deduplication key |

### Inventory Movements Created

Two movements in same transaction:
1. Issue movement (type=`issue`) for consumeLines (negative deltas)
2. Receive movement (type=`receive`) for produceLines (positive deltas)

### Failure Conditions

| Error Code | Trigger | HTTP |
|------------|---------|------|
| `WO_NOT_FOUND` | Missing work order | 404 |
| `WO_BATCH_INVALID_CONSUME_QTY` | Consume quantity ≤ 0 | 400 |
| `WO_BATCH_INVALID_PRODUCE_QTY` | Produce quantity ≤ 0 | 400 |

### Postconditions

1. Both issue and receive movements exist
2. Components consumed, outputs produced
3. WIP cost flow: consumed cost → produced cost
4. Single idempotency key covers both movements

---

## Command: Work Order Production Report

### Purpose
Two-transaction production reporting: TX-1 for inventory, TX-2 for traceability.

### Entry Point
`reportWorkOrderProduction()` in `src/services/workOrderProductionReport.workflow.ts`

### Transaction Pattern

**TX-1 (Inventory):**
- Issue movement for components (backflush or explicit)
- Receive movement for outputs
- WIP cost allocation
- Idempotency claim

**TX-2 (Traceability):**
- Lot traceability records
- Input/output lot links
- Execution metadata

**Rule:** TX-1 failure aborts entire operation. TX-2 failure is logged but TX-1 inventory changes persist.

---

## Command: Work Order Reverse (Void Production)

### Purpose
Reverse a posted production execution: return components, remove output.

### Entry Point
`voidWorkOrderProductionReport()` in `src/services/workOrderVoidProduction.workflow.ts`

### Inputs

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| tenantId | uuid | yes | Tenant scope |
| workOrderId | uuid | yes | Work order |
| executionId | uuid | yes | Execution to void |
| reason | string | yes | Void reason |
| idempotencyKey | string | yes | Deduplication key |

### Preconditions

1. Execution exists and is posted (`WO_VOID_EXECUTION_NOT_FOUND`, `WO_VOID_EXECUTION_NOT_POSTED`)
2. Execution belongs to work order (`WO_VOID_EXECUTION_WORK_ORDER_MISMATCH`)
3. Execution has movements (`WO_VOID_EXECUTION_MOVEMENTS_MISSING`)
4. Output is at QA location (not yet put away) (`WO_VOID_OUTPUT_NOT_QA`)
5. Production cost layers exist (`WO_VOID_PRODUCTION_LAYER_MISSING`)
6. Movement type is valid for void (`WO_VOID_EXECUTION_MOVEMENT_TYPE_INVALID`)

### Locking

| Target | Scope |
|--------|-------|
| ATP advisory lock | (tenantId, warehouseId, itemId) per component + output |

### State Transitions

| From | To | Condition |
|------|-----|-----------|
| `received` | (removed) | Output reversed from QA location |
| (consumed) | `available` | Components returned to storage |

### Inventory Movements Created

Two reversal movements:
1. Component return (type=`receive`): positive delta returning components
   - `reason_code` = `work_order_void_component_return`
2. Output reversal (type=`issue`): negative delta removing output
   - `reason_code` = `work_order_void_output`

Both have `reversal_of_movement_id` pointing to original movements.

### Failure Conditions

| Error Code | Trigger | HTTP |
|------------|---------|------|
| `WO_VOID_EXECUTION_NOT_FOUND` | Execution missing | 404 |
| `WO_VOID_EXECUTION_NOT_POSTED` | Not posted | 409 |
| `WO_VOID_EXECUTION_WORK_ORDER_MISMATCH` | Wrong WO | 400 |
| `WO_VOID_EXECUTION_MOVEMENTS_MISSING` | No movements | 500 |
| `WO_VOID_OUTPUT_NOT_QA` | Output already moved | 409 |
| `WO_VOID_PRODUCTION_LAYER_MISSING` | Cost layers missing | 500 |
| `WO_VOID_EXECUTION_MOVEMENT_TYPE_INVALID` | Invalid movement type | 400 |
| `WO_VOID_INCOMPLETE` | Void failed | 500 |
| `WO_VOID_OUTPUT_LINE_NOT_FOUND` | Output line missing | 500 |
| `WO_VOID_COMPONENT_LINE_NOT_FOUND` | Component line missing | 500 |

### Postconditions

1. Original movements marked with `reversed_by_movement_id`
2. Reversal movements exist
3. Components back in storage
4. Output removed from QA location
5. WIP cost layers voided
6. Production cost layers voided
7. Execution status = voided
8. Work order status may revert

### Audit Requirements

- Reversal movements link to originals
- Void reason recorded in `reversal_reason`
- Full cost chain reversal traceable
