# Inventory Error Catalog

> Complete catalog of all error codes in the inventory system.
> Each entry defines the exact trigger condition, user-visible meaning, retryability, and idempotency interaction.

---

## Error Code Format

All error codes use `SCREAMING_SNAKE_CASE`. Reason codes use `lowercase_with_underscores`.

### Categories

| Category | Meaning |
|----------|---------|
| Validation | Input fails precondition check; fix input and retry |
| State | Entity is in wrong state for requested operation |
| Not Found | Referenced entity does not exist |
| Concurrency | Operation conflicts with a concurrent mutation |
| Configuration | System configuration is missing or invalid |
| Policy | Business rule prohibits the operation |
| Infrastructure | Internal system error |

---

## Ledger & Core Inventory Errors

### INVENTORY_MOVEMENT_SOURCE_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/domains/inventory/internal/ledgerWriter.ts` |
| **Trigger** | Movement type is `receive` or `transfer` and `sourceType` or `sourceId` is missing |
| **User Meaning** | Receive and transfer movements must reference their source (PO, QC event, etc.) |
| **Retryable** | Yes — provide sourceType and sourceId |
| **Idempotency** | N/A — fails before idempotency claim |

### INVENTORY_MOVEMENT_EXTERNAL_REF_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/domains/inventory/internal/ledgerWriter.ts` |
| **Trigger** | `ENFORCE_INVENTORY_MOVEMENT_EXTERNAL_REF` env var is true and `externalRef` is missing |
| **User Meaning** | External reference number is required by policy |
| **Retryable** | Yes — provide externalRef |
| **Idempotency** | N/A — fails before idempotency claim |

### INVENTORY_MOVEMENT_LINES_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/domains/inventory/internal/ledgerWriter.ts` |
| **Trigger** | Movement has zero lines |
| **User Meaning** | A movement must have at least one line |
| **Retryable** | Yes — provide lines |
| **Idempotency** | N/A — fails before idempotency claim |

### INVENTORY_MOVEMENT_LINE_SOURCE_LINE_ID_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/domains/inventory/internal/ledgerWriter.ts` |
| **Trigger** | A movement line is missing `sourceLineId` |
| **User Meaning** | Each line must have a source line identifier for traceability |
| **Retryable** | Yes — provide sourceLineId |
| **Idempotency** | N/A |

### INVENTORY_MOVEMENT_LINE_EVENT_TIMESTAMP_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/domains/inventory/internal/ledgerWriter.ts` |
| **Trigger** | A movement line is missing `eventTimestamp` |
| **User Meaning** | Each line must have a timestamp recording when the event occurred |
| **Retryable** | Yes — provide eventTimestamp |
| **Idempotency** | N/A |

### INVENTORY_MOVEMENT_LINE_REASON_CODE_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/domains/inventory/internal/ledgerWriter.ts` |
| **Trigger** | A movement line is missing `reasonCode` or it is blank |
| **User Meaning** | Each line must have a reason code explaining the inventory change |
| **Retryable** | Yes — provide reasonCode |
| **Idempotency** | N/A |

### MOVEMENT_CANONICAL_FIELDS_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/domains/inventory/internal/ledgerWriter.ts` |
| **Trigger** | `ENFORCE_CANONICAL_MOVEMENT_FIELDS` is true and canonical UOM fields are missing |
| **User Meaning** | Canonical quantity, UOM, and dimension fields are required |
| **Retryable** | Yes — provide canonical fields |
| **Idempotency** | N/A |

### INVENTORY_MOVEMENT_LINE_ACTION_INVALID

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/modules/platform/application/inventoryMovementLineSemantics.ts` |
| **Trigger** | Movement line parameters do not map to a valid action |
| **User Meaning** | The combination of movement type, quantity delta, and reason code is not recognized |
| **Retryable** | No — indicates a programming error |
| **Idempotency** | N/A |

### INVENTORY_STATE_TRANSITION_INVALID

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 400 |
| **File** | `src/modules/platform/application/inventoryMovementLineSemantics.ts` |
| **Trigger** | Attempted state transition is not in the allowed transitions list |
| **User Meaning** | The requested state change is not permitted from the current state |
| **Retryable** | No — business logic error |
| **Idempotency** | N/A |

### INVENTORY_UNIT_EVENT_REASON_CODE_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/domains/inventory/internal/inventoryUnits.ts` |
| **Trigger** | Inventory unit event missing reason code |
| **User Meaning** | Unit events must have a reason code |
| **Retryable** | No — indicates a programming error |
| **Idempotency** | N/A |

