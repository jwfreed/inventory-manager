# Inventory Kernel Architecture

## Source of truth

`inventory_movements` plus `inventory_movement_lines` are the authoritative inventory ledger.

Derived state must reconcile back to that ledger:

- `inventory_balance`
- `inventory_cost_layers`
- `cost_layer_consumptions`
- `work_order_wip_valuation_records`
- `inventory_reservations`
- `work_orders.quantity_*` and `work_order_executions.wip_*`
- `inventory_movement_lots` and `work_order_lot_links`

No projection table or work-order header field is authoritative over the posted movement ledger.

## Transaction boundary

The posting kernel runs inside `runInventoryCommand(...)`.

Within that boundary, a successful work-order posting must keep these domains synchronized:

1. authoritative inventory movement persistence
2. cost-layer consumption or creation
3. WIP valuation mutation
4. reservation mutation where applicable
5. projection updates
6. authoritative event append

Lot traceability append runs after posting for report-production, but it must stay append-only and must never mutate a posted movement row.

## Posting order

Each flow should remain `normalize -> plan -> execute -> project`.

Execution order inside the transaction:

1. validate and lock the work-order scope
2. build deterministic movement plans with `inventoryMovementPlanner.ts`
3. resolve replay using `inventoryReplayEngine.ts`
4. persist the authoritative movement(s)
5. apply cost-layer operations
6. apply WIP accounting and `verifyWipIntegrity()`
7. apply reservation consumption where the flow consumes reserved component demand
8. enqueue projection ops from `inventoryProjectionEngine.ts`
9. append events from `inventoryEventFactory.ts`

## Module responsibilities

- `workOrderExecution.service.ts`: orchestration only; it should compose engines and enforce flow order.
- `inventoryMovementPlanner.ts`: deterministic movement identity, line ordering, reason-code normalization, immutable movement payload construction.
- `inventoryReplayEngine.ts`: replay discovery, readiness checks, deterministic hash verification, conflict detection, replay response construction.
- `wipAccountingEngine.ts`: open-WIP locking, allocation, reversal, valuation row writes, integrity verification.
- `inventoryProjectionEngine.ts`: work-order and balance projection ops only.
- `inventoryEventFactory.ts`: authoritative event payload construction only.
- `lotTraceabilityEngine.ts`: pre-posting traceability preparation and append-only trace rows.
- `inventoryStatePolicy.ts`: conceptual inventory and manufacturing state-transition guards.

## Invariants that must not break

- Posted `inventory_movements` rows are append-only.
- Movement identity is deterministic for a given semantic request.
- Replay must be single-sourced through `inventoryReplayEngine.ts`.
- WIP must stay symmetric: issue adds value, completion/report removes value, void restores and removes with equal opposite sign.
- Reservation lifecycle must remain `RESERVED -> ALLOCATED -> FULFILLED` for consumed work-order component demand.
- Work-order reservations use quantity-derived active status.
- Reopen from `FULFILLED` is allowed only for compensating manufacturing restores.
- Non-manufacturing reservations keep their existing terminal semantics.
- Projection tables may lag during execution failure, but the ledger may not be partially posted.
- Traceability repair may append missing `inventory_movement_lots` or `work_order_lot_links` rows only.

## What future contributors must not do

- Do not inline replay result builders back into `workOrderExecution.service.ts`.
- Do not write `UPDATE inventory_movements ...` for posted work-order movements.
- Do not write WIP SQL inline in the orchestrator.
- Do not construct inventory event payloads inline in the orchestrator.
- Do not bypass `inventoryMovementPlanner.ts` when building work-order movement payloads.
- Do not treat `inventory_balance` or `work_orders.wip_*` as the primary source of truth.
- Do not add new posting side effects after event emission inside a transaction.

## Current intentional exception

The orchestrator still performs some flow-local normalization and canonical quantity preparation before it calls the planner. If that logic grows, extract it into planner-adjacent normalization helpers instead of reintroducing inline mutation behavior.
