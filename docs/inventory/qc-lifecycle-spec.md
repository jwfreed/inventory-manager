# QC Lifecycle Specification

> Complete behavioral specification for quality control workflows.
> Defines the QC state machine, partial acceptance, lot handling, downstream blocking,
> reversal rules, and all cross-workflow interactions.

---

## QC Architecture

### Entry Points

| Entry Point | File | Source Type |
|-------------|------|------------|
| `createQcEvent()` | `src/services/qc.service.ts` | `receipt`, `work_order`, `execution_line` |
| `postQcWarehouseDisposition()` | `src/services/qc.service.ts` | Direct warehouse action |

### Mechanism

QC does not maintain its own inventory state. Instead, QC actions trigger **inventory transfers** between purpose-designated locations:

- **QA location** → inventory awaiting QC decision
- **Accept location** → sellable storage (role=sellable, is_sellable=true)
- **Hold location** → non-sellable hold (role=hold, is_sellable=false)
- **Reject location** → non-sellable reject (role=reject, is_sellable=false)

All QC state transitions are realized as `transfer` movements through `transferInventory()`.

---

## QC State Machine

### States

| State | Location Role | Inventory State | Available for Demand |
|-------|--------------|----------------|---------------------|
| Pending QC | QA | `received` | No |
| Accepted | Sellable | `available` | Yes |
| On Hold | Hold | `qc_hold` | No |
| Rejected | Reject | `qc_hold` | No |

### Transitions

```
                    ┌──────────────┐
                    │  Pending QC  │  (QA location, state=received)
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ Accepted │ │ On Hold  │ │ Rejected │
        └──────────┘ └────┬─────┘ └──────────┘
                          │
                    ┌─────┴─────┐
                    ▼           ▼
              ┌──────────┐ ┌──────────┐
              │ Accepted │ │ Rejected │
              └──────────┘ └──────────┘
```

### Allowed Transitions

| From | To | Action | Reason Code | Movement Type |
|------|-----|--------|-------------|---------------|
| Pending QC | Accepted | `accept` | `qc_release` | `transfer` |
| Pending QC | On Hold | `hold` | `qc_hold` | `transfer` |
| Pending QC | Rejected | `reject` | `qc_reject` | `transfer` |
| On Hold | Accepted | `accept` | `qc_release` | `transfer` |
| On Hold | Rejected | `reject` | `qc_reject` | `transfer` |

### Forbidden Transitions

| From | To | Reason |
|------|-----|--------|
| Accepted | On Hold | Accepted inventory must be adjusted or returned, not re-held |
| Accepted | Rejected | Accepted inventory cannot be retroactively rejected |
| Rejected | Accepted | Rejected inventory requires new receipt or return disposition |
| Rejected | On Hold | Rejected is terminal within QC; requires NCR process |
| Shipped | Any QC state | Shipped inventory has left the system |

---

## QC Source Types

### Receipt QC

**Trigger:** Receipt posted to QA location.

**Workflow:**
1. Receipt creates inventory at QA location with receipt allocations (status=QA)
2. QC operator inspects goods
3. QC event created with action (accept/hold/reject) and quantity
4. System transfers inventory from QA to target location
5. Receipt allocations updated: QA → AVAILABLE (accept) or QA → HOLD (hold/reject)

**Receipt Allocation Status Mapping:**

| QC Action | Allocation From | Allocation To |
|-----------|----------------|---------------|
| accept | QA | AVAILABLE |
| hold | QA | HOLD |
| reject | QA | HOLD |

**Lifecycle evaluation:** After each QC event, the system evaluates whether the receipt is fully QC'd:
- Sum of (accepted + held + rejected) quantities vs received quantity
- When fully evaluated, receipt lifecycle transitions appropriately

### Work Order QC

**Trigger:** Work order production output posted to QA location.

**Workflow:**
1. Work order completion creates output at QA/production location
2. QC operator inspects output
3. QC event created via `createWorkOrderQcEvent()`
4. System transfers from QA to target location
5. No receipt allocation management (WO-specific tracking)

**Constraint:** Void of production is only allowed while output is still at QA location (`WO_VOID_OUTPUT_NOT_QA`).

### Execution Line QC

**Trigger:** Individual execution line output requires QC.

**Workflow:**
1. Similar to Work Order QC but scoped to a single execution line
2. QC event created via `createExecutionLineQcEvent()`
3. Transfer from QA to target location

---

## Partial Acceptance

### Rules

1. A receipt or WO output can be partially accepted: some quantity accepted, some held, some rejected
2. Each QC event operates on a specific quantity — not the full receipt
3. Multiple QC events can be posted against the same source
4. Cumulative accepted + held + rejected must not exceed the original received quantity