---

## ATP Lock Errors

### INVALID_ATP_LOCK_TARGET

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400/500 |
| **File** | `src/domains/inventory/internal/atpLocks.ts` |
| **Trigger** | Lock target has missing/invalid tenantId, warehouseId, or itemId |
| **User Meaning** | Internal error: lock targets are malformed |
| **Retryable** | No — indicates a programming error |
| **Idempotency** | N/A — fails before lock acquisition |

### ATP_LOCK_TARGETS_TOO_MANY

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 409 |
| **File** | `src/domains/inventory/internal/atpLocks.ts` |
| **Trigger** | More than 5000 lock targets in a single call |
| **User Meaning** | Operation affects too many item-location combinations |
| **Retryable** | No — split into smaller operations |
| **Idempotency** | N/A |

### ATP_LOCK_HASH_OFFSET_INVALID

| Field | Value |
|-------|-------|
| **Category** | Configuration |
| **HTTP** | 500 |
| **File** | `src/domains/inventory/internal/atpLocks.ts` |
| **Trigger** | Hash offset not in {0, 4, 8, 12, 16, 20, 24, 28} |
| **User Meaning** | Internal configuration error |
| **Retryable** | No — configuration fix required |
| **Idempotency** | N/A |

### ATP_LOCK_NOT_HELD

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 500 |
| **File** | `src/domains/inventory/internal/atpLocks.ts` |
| **Trigger** | `assertAtpLockHeldOrThrow()` called but lock context shows `held=false` |
| **User Meaning** | Internal error: mutation attempted without holding required lock |
| **Retryable** | No — indicates a programming error |
| **Idempotency** | N/A |

---

## Idempotency Errors

### IDEMPOTENCY_KEY_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/lib/transactionalIdempotency.ts` |
| **Trigger** | Idempotency key is null/undefined/empty |
| **User Meaning** | An idempotency key is required for this operation |
| **Retryable** | Yes — provide idempotency key |
| **Idempotency** | N/A |

### IDEMPOTENCY_REQUEST_HASH_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/modules/platform/application/runInventoryCommand.ts` |
| **Trigger** | Idempotency key provided but requestHash is missing |
| **User Meaning** | When using idempotency, the request hash must also be provided |
| **Retryable** | Yes — provide requestHash |
| **Idempotency** | N/A |

### IDEMPOTENCY_REQUIRES_TRANSACTION

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 500 |
| **File** | `src/lib/transactionalIdempotency.ts` |
| **Trigger** | Idempotency claim attempted outside a transaction |
| **User Meaning** | Internal error: idempotency requires a transaction context |
| **Retryable** | No — programming error |
| **Idempotency** | N/A |

### IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 409 |
| **File** | `src/lib/transactionalIdempotency.ts` |
| **Trigger** | Same idempotency key used for a different endpoint than the original |
| **User Meaning** | This idempotency key was already used for a different operation |
| **Retryable** | No — use a different key |
| **Idempotency** | Prevents cross-endpoint key reuse |

### IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 409 |
| **File** | `src/lib/transactionalIdempotency.ts` |
| **Trigger** | Same idempotency key used with a different request hash |
| **User Meaning** | This idempotency key was already used with different request data |
| **Retryable** | No — use same payload or a different key |
| **Idempotency** | Prevents payload mutation under same key |

### IDEMPOTENCY_REQUEST_IN_PROGRESS

| Field | Value |
|-------|-------|
| **Category** | Concurrency |
| **HTTP** | 409 |
| **File** | `src/lib/transactionalIdempotency.ts` |
| **Trigger** | Another transaction is currently processing the same idempotency key |
| **User Meaning** | This request is already being processed; retry after a short delay |
| **Retryable** | Yes — retry with backoff |
| **Idempotency** | Concurrent execution protection |

