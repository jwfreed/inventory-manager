# Domain Invariants

This document is the durable human source of truth for inventory semantics in this repository. It exists to keep future implementation, review, testing, and UI work aligned around the same operational model.

## Core Truths

- Inventory exists as both physical stock and recorded stock. They may diverge temporarily, but the system must detect, explain, and correct the divergence instead of hiding it.
- Every quantity must have one defined meaning. `On-hand`, `available`, `allocated`, `on-hold`, `in-transit`, `WIP`, and `consumed` are distinct truths and must not be collapsed.
- Inventory state must be explicit. A balance, badge, or status must not imply an unstated workflow phase.
- Quantity truth must be auditable over time. Corrections must preserve history and explain why they happened.
- Multi-location truth matters. Total network inventory is not the same as pickable inventory at a specific node.
- Warehouse workflows are operationally distinct. Receiving, acceptance, putaway, storage, reservation, picking, transfer, shipping, counting, quarantine, and adjustment must not be merged for convenience.
- UI is part of the correctness boundary. If the UI mislabels stock or offers invalid actions, it can still corrupt operations even when the backend rejects the final request.

## Quantity Meanings

- `On-hand`: stock physically stored or otherwise posted as present at a location.
- `Available`: stock that may be promised or consumed after reservations, holds, and blocking states are considered.
- `Allocated` or `reserved`: stock committed to demand and therefore not generally free for unrelated use.
- `On-hold` or `quarantined`: stock present in the network but intentionally blocked from normal use.
- `In-transit`: stock issued from one node and not yet fully received into the next usable phase.
- `WIP`: stock value or quantity committed to work in progress and not interchangeable with stored finished inventory.
- `Consumed`: stock no longer available because it has been issued to a completed downstream use.

## Lifecycle States

The operational lifecycle is explicit:

- Planned
- Expected inbound
- Received / not yet accepted
- Accepted / available for putaway
- Stored / on-hand
- Allocated / reserved
- Picked / staged
- In transit
- Consumed
- Shipped
- Adjusted
- Quarantined / blocked
- Count pending / under investigation

## Allowed Transition Shape

- Planned -> Expected inbound
- Expected inbound -> Received / not yet accepted
- Received / not yet accepted -> Accepted / available for putaway
- Accepted / available for putaway -> Stored / on-hand
- Stored / on-hand -> Allocated / reserved
- Allocated / reserved -> Picked / staged
- Picked / staged -> Shipped
- Stored / on-hand -> In transit
- In transit -> Received / not yet accepted
- Stored / on-hand -> Consumed
- Any physical state -> Quarantined / blocked
- Any state with discrepancy -> Count pending / under investigation
- Count pending / under investigation -> Adjusted or restored prior state

These transitions make partial completion visible. A workflow is not allowed to jump directly from intent to completion if the intermediate operational truths matter.

## Transaction Requirements

No stock movement is valid without all of the following:

- item or SKU
- quantity
- unit of measure
- source state and location
- destination state and location
- actor or system source
- timestamp
- reason or transaction type

The system should prefer movement deltas and append-only history over silent balance replacement. Quantity-affecting actions must remain replayable, explainable, and linked to their operational cause.

## Reconciliation And Discrepancy Handling

- Divergence between physical and recorded stock must be surfaced, not hidden.
- Counts must preserve the discrepancy history instead of overwriting book truth with no explanation.
- Discrepancy handling follows a workflow: detect, isolate, investigate, then adjust or restore.
- Reason codes are required for adjustments, write-offs, overrides, and unblock actions.

## Receipt Allocation Operational State

- `receipt_allocations` is non-authoritative operational support state. It is required for correct receipt workflow execution but must never be used as the source of truth for quantity correctness.
- Receipt allocation rows are not optional during QC, putaway, reconciliation, or closeout. Workflows must validate allocation conservation, movement traceability, and workflow-specific bin/status sufficiency before mutating allocations or proceeding with a state transition that depends on them.
- Receipt allocations are not projection state and must not be rebuilt by projection replay. They are maintained transactionally as side effects of receipt, QC, putaway, and reconciliation workflow transactions.
- If receipt allocations disagree with authoritative receipt lines, ledger movements, QC events, putaway lines, or reconciliation records, the authoritative sources win. The workflow must rebuild and re-validate inside the active transaction, or fail hard with an explicit allocation-drift or authoritative-data error.
- Background checks may report receipt allocation drift, but they must not automatically rebuild receipt allocations.

## Location, UOM, And Identity Rules

- SKU and location identity must remain tied to inventory records at all times.
- Transfers must preserve both the source-side issue and the destination-side receipt with durable correlation.
- Units of measure must be explicit on every quantity-bearing transaction.
- Unit conversions must be deterministic across database, service, API, and UI layers.
- Where lot or serial tracking applies, it must remain consistent across movement, location, and state transitions.

## Prohibited Shortcuts

- One field standing in for several inventory truths.
- Posting receipt before physical arrival.
- Treating accepted stock as stored stock without a putaway step.
- Decrementing transfer origin without durable destination receipt handling.
- Allowing unavailable, quarantined, expected, or in-transit stock to be consumed as if it were available.
- Directly overwriting aggregate balances outside approved transaction services.
- Silent negative inventory as a default behavior.
- Backdating or retrying transactions in ways that reorder history without preserving derived truth.
- Soft-deleting or merging locations in ways that orphan existing stock.
- UI labels or buttons that simplify away blocked states, partial completion, or discrepancy states.

## Operational Interpretation Rules

- Planning logic is not the same as execution logic.
- Reporting quantities are not automatically safe to use as system-of-record mutation inputs.
- Local availability must remain distinguishable from network inventory.
- Safety stock, buffer stock, transit stock, and WIP serve different purposes and must remain semantically distinct.

When future guidance is written, it should refine execution behavior without weakening these invariants.