### Quantity Tracking

```
received_quantity = 100
qc_event_1: accept 80  → cumulative: accepted=80, held=0, rejected=0
qc_event_2: hold 15    → cumulative: accepted=80, held=15, rejected=0
qc_event_3: reject 5   → cumulative: accepted=80, held=15, rejected=5
Total: 100 = fully evaluated
```

### Enforcement

| Condition | Error Code |
|-----------|-----------|
| QC quantity exceeds unprocessed remainder (receipt) | `QC_EXCEEDS_RECEIPT` |
| QC quantity exceeds unprocessed remainder (WO) | `QC_EXCEEDS_WORK_ORDER` |
| QC quantity exceeds unprocessed remainder (execution) | `QC_EXCEEDS_EXECUTION` |
| Insufficient QA allocation quantity | `QC_RECEIPT_ALLOCATION_INSUFFICIENT_QA` |
| UOM mismatch with source | `QC_UOM_MISMATCH` |

### Edge Cases

1. **Zero remaining:** If all quantity is already QC'd, further QC events are rejected with exceeds-quantity error
2. **Void after partial QC:** Receipt void is blocked if any putaways have been posted. QC'd allocations at QA-adjacent locations must be returned first
3. **Concurrent QC events:** Serialized via ATP locks on (tenantId, warehouseId, itemId); second event sees updated allocation state

---

## Lot Handling in QC

### Receipt Lots

- Receipt lines may specify `lotId`
- QC events inherit the lot from the receipt allocation
- Transfer movements during QC carry `lotId` through to destination
- Inventory units at destination preserve lot chain

### Work Order Lots

- Production output may have `lotId` assigned at completion
- QC events for WO output carry the output lot
- Lot genealogy (input lots → output lot) recorded separately by `lotTraceabilityEngine`

### Lot Integrity Rule

QC events must not change the lot assignment. The lot flows through QC unchanged:
- `receipt lot → QA inventory → QC transfer → accepted/held/rejected inventory` (same lot)

---

## Downstream Blocking Behavior

### What QC Blocks

| Operation | Blocked When | Reason |
|-----------|-------------|--------|
| Allocation | Inventory at QA or hold location | State ≠ `available`; cannot serve demand |
| Picking | Inventory at QA or hold location | Not allocatable, therefore not pickable |
| Shipment | Inventory at QA or hold location | Cannot ship unaccepted goods |
| WO Issue | Inventory at QA or hold location | Cannot consume unaccepted material |
| Transfer (manual) | Inventory at QA location | Must go through QC workflow, not manual transfer |
| Putaway | Pending QC (allocations in QA status) | `PUTAWAY_BLOCKED` — must accept before putaway |

### What QC Does NOT Block

| Operation | Allowed When |
|-----------|-------------|
| Cycle count | Only on `available`/`adjusted` inventory at sellable locations |
| Receipt void | If no putaways posted and cost layers unconsumed |
| WO void | If output still at QA location |

### Putaway-QC Interaction

1. Receipt posts to QA location → allocations status=QA
2. QC accept → allocations status=AVAILABLE, inventory at accept location
3. Putaway → transfers from accept location to storage location
4. **Rule:** Putaway is blocked until QC accept has run for the target allocations
5. If QC hold/reject, those allocations remain at hold/reject locations — putaway is not applicable

---

## Reversal Rules

### QC Accept Reversal

- **Not directly reversible.** Once accepted, inventory is `available` and may be allocated, shipped, or consumed.
- To correct a mistaken accept: post an adjustment or transfer the inventory back to a hold location via manual intervention.
- If inventory has been consumed (shipped, WO issued), reversal is impossible.

### QC Hold Reversal

- **Reversible via subsequent QC event.** Held inventory can be re-evaluated:
  - Hold → Accept: `createQcEvent(action='accept')` on held inventory
  - Hold → Reject: `createQcEvent(action='reject')` on held inventory
- Transfer from hold location to target location created

### QC Reject Reversal

- **Not reversible via QC.** Rejected inventory requires NCR process.
- NCR disposition may result in: return to vendor, scrap, or rework
- Rework creates new inventory through a separate receipt or WO output

### Receipt Void After QC

- Receipt can be voided only if:
  1. No putaways have been posted
  2. Cost layers have not been consumed
  3. Receipt allocations can be invalidated
- QC events themselves are not voided; the underlying receipt void reverses the inventory movement
- **Rule:** If partial QC has been performed and putaways exist, receipt void is blocked