### IDEMPOTENCY_KEY_MISSING

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 500 |
| **File** | `src/lib/transactionalIdempotency.ts` |
| **Trigger** | Finalization attempted but no claim record found |
| **User Meaning** | Internal error: idempotency claim was not properly initialized |
| **Retryable** | No — programming error |
| **Idempotency** | N/A |

### IDEMPOTENCY_RESPONSE_STATUS_INVALID

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 500 |
| **File** | `src/lib/transactionalIdempotency.ts` |
| **Trigger** | Response status code is not a valid HTTP status |
| **User Meaning** | Internal error: invalid response status in idempotency finalization |
| **Retryable** | No — programming error |
| **Idempotency** | N/A |

### IDEMPOTENCY_MISSING_CLAIM

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 500 |
| **File** | `src/lib/transactionalIdempotency.ts` |
| **Trigger** | Expected idempotency claim not found during finalization |
| **User Meaning** | Internal error |
| **Retryable** | No — programming error |
| **Idempotency** | N/A |

---

## Receipt Errors

### RECEIPT_PO_NOT_FOUND

| Field | Value |
|-------|-------|
| **Category** | Not Found |
| **HTTP** | 404 |
| **File** | `src/services/receipts.service.ts` |
| **Trigger** | Purchase order does not exist for the tenant |
| **User Meaning** | The specified purchase order was not found |
| **Retryable** | No — PO must exist |
| **Idempotency** | N/A — fails before claim |

### RECEIPT_PO_NOT_APPROVED

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **File** | `src/services/receipts.service.ts` |
| **Trigger** | PO status ≠ `approved` |
| **User Meaning** | The purchase order must be approved before receiving |
| **Retryable** | Yes — after PO is approved |
| **Idempotency** | N/A |

### RECEIPT_NOT_FOUND

| Field | Value |
|-------|-------|
| **Category** | Not Found |
| **HTTP** | 404 |
| **File** | `src/services/receipts.service.ts` |
| **Trigger** | Receipt ID does not exist |
| **User Meaning** | The specified receipt was not found |
| **Retryable** | No |
| **Idempotency** | N/A |

### RECEIPT_ALREADY_REVERSED

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **File** | `src/services/receipts.service.ts` |
| **Trigger** | Receipt has already been voided |
| **User Meaning** | This receipt has already been reversed |
| **Retryable** | No — already voided |
| **Idempotency** | Safe — void is idempotent |

### RECEIPT_HAS_PUTAWAYS_POSTED

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **File** | `src/services/receipts.service.ts` |
| **Trigger** | Putaways exist against this receipt |
| **User Meaning** | Cannot void a receipt that has been put away; void putaways first |
| **Retryable** | Yes — after putaways are voided |
| **Idempotency** | N/A |

### RECEIPT_REVERSAL_NOT_POSSIBLE_CONSUMED

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **File** | `src/services/receipts.service.ts` |
| **Trigger** | Cost layers from receipt have been consumed by downstream operations |
| **User Meaning** | Cannot void a receipt whose inventory has been consumed |
| **Retryable** | No — irreversible |
| **Idempotency** | N/A |

---

## QC Errors

### QC_SOURCE_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/services/qc.service.ts` |
| **Trigger** | Missing sourceType or sourceId |
| **Retryable** | Yes |

### QC_ITEM_ID_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/services/qc.service.ts` |
| **Trigger** | Missing itemId |
| **Retryable** | Yes |

### QC_LOCATION_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/services/qc.service.ts` |
| **Trigger** | Missing locationId |
| **Retryable** | Yes |

### QC_QA_LOCATION_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Configuration |
| **HTTP** | 400 |
| **File** | `src/services/qc.service.ts` |
| **Trigger** | Warehouse has no configured QA location |
| **Retryable** | Yes — after configuration |

### QC_ACCEPT_LOCATION_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Configuration |
| **HTTP** | 400 |
| **File** | `src/services/qc.service.ts` |
| **Trigger** | Warehouse has no configured accept location |
| **Retryable** | Yes — after configuration |

### QC_HOLD_LOCATION_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Configuration |
| **HTTP** | 400 |
| **File** | `src/services/qc.service.ts` |
| **Trigger** | Warehouse has no configured hold location |
| **Retryable** | Yes — after configuration |

### QC_REJECT_LOCATION_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Configuration |
| **HTTP** | 400 |
| **File** | `src/services/qc.service.ts` |
| **Trigger** | Warehouse has no configured reject location |
| **Retryable** | Yes — after configuration |

### QC_SOURCE_MUST_BE_QA

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/domain/transfers/transferPolicy.ts` |
| **Trigger** | QC action source location does not have QA role |
| **Retryable** | No — wrong location |

### QC_ACCEPT_REQUIRES_SELLABLE_ROLE

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/domain/transfers/transferPolicy.ts` |
| **Trigger** | QC accept destination does not have sellable role |
| **Retryable** | No — wrong destination |

### QC_ACCEPT_REQUIRES_SELLABLE_FLAG

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/domain/transfers/transferPolicy.ts` |
| **Trigger** | QC accept destination has sellable role but is_sellable=false |
| **Retryable** | No — configuration issue |

### QC_HOLD_REQUIRES_HOLD_ROLE

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/domain/transfers/transferPolicy.ts` |
| **Trigger** | QC hold destination does not have hold role |
| **Retryable** | No — wrong destination |

### QC_HOLD_MUST_NOT_BE_SELLABLE

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/domain/transfers/transferPolicy.ts` |
| **Trigger** | QC hold destination is marked sellable |
| **Retryable** | No — configuration issue |

### QC_REJECT_REQUIRES_REJECT_ROLE

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/domain/transfers/transferPolicy.ts` |
| **Trigger** | QC reject destination does not have reject role |
| **Retryable** | No — wrong destination |

### QC_REJECT_MUST_NOT_BE_SELLABLE

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/domain/transfers/transferPolicy.ts` |
| **Trigger** | QC reject destination is marked sellable |
| **Retryable** | No — configuration issue |

### QC_EXCEEDS_RECEIPT

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/services/qc.service.ts` |
| **Trigger** | QC quantity exceeds unprocessed receipt quantity |
| **Retryable** | No — reduce quantity |

### QC_EXCEEDS_WORK_ORDER

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/services/qc.service.ts` |
| **Trigger** | QC quantity exceeds unprocessed WO output |
| **Retryable** | No — reduce quantity |

### QC_EXCEEDS_EXECUTION

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/services/qc.service.ts` |
| **Trigger** | QC quantity exceeds unprocessed execution output |
| **Retryable** | No — reduce quantity |

### QC_UOM_MISMATCH

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/services/qc.service.ts` |
| **Trigger** | QC UOM does not match source UOM |
| **Retryable** | Yes — correct UOM |

### QC_RECEIPT_ALLOCATION_INSUFFICIENT_QA

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **File** | `src/services/qc.service.ts` |
| **Trigger** | Insufficient quantity in QA allocation status |
| **Retryable** | No — allocation state mismatch |

### QC_RECEIPT_VOIDED

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **File** | `src/services/qc.service.ts` |
| **Trigger** | Source receipt has been voided |
| **Retryable** | No — receipt is void |

### QC_RECEIPT_NOT_ELIGIBLE

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **File** | `src/services/qc.service.ts` |
| **Trigger** | Receipt not eligible for QC action |
| **Retryable** | No |

---

## Transfer Errors

### TRANSFER_INVALID_QUANTITY

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/domain/transfers/transferPolicy.ts` |
| **Trigger** | Quantity ≤ 0 |
| **Retryable** | Yes — provide positive quantity |