---

## Cross-Workflow Interactions

### QC × Allocation

- Inventory at QA or hold locations cannot be allocated
- QC accept makes inventory allocatable by moving it to a sellable location
- ATP calculation: only inventory at sellable locations with state=`available` counts toward available-to-promise
- Consequence: QC backlog directly reduces effective inventory availability

### QC × Transfer

- QC events generate transfer movements internally
- Manual transfers of QA inventory are forbidden
- Post-QC inventory at sellable locations is freely transferable
- QC transfers use dedicated reason codes (`qc_release`, `qc_hold`, `qc_reject`) distinct from manual transfer reason code (`transfer`)

### QC × Work Orders

**As consumer:**
- Work order issue cannot consume QA or held inventory
- Components must be accepted (available) before they can be issued to a WO
- This prevents consuming potentially defective material

**As producer:**
- Work order output posted to QA location enters QC workflow
- Output must be QC-accepted before it can be shipped or used as input to another WO
- WO void is blocked once output has been QC-accepted and put away

### QC × Counting

- Inventory at QA location is excluded from cycle counts
- Only `available` and `adjusted` inventory at sellable locations is countable
- QC hold inventory at hold locations is excluded from counts
- This prevents count adjustments on inventory whose quantity is still being evaluated

### QC × Shipment

- Shipment can only issue from sellable locations
- QA and hold locations are not sellable
- Inventory must complete QC and be at a sellable location before it can be shipped
- Direct ship from QA: **forbidden**

### QC × Returns

- Returned goods enter at QA location (same as receipts)
- Return disposition creates a QC-like workflow for returned inventory
- Accepted returns follow standard QC → putaway flow
- Rejected returns follow return-to-vendor or scrap disposition

---

## Location Role Requirements

### Warehouse Default Locations

Each warehouse must configure the following locations for QC to function:

| Default | Role | is_sellable | Purpose |
|---------|------|-------------|---------|
| `qa_location_id` | QA | false | Receiving inspection |
| `accept_location_id` | Sellable | true | Accepted goods staging |
| `hold_location_id` | Hold | false | Held goods |
| `reject_location_id` | Reject | false | Rejected goods |

**Missing configuration errors:**

| Error Code | Condition |
|-----------|-----------|
| `QC_QA_LOCATION_REQUIRED` | Warehouse has no QA location configured |
| `QC_ACCEPT_LOCATION_REQUIRED` | Warehouse has no accept location configured |
| `QC_HOLD_LOCATION_REQUIRED` | Warehouse has no hold location configured |
| `QC_REJECT_LOCATION_REQUIRED` | Warehouse has no reject location configured |

### Location Validation on QC Action

| QC Action | Source Location | Destination Location | Validation |
|-----------|----------------|---------------------|------------|
| accept | Must have QA role | Must have sellable role + is_sellable=true | `QC_SOURCE_MUST_BE_QA`, `QC_ACCEPT_REQUIRES_SELLABLE_ROLE`, `QC_ACCEPT_REQUIRES_SELLABLE_FLAG` |
| hold | Must have QA role | Must have hold role + is_sellable=false | `QC_SOURCE_MUST_BE_QA`, `QC_HOLD_REQUIRES_HOLD_ROLE`, `QC_HOLD_MUST_NOT_BE_SELLABLE` |
| reject | Must have QA role | Must have reject role + is_sellable=false | `QC_SOURCE_MUST_BE_QA`, `QC_REJECT_REQUIRES_REJECT_ROLE`, `QC_REJECT_MUST_NOT_BE_SELLABLE` |

---

## Idempotency

### QC Event Idempotency

- Each QC event has an `idempotencyKey`
- The underlying transfer uses the same key scoped to the QC event
- On replay: existing QC event and transfer returned, no duplicate movements

### Concurrent QC Events

- Serialized by ATP advisory locks on (tenantId, warehouseId, itemId)
- Second concurrent QC event on same item blocks until first completes
- After first commits, second sees updated allocation/balance state
- This prevents double-acceptance or over-acceptance of a receipt

---

## QC Metrics

### Per-Receipt Tracking

| Metric | Formula |
|--------|---------|
| QC completion % | `(accepted + held + rejected) / received × 100` |
| Accept rate | `accepted / (accepted + held + rejected) × 100` |
| Hold rate | `held / (accepted + held + rejected) × 100` |
| Reject rate | `rejected / (accepted + held + rejected) × 100` |

### Per-Item Trending

- QC events are linked to items via receipt/WO lines
- Reject rate per item over time indicates quality issues
- NCR records provide root cause tracking for rejects