### TRANSFER_SAME_LOCATION

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/domain/transfers/transferPolicy.ts` |
| **Trigger** | Source location = destination location |
| **Retryable** | Yes — use different locations |

### TRANSFER_SOURCE_NOT_FOUND

| Field | Value |
|-------|-------|
| **Category** | Not Found |
| **HTTP** | 404 |
| **File** | `src/domain/transfers/transferPolicy.ts` |
| **Trigger** | Source location does not exist |
| **Retryable** | No |

### TRANSFER_DESTINATION_NOT_FOUND

| Field | Value |
|-------|-------|
| **Category** | Not Found |
| **HTTP** | 404 |
| **File** | `src/domain/transfers/transferPolicy.ts` |
| **Trigger** | Destination location does not exist |
| **Retryable** | No |

### TRANSFER_CROSS_WAREHOUSE_NOT_ALLOWED

| Field | Value |
|-------|-------|
| **Category** | Policy |
| **HTTP** | 400 |
| **File** | `src/domain/transfers/transferPolicy.ts` |
| **Trigger** | Source and destination are in different warehouses |
| **Retryable** | No — same-warehouse transfers only |

### TRANSFER_VOID_REASON_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/services/transfers.service.ts` |
| **Trigger** | Void requested without reason |
| **Retryable** | Yes — provide reason |

### TRANSFER_VOID_CONFLICT

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **File** | `src/services/transfers.service.ts` |
| **Trigger** | Transfer already reversed |
| **Retryable** | No — already voided |

### TRANSFER_REPLAY_SCOPE_UNRESOLVED

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 500 |
| **File** | `src/services/transfers.service.ts` |
| **Trigger** | Replay could not resolve warehouse scope |
| **Retryable** | No — internal error |

### TRANSFER_REPLAY_MOVEMENT_ID_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 500 |
| **File** | `src/services/transfers.service.ts` |
| **Trigger** | Replay result missing movement ID |
| **Retryable** | No — internal error |

### TRANSFER_REVERSAL_PREPARE_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 500 |
| **File** | `src/services/transfers.service.ts` |
| **Trigger** | Reversal attempted without preparation |
| **Retryable** | No — internal error |

---

## Putaway Errors

### PUTAWAY_RECEIPT_VOIDED

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **Trigger** | Source receipt has been voided |
| **Retryable** | No |

### PUTAWAY_UOM_MISMATCH

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | UOM does not match allocation UOM |
| **Retryable** | Yes — correct UOM |

### PUTAWAY_FROM_LOCATION_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Missing from location |
| **Retryable** | Yes |

### PUTAWAY_SAME_LOCATION

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Source = destination location |
| **Retryable** | Yes — use different destination |

### PUTAWAY_DUPLICATE_LINE

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Same allocation ID appears multiple times in lines |
| **Retryable** | Yes — deduplicate lines |

### PUTAWAY_BLOCKED

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **Trigger** | Pending QC blocks putaway |
| **Retryable** | Yes — after QC completes |

### PUTAWAY_QUANTITY_EXCEEDED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Putaway quantity > allocation remaining |
| **Retryable** | Yes — reduce quantity |

### PUTAWAY_NOT_FOUND

| Field | Value |
|-------|-------|
| **Category** | Not Found |
| **HTTP** | 404 |
| **Trigger** | Putaway record does not exist |
| **Retryable** | No |

### PUTAWAY_ALLOCATION_INSUFFICIENT_QA

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **Trigger** | Insufficient available allocation |
| **Retryable** | Yes — after QC accept |

---

## Count & Adjustment Errors

### COUNT_NOT_FOUND

| Field | Value |
|-------|-------|
| **Category** | Not Found |
| **HTTP** | 404 |
| **Trigger** | Count record does not exist |

### COUNT_NOT_DRAFT

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **Trigger** | Count is not in draft status |

### COUNT_CANCELED

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **Trigger** | Count has been canceled |

### COUNT_NO_LINES

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Count has zero lines |

### COUNT_DUPLICATE_LINE

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Duplicate source line IDs in count |

### COUNT_DUPLICATE_ITEM

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Same item counted twice at same location |

### COUNT_LOCATION_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Count line missing location |

### COUNT_REASON_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Variance line missing reason code |

### CYCLE_COUNT_UNIT_COST_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Positive variance (found stock) without unit cost |

### COUNT_RECONCILIATION_ESCALATION_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **Trigger** | Variance exceeds auto-adjust limit; manual override required |
| **Retryable** | Yes — with override |

### CYCLE_COUNT_RECONCILIATION_FAILED

| Field | Value |
|-------|-------|
| **Category** | Infrastructure |
| **HTTP** | 500 |
| **Trigger** | Reconciliation process failed |
| **Retryable** | Yes — retry the post |

### INV_COUNT_POST_IDEMPOTENCY_CONFLICT

| Field | Value |
|-------|-------|
| **Category** | Concurrency |
| **HTTP** | 409 |
| **Trigger** | Concurrent count post for same count |
| **Retryable** | Yes — retry with backoff |

### INV_COUNT_POST_IDEMPOTENCY_INCOMPLETE

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **Trigger** | Previous post attempt did not complete |
| **Retryable** | Yes — retry |

### ADJUSTMENT_NOT_FOUND

| Field | Value |
|-------|-------|
| **Category** | Not Found |
| **HTTP** | 404 |
| **Trigger** | Adjustment record does not exist |

### ADJUSTMENT_ALREADY_POSTED

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **Trigger** | Adjustment already posted |

### ADJUSTMENT_ALREADY_CANCELED

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **Trigger** | Adjustment already canceled |

### ADJUSTMENT_NO_LINES

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Adjustment has zero lines |

### ADJUSTMENT_LINE_ZERO

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Adjustment line has zero quantity |

### ADJUSTMENT_REASON_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Adjustment line missing reason code |

### ADJUSTMENT_POST_INCOMPLETE

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 500 |
| **Trigger** | Adjustment post failed mid-execution |
| **Retryable** | Yes — retry |

### ADJUSTMENT_IMMUTABLE

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **Trigger** | Posted/canceled adjustment cannot be modified |

---

## Work Order Errors

### WO_NOT_FOUND

| Field | Value |
|-------|-------|
| **Category** | Not Found |
| **HTTP** | 404 |
| **Trigger** | Work order does not exist |

### WO_INVALID_STATE

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **Trigger** | WO not in valid state for requested operation |

### WO_STATUS_TRANSITION_INVALID

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **Trigger** | Requested status transition is not allowed |

### WO_ISSUE_NOT_FOUND

| Field | Value |
|-------|-------|
| **Category** | Not Found |
| **HTTP** | 404 |
| **Trigger** | Issue batch does not exist |

### WO_ISSUE_CANCELED

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **Trigger** | Issue batch is canceled |

### WO_ISSUE_NO_LINES

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Issue batch has no lines |

### WO_ISSUE_INVALID_QUANTITY

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Issue line quantity ≤ 0 |

### WO_ISSUE_LINE_NOT_FOUND

| Field | Value |
|-------|-------|
| **Category** | Not Found |
| **HTTP** | 404 |
| **Trigger** | Issue line not found |

### WO_WIP_COST_LAYERS_MISSING

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 500 |
| **Trigger** | Expected WIP cost layers were not created |

### WO_WIP_COST_NO_CONSUMPTIONS

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **Trigger** | Completion attempted with no WIP cost to allocate |
| **Retryable** | Yes — issue components first |

### WO_BATCH_INVALID_CONSUME_QTY

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Batch consume quantity ≤ 0 |

### WO_BATCH_INVALID_PRODUCE_QTY

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Batch produce quantity ≤ 0 |

### WO_BOM_NOT_FOUND / WO_BOM_ITEM_MISMATCH / WO_BOM_VERSION_NOT_FOUND / WO_BOM_VERSION_MISMATCH

| Field | Value |
|-------|-------|
| **Category** | Validation/Not Found |
| **HTTP** | 400/404 |
| **Trigger** | BOM validation failures |

### WO_BOM_LEGACY_UNSUPPORTED

| Field | Value |
|-------|-------|
| **Category** | Policy |
| **HTTP** | 400 |
| **Trigger** | Legacy BOM format not supported |

### WO_DISASSEMBLY_INPUT_MISMATCH

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Disassembly input does not match expected item |

### WO_VOID_EXECUTION_NOT_FOUND

| Field | Value |
|-------|-------|
| **Category** | Not Found |
| **HTTP** | 404 |
| **Trigger** | Execution to void does not exist |

### WO_VOID_EXECUTION_NOT_POSTED

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **Trigger** | Execution is not in posted status |

### WO_VOID_EXECUTION_WORK_ORDER_MISMATCH

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Execution does not belong to specified work order |

### WO_VOID_EXECUTION_MOVEMENTS_MISSING

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 500 |
| **Trigger** | Expected movements for execution not found |

### WO_VOID_OUTPUT_NOT_QA

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **Trigger** | Output has been moved from QA location; void is blocked |
| **User Meaning** | Cannot void production after output has been accepted and put away |
| **Retryable** | No — output has been consumed downstream |

### WO_VOID_PRODUCTION_LAYER_MISSING

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 500 |
| **Trigger** | Production cost layers not found for void |

### WO_VOID_EXECUTION_MOVEMENT_TYPE_INVALID

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Movement type not valid for void operation |

### WO_VOID_INCOMPLETE

| Field | Value |
|-------|-------|
| **Category** | Infrastructure |
| **HTTP** | 500 |
| **Trigger** | Void operation did not complete |
| **Retryable** | Yes — retry |

### WO_VOID_OUTPUT_LINE_NOT_FOUND / WO_VOID_COMPONENT_LINE_NOT_FOUND

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 500 |
| **Trigger** | Expected line not found during void |

### WO_VOID_REASON_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Void requested without reason |

### WO_SCRAP_REASON_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Scrap recorded without reason |

### WO_RESERVATION_CORRUPT / WO_RESERVATION_MISSING / WO_RESERVATION_SHORTAGE

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409/500 |
| **Trigger** | Reservation integrity failures during WO execution |

### WO_WIP_VALUATION_RECORD_MISSING

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 500 |
| **Trigger** | WIP valuation tracking inconsistent |

### WO_ROUTING_LOCATION_OVERRIDE_FORBIDDEN

| Field | Value |
|-------|-------|
| **Category** | Policy |
| **HTTP** | 400 |
| **Trigger** | Routing location override not permitted |

---

## Order-to-Cash Errors

### ATP_INSUFFICIENT_AVAILABLE

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **Trigger** | Available quantity insufficient for operation |
| **Retryable** | Yes — after stock replenishment |

### ATP_CONCURRENCY_EXHAUSTED

| Field | Value |
|-------|-------|
| **Category** | Concurrency |
| **HTTP** | 503 |
| **Trigger** | Exceeded maximum retry attempts for serializable transaction |
| **Retryable** | Yes — retry with backoff |

### RESERVATION_NOT_FOUND

| Field | Value |
|-------|-------|
| **Category** | Not Found |
| **HTTP** | 404 |
| **Trigger** | Reservation does not exist |

### RESERVATION_CONFLICT

| Field | Value |
|-------|-------|
| **Category** | Concurrency |
| **HTTP** | 409 |
| **Trigger** | Concurrent modification of reservation |
| **Retryable** | Yes — retry |

### RESERVATION_ALLOCATE_IN_PROGRESS / RESERVATION_CANCEL_IN_PROGRESS / RESERVATION_FULFILL_IN_PROGRESS

| Field | Value |
|-------|-------|
| **Category** | Concurrency |
| **HTTP** | 409 |
| **Trigger** | Concurrent operation on same reservation |
| **Retryable** | Yes — retry with backoff |

### SHIPMENT_NOT_FOUND

| Field | Value |
|-------|-------|
| **Category** | Not Found |
| **HTTP** | 404 |
| **Trigger** | Shipment does not exist |

### SHIPMENT_CANCELED

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **Trigger** | Shipment is canceled |

### SHIPMENT_NO_LINES

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Shipment has no lines |

### SHIPMENT_INVALID_QUANTITY

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Shipment line quantity ≤ 0 |

### CROSS_WAREHOUSE_LEAKAGE_BLOCKED

| Field | Value |
|-------|-------|
| **Category** | Policy |
| **HTTP** | 400 |
| **Trigger** | Shipment lines reference items in different warehouses |

### SHIPMENT_POST_FAILED

| Field | Value |
|-------|-------|
| **Category** | Infrastructure |
| **HTTP** | 500 |
| **Trigger** | Shipment post failed |
| **Retryable** | Yes — retry |

---

## Replay & Corruption Errors

### REPLAY_CORRUPTION_DETECTED

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 500 |
| **File** | `src/modules/platform/application/inventoryMutationSupport.ts` |
| **Trigger** | Deterministic hash of replayed movement does not match original |
| **User Meaning** | Data integrity violation: replayed operation produced different result |
| **Retryable** | No — requires investigation |
| **Idempotency** | Corruption guard — prevents divergent replays |

### RECEIPT_AUTHORITATIVE_DATA_INCONSISTENT

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 500 |
| **File** | `src/domain/receipts/receiptAllocationRebuilder.ts` |
| **Trigger** | Authoritative receipt data does not match projected state |
| **Retryable** | No — requires data investigation |

---

## UOM Errors

### UOM_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | UOM not provided |

### UOM_DIMENSION_MISMATCH

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | UOM conversion between incompatible dimensions |

### ITEM_NOT_FOUND

| Field | Value |
|-------|-------|
| **Category** | Not Found |
| **HTTP** | 404 |
| **Trigger** | Item does not exist |

### ITEM_CANONICAL_UOM_REQUIRED / ITEM_CANONICAL_UOM_INVALID

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Item canonical UOM missing or invalid |

---

## Inventory Unit Authority Errors

### INVENTORY_UNIT_CONSUMPTION_QUANTITY_INVALID

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **File** | `src/modules/platform/application/inventoryUnitAuthority.ts` |
| **Trigger** | Consumption quantity ≤ 0 |

### INVENTORY_UNIT_INSUFFICIENT_AVAILABLE

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 409 |
| **File** | `src/modules/platform/application/inventoryUnitAuthority.ts` |
| **Trigger** | Available unit quantity insufficient for FIFO consumption |

### INVENTORY_UNIT_SOURCE_EVENT_MISSING

| Field | Value |
|-------|-------|
| **Category** | State |
| **HTTP** | 500 |
| **File** | `src/modules/platform/application/inventoryUnitAuthority.ts` |
| **Trigger** | Source event for unit reconstruction not found |

---

## Warehouse & Location Errors

### WAREHOUSE_SCOPE_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Operation requires warehouse scope |

### WAREHOUSE_SCOPE_MISMATCH

| Field | Value |
|-------|-------|
| **Category** | Validation |
| **HTTP** | 400 |
| **Trigger** | Entity warehouse does not match request warehouse |

### LOCATION_NOT_FOUND

| Field | Value |
|-------|-------|
| **Category** | Not Found |
| **HTTP** | 404 |
| **Trigger** | Location does not exist |

### WAREHOUSE_DEFAULT_LOCATIONS_REQUIRED

| Field | Value |
|-------|-------|
| **Category** | Configuration |
| **HTTP** | 400 |
| **Trigger** | Warehouse missing required default location configuration |

---

## Reason Codes

| Code | Category | Used By |
|------|----------|---------|
| `transfer` | Transfer | Standard transfer movements |
| `qc_release` | QC | QC accept transfer |
| `qc_hold` | QC | QC hold transfer |
| `qc_reject` | QC | QC reject transfer |
| `receipt_void_reversal` | Receipt | Receipt void reversal movement |
| `work_order_issue` | Manufacturing | Component consumption |
| `work_order_completion` | Manufacturing | Production output |
| `work_order_backflush` | Manufacturing | Automatic component consumption |
| `work_order_backflush_override` | Manufacturing | Modified automatic consumption |
| `work_order_production_receipt` | Manufacturing | Production receipt |
| `work_order_scrap` | Manufacturing | Scrap output |
| `work_order_reject` | Manufacturing | Rejected output |
| `work_order_void_output` | Manufacturing | Void production output |
| `work_order_void_component_return` | Manufacturing | Void component return |
| `work_order_reservation_sync` | Manufacturing | Reservation synchronization |
| `disassembly_issue` | Manufacturing | Disassembly input consumption |
| `disassembly_completion` | Manufacturing | Disassembly output |
| `cycle_count_adjustment` | Counting | Count variance adjustment |
| `shipment` | Fulfillment | Shipment issue |
| `lpn_transfer_out` | License Plate | LPN outbound transfer |
| `lpn_transfer_in` | License Plate | LPN inbound transfer |
