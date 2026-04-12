# Sprint 3 Phase A - WorkOrderExecution Correctness Boundary Definition (Canonical)

## Purpose

Define the correctness boundary for WorkOrderExecution before Sprint 3 refactoring begins.

This document is authoritative for Sprint 3. It is a constraint layer for Codex, Claude, and any other agent operating on WorkOrderExecution. Phase B may reorganize code only if every constraint in this document remains true.

This document defines correctness, not the Phase B module structure.

## Scope

Included workflows:

| ID | Workflow | Entry Point | Canonical Service Path |
|----|----------|-------------|------------------------|
| WF-2 | Post Work Order Issue | `POST /work-orders/:id/issues/:issueId/post` | `postWorkOrderIssue()` |
| WF-4 | Post Work Order Completion | `POST /work-orders/:id/completions/:completionId/post` | `postWorkOrderCompletion()` |
| WF-5 | Record Work Order Batch | `POST /work-orders/:id/record-batch` | `recordWorkOrderBatch()` |
| WF-6 | Report Work Order Production | `POST /work-orders/:id/report-production` | `reportWorkOrderProduction()` -> `recordWorkOrderBatch()` -> traceability finalization |
| WF-7 | Void Work Order Production | `POST /work-orders/:id/void-report-production` | `voidWorkOrderProductionReport()` |
| WF-8 | Report Work Order Scrap | `POST /work-orders/:id/report-scrap` | `reportWorkOrderScrap()` |

Explicitly excluded:

- Draft document creation for issues and completions (WF-1, WF-3).
- Global projection rebuild correctness beyond the local projection contracts observed here.
- `receipt_allocations`, carried forward from Sprint 2 as unresolved receipt/QC state.
- Schema or migration changes.
- UI behavior changes.

## Evidence Index

All binding claims below are anchored to one or more evidence blocks.

| ID | File | Lines | Evidence |
|----|------|-------|----------|
| E01 | `src/routes/workOrderExecution.routes.ts` | L225-L255 | WF-2 route calls `postWorkOrderIssue()` and emits posted issue event. |
| E02 | `src/routes/workOrderExecution.routes.ts` | L430-L458 | WF-4 route calls `postWorkOrderCompletion()` and emits posted completion events. |
| E03 | `src/routes/workOrderExecution.routes.ts` | L541-L571 | WF-5 route calls `recordWorkOrderBatch()` with idempotency key. |
| E04 | `src/routes/workOrderExecution.routes.ts` | L816-L842 | WF-6 route calls `reportWorkOrderProduction()` with idempotency key. |
| E05 | `src/routes/workOrderExecution.routes.ts` | L1086-L1120 | WF-7 route requires idempotency key and calls `voidWorkOrderProductionReport()`. |
| E06 | `src/routes/workOrderExecution.routes.ts` | L1225-L1250 | WF-8 route calls `reportWorkOrderScrap()` with idempotency key. |
| E07 | `src/modules/platform/application/runInventoryCommand.ts` | L104-L182 | `runInventoryCommand()` wraps execution in `withTransactionRetry`, claims idempotency, acquires ATP locks, appends events, applies projections, and finalizes idempotency. |
| E08 | `src/domains/inventory/internal/ledgerWriter.ts` | L156-L240 | `persistInventoryMovement()` sorts lines deterministically, hashes movements, creates the movement, then creates movement lines. |
| E09 | `src/services/workOrderExecution.service.ts` | L612-L973 | WF-2 posts one issue movement, cost consumption, WIP valuation, reservation consumption, and projection ops. |
| E10 | `src/services/workOrderExecution.service.ts` | L1088-L1433 | WF-4 posts one receive movement, cost layers, WIP allocation, WIP valuation, and projection ops. |
| E11 | `src/services/workOrderExecution.service.ts` | L2725-L2924 | WF-5 enters `runInventoryCommand()`, replays existing batches, plans batch policy, and delegates execution to `executeWorkOrderBatchPosting()`. |
| E12 | `src/domain/workOrders/batchExecution.ts` | L125-L320 | WF-5 creates issue and receive movement plans and persists both; incomplete pair throws `WO_POSTING_IDEMPOTENCY_INCOMPLETE`. |
| E13 | `src/domain/workOrders/batchExecution.ts` | L321-L612 | WF-5 inserts issue/execution documents, cost/WIP/reservation effects, projection contract, and batch projection ops. |
| E14 | `src/services/workOrderExecution.service.ts` | L1798-L1877 | WF-6 performs batch posting, then opens a second transaction to finalize traceability/link repair. |
| E15 | `src/services/workOrderExecution.service.ts` | L1891-L2473 | WF-7 runs one command that validates original pair, persists reversal pair, reverses WIP, restores reservations, and applies projections. |
| E16 | `src/services/workOrderExecution.service.ts` | L2475-L2723 | WF-8 validates posted production QA output, prepares a transfer-backed scrap movement, delegates to transfer execution, and applies scrap projections. |
| E17 | `src/services/inventoryReplayEngine.ts` | L438-L505 | Batch replay resolves execution state and verifies issue + receive movements. |
| E18 | `src/services/inventoryReplayEngine.ts` | L507-L552 | Void replay verifies the component-return + output-reversal movement pair. |
| E19 | `src/services/inventoryReplayEngine.ts` | L554-L657 | Scrap replay re-resolves QA source and SCRAP default location, then delegates to transfer replay. |
| E20 | `src/services/workOrderExecution.service.ts` | L1603-L1750 | Void helpers enforce same execution, posted pair, QA-only output, unconsumed production layers, and warehouse bindings. |
| E21 | `src/domain/workOrders/batchPolicy.ts` | L95-L285 | Batch policy locks work order, checks existing replay, reservations, sellable consumption, routing, locations, and ATP lock targets. |
| E22 | `src/domain/workOrders/batchPlan.ts` | L34-L177 | Batch plan builds issue/receive line plans, canonical quantities, validation lines, and calls manufacturing execution invariants. |

## System Model

### Source Of Truth

The inventory ledger is the inventory source of truth:

- `inventory_movements`
- `inventory_movement_lines`

Ledger writes must remain append-only and must go through the existing ledger insert boundary. WorkOrderExecution may construct movement plans, but it must not create an alternate path that writes ledger rows outside `persistInventoryMovement()` / ledger writer behavior. [E08]

### Supporting State

The following state is required for workflow operation but is not a substitute for ledger truth:

- `work_order_material_issues`
- `work_order_material_issue_lines`
- `work_order_executions`
- `work_order_execution_lines`
- WIP valuation/accounting records
- Cost layers and cost layer consumptions
- Reservations
- Lot traceability links
- Inventory projections and work-order aggregates

Supporting state may be required to replay a workflow response or repair links, but it must not redefine inventory quantity truth.

### Projection Constraint

Projections must never determine mutation legality.

Projection writes are allowed only as transaction-scoped consequences of ledger-authoritative mutation. Any Phase B change that reads `inventory_balance`, work-order aggregates, or dashboard projections to decide whether a mutation is legal violates this document.

## Workflow Classification

| Workflow | Type | Mutation Shape | Replay Class | Atomicity Class |
|----------|------|----------------|--------------|-----------------|
| WF-2 | Single document post | One issue movement | Ledger + operational anchor | Single transaction |
| WF-4 | Single document post | One receive movement | Ledger + operational anchor | Single transaction |
| WF-5 | Paired batch post | Issue + receive movements | Ledger + operational state | Single transaction |
| WF-6 | Orchestrated production report | WF-5 batch + post-finalization | Ledger + operational state | Two transactions by design |
| WF-7 | Paired reversal | Output issue + component receive | Ledger + operational anchor | Single transaction |
| WF-8 | Transfer-backed scrap | Transfer movement | Ledger + infrastructure dependency | Single transaction delegated to transfer internals |

Replay is workflow-dependent. Do not replace this with a single global replay assumption during Phase B.

## Atomic Write Boundaries

### Global Rule

Each workflow must execute its authoritative write set inside one `runInventoryCommand()` / transaction boundary, except WF-6, which intentionally has two transactions. [E07] [E14]

Lock acquisition must remain inside the transaction and before quantity-affecting writes. [E07]

### WF-2 - Post Work Order Issue

Atomic write set:

- One posted issue movement with `sourceType = 'work_order_issue_post'` and `sourceId = issueId`. [E09]
- Cost layer consumption for production input. [E09]
- WIP valuation record for issue value. [E09]
- WIP integrity verification. [E09]
- Reservation consumption. [E09]
- Inventory and work-order projection ops. [E09]
- Inventory and work-order events appended by the command shell. [E07] [E09]

Boundary:

- Single `runInventoryCommand()` transaction. [E09]

Binding invariant:

- One issue document posts at most one authoritative issue movement.

### WF-4 - Post Work Order Completion

Atomic write set:

- One posted receive movement with `sourceType = 'work_order_completion_post'` and `sourceId = completionId`. [E10]
- Production cost layers for completed output. [E10]
- WIP cost allocation. [E10]
- WIP valuation record for completion capitalization. [E10]
- WIP integrity verification. [E10]
- Inventory and work-order projection ops. [E10]
- Inventory and work-order events appended by the command shell. [E07] [E10]

Boundary:

- Single `runInventoryCommand()` transaction. [E10]

Binding invariant:

- One completion document posts at most one authoritative receive movement.

### WF-5 - Record Work Order Batch

Atomic write set:

- One issue movement with `sourceType = 'work_order_batch_post_issue'`. [E12]
- One receive movement with `sourceType = 'work_order_batch_post_completion'`. [E12]
- Posted `work_order_material_issues` document and lines. [E13]
- Posted `work_order_executions` document and lines. [E13]
- Cost layer consumptions for consumed components. [E13]
- Cost layers for produced output. [E13]
- WIP issue/report valuation records and WIP integrity verification. [E13]
- Reservation consumption. [E13]
- Projection delta contract and projection ops. [E13]
- Inventory and production events appended by the command shell. [E07] [E13]

Boundary:

- Single `runInventoryCommand()` transaction. [E11]

Binding invariant:

- The issue and receive movements are a pair. Both must commit with all associated cost, WIP, reservation, and document effects, or neither may commit. A partial pair is not acceptable operational state.

### WF-6 - Report Work Order Production

Authoritative mutation:

- Delegates to WF-5 `recordWorkOrderBatch()` using the report-production idempotency endpoint. [E14]

Post-finalization:

- Opens a second transaction for `finalizeBatchExecutionTraceability()`, which may repair execution movement links and append traceability. [E14] [E17]

Boundary:

- TX-1: batch posting, authoritative inventory mutation. [E14]
- TX-2: traceability and link repair. [E14]

Binding invariant:

- WF-6 is intentionally not atomic across the full workflow. Phase B must preserve this seam, make it visible, and keep recovery idempotency-driven.

### WF-7 - Void Work Order Production

Atomic write set:

- Original execution row locked and classified as reported production. [E15]
- Original issue + receive movement pair validated as posted. [E15]
- Output still in QA and production cost layers unconsumed. [E20]
- One output reversal issue movement with `sourceType = 'work_order_batch_void_output'`. [E15]
- One component return receive movement with `sourceType = 'work_order_batch_void_components'`. [E15]
- Cost layer consumption for reversed output. [E15]
- Cost layers for returned components. [E15]
- WIP reversal. [E15]
- Reservation restoration. [E15]
- Inventory and work-order projection ops. [E15]
- Inventory and reversal events appended by the command shell. [E07] [E15]

Boundary:

- Single `runInventoryCommand()` transaction. [E15]

Binding invariant:

- Void movement completeness must hold. Both reversal movements must exist and be posted, or void must fail/replay as incomplete.

### WF-8 - Report Work Order Scrap

Atomic write set:

- Posted production execution locked. [E16]
- Unique QA source location resolved from the production movement. [E16]
- SCRAP destination resolved from warehouse default location. [E16]
- Cost-layer availability checked against remaining production output. [E16]
- Transfer mutation prepared with `sourceType = 'work_order_scrap'`. [E16]
- Transfer execution delegated to transfer internals. [E16]
- Transfer projection ops and scrap work-order projection ops. [E16]

Boundary:

- Single `runInventoryCommand()` transaction, with ledger mutation delegated to transfer internals. [E16]

Binding invariant:

- WorkOrderExecution must not create an alternate scrap ledger path. Scrap remains transfer-backed.

## Core Invariants

### Identity Invariants

- WF-2: one issue document maps to one posted issue movement.
- WF-4: one completion document maps to one posted receive movement.
- WF-5/WF-6: one production execution maps to one issue movement and one receive movement.
- WF-7: one void action maps to one output reversal movement and one component return movement.
- WF-8: one scrap action maps to one transfer-backed scrap movement.
- All authoritative movements must preserve meaningful `sourceType` / `source_type`, `sourceId` / `source_id`, `externalRef`, and idempotency metadata where available.

### Idempotency Invariants

- A logical mutation may produce at most one authoritative write set.
- New ledger-affecting command paths must use transactional idempotency through `runInventoryCommand()` where it already applies. [E07]
- Existing non-transactional or document-scoped idempotency behavior may not be weakened during Phase B.
- WF-6 recovery depends on retrying the same idempotency key after TX-1 succeeds and TX-2 fails. [E14]
- WF-7 requires an idempotency key at the route boundary. [E05]

### State Machine Invariants

- Draft issue -> posted issue is monotonic. [E09]
- Draft completion -> posted completion is monotonic. [E10]
- Batch execution is created as posted with movement pair already assigned. [E13]
- Reported production may transition to reversal only through WF-7. [E15]
- Produced output may move from QA to SCRAP only through WF-8's transfer-backed flow. [E16]
- Movement IDs are immutable once set; replay may repair missing execution links only when classification permits it. [E17]

### Quantity Invariants

- Consumption and production quantities must remain distinct.
- WIP value must not be confused with on-hand or available inventory.
- Cost-layer quantities must correspond to ledger-derived quantities.
- Reservation consumption in WF-2/WF-5 and restoration in WF-7 must remain symmetric over the lifecycle.
- Produced QA output may not be voided or scrapped beyond remaining production cost-layer availability. [E16] [E20]

### Cost And WIP Invariants

- Issue paths consume cost layers and create positive WIP value. [E09] [E13]
- Completion/report paths allocate WIP and create production cost layers. [E10] [E13]
- Void reverses WIP and reflects output/component cost effects in the reversal pair. [E15]
- WIP integrity verification remains part of every ledger-adjacent issue/completion/batch/void path. [E09] [E10] [E13] [E15]
- Cost conservation and projection delta contracts may not be removed or bypassed. [E13]

### Replay Invariants

- Replay must verify authoritative movement existence, line presence, and deterministic hash expectations where supplied.
- WF-2 and WF-4 replay require the document/execution anchor row. [E09] [E10]
- WF-5/WF-6 replay require operational execution state and may repair movement links only through classifier-approved behavior. [E17]
- WF-7 replay requires both reversal movements. [E18]
- WF-8 replay depends on current infrastructure configuration: QA source resolution and SCRAP default location. [E19]

## Replay Model

| Class | Meaning | Workflows |
|-------|---------|-----------|
| Ledger-derived | Fully reconstructable from ledger alone | Not observed for these workflows as a complete response model |
| Ledger + operational anchor | Requires document/execution row in addition to ledger | WF-2, WF-4, WF-7 |
| Ledger + operational state | Requires execution state, movement links, WIP/cost/reservation context, or classifier recovery | WF-5, WF-6 |
| Ledger + infrastructure | Requires mutable warehouse/location configuration in addition to ledger | WF-8 |

Known replay limits:

- WF-8 re-resolves warehouse SCRAP defaults during replay. This is an infrastructure dependency and must remain explicit. [E19]
- WF-5/WF-6 can repair execution movement links only after classifier analysis. This is recovery logic, not permission to invent new replay paths. [E17]
- WF-6 may have posted inventory without traceability if the second transaction fails. [E14]

## Architectural Exception - WF-6

WF-6 is the only explicit two-transaction workflow in this boundary.

TX-1 posts the authoritative inventory mutation by delegating to WF-5. TX-2 finalizes traceability and may repair movement links. [E14]

Properties:

- Not atomic across the full workflow.
- Inventory may be correctly posted while lot traceability remains incomplete.
- Recovery is idempotency-driven and requires retry with the same logical request.
- Irrecoverable classification must fail loudly and require manual repair.

Failure modes:

| Case | Outcome | Required Handling |
|------|---------|-------------------|
| TX-1 succeeds, TX-2 fails | Posted inventory with missing/incomplete traceability | Retry same idempotency key; do not repost inventory |
| TX-1 succeeds, idempotency key unavailable | No reliable automated recovery path | Escalate; manual repair likely |
| Execution classifier reports irrecoverable state | Recovery unsafe | Stop and surface `WO_EXECUTION_RECOVERY_IRRECOVERABLE` |
| Traceability append has non-retryable error | Posted inventory remains; traceability cannot complete automatically | Stop and escalate |

Classification:

> Permanent partial state possible.

Phase B must not hide this behind a generic workflow abstraction.

## Known Failure Surfaces

High risk:

- Paired movement incompleteness in WF-5 or WF-7.
- WF-6 partial completion between TX-1 and TX-2.
- Missing or mismatched idempotency key causing duplicate or unrecoverable mutation.
- WF-8 replay changing behavior because warehouse default locations changed.

Medium risk:

- Reservation drift if WF-2/WF-5 consumption and WF-7 restoration diverge.
- WIP rounding residuals or cost allocation imbalance.
- Cost layer availability checks drifting from ledger-derived quantities.
- Movement source identity drift (`sourceType` / `source_type`, `sourceId` / `source_id`, `externalRef`) during extraction.

Structural risk:

- Splitting a workflow by technical helper instead of domain ownership.
- Moving transfer-backed scrap into WorkOrderExecution-owned ledger writes.
- Treating operational anchor rows as projections.
- Making WF-6 appear atomic when it is not.

## Failure Modes → Primary Invariant Mapping

| Failure Mode | Affected Workflow(s) | Violated Invariant(s) | Detection Surface | Notes |
|--------------|----------------------|-----------------------|-------------------|-------|
| WF-5 pair incompleteness | WF-5, WF-6 | Identity Invariants; Replay Invariants | `WO_POSTING_IDEMPOTENCY_INCOMPLETE`; batch replay classification | Issue and receive movements must remain a complete pair. |
| WF-6 TX-1 / TX-2 split inconsistency | WF-6 | Idempotency Invariants; Replay Invariants | `WO_REPORT_LOT_LINK_INCOMPLETE`; `WO_EXECUTION_RECOVERY_IRRECOVERABLE` | Inventory may be posted while traceability remains incomplete. |
| WF-7 reversal pair incompleteness | WF-7 | Identity Invariants; Replay Invariants | `WO_VOID_INCOMPLETE`; void replay | Output reversal and component return movements must remain a complete pair. |
| WF-8 infrastructure-dependent replay drift | WF-8 | Replay Invariants | Scrap replay scope/default-location resolution | Replay depends on QA source and SCRAP default location resolution. |
| Duplicate mutation due to idempotency failure | WF-2, WF-4, WF-5, WF-6, WF-7, WF-8 | Idempotency Invariants; Identity Invariants | Idempotency claim/replay paths; movement source identity checks | A logical mutation may produce at most one authoritative write set. |

## Non-Negotiable Constraints For Phase B

Must preserve:

- The workflow classifications in this document.
- Each workflow's atomic write set.
- All current transaction boundaries, including WF-6's two-transaction structure.
- `runInventoryCommand()` as the command shell where already used.
- Ledger writes through the ledger writer path.
- Deterministic movement sorting and hashing through existing inventory movement determinism.
- ATP locks inside the transaction and before quantity-affecting writes.
- `sourceType` / `source_type`, `sourceId` / `source_id`, `externalRef`, and idempotency semantics.
- Replay classifications and known replay dependencies.
- WIP, reservation, cost, and projection contract checks.

Must not introduce:

- Alternate ledger write paths.
- Projection-based mutation legality.
- New generic replay model that erases workflow differences.
- Hidden cross-workflow coupling.
- Shared abstractions that split an atomic write set.
- A generic caller-client bypass around `runInventoryCommand()`.
- A WorkOrderExecution-owned scrap mutation path that bypasses transfer internals.
- Schema or migration changes without explicit user authorization.

## Refactor Guidance

Workflows are the unit of ownership.

Allowed:

- Extract per-workflow modules.
- Share pure, stateless utilities.
- Co-locate replay/recovery behavior with the workflow that owns it.
- Keep transfer-backed operations delegated where transfer semantics own the ledger mutation.
- Preserve existing domain-specific policy, plan, execution, and replay stages when they represent real workflow boundaries.

Forbidden:

- Merging workflows under a generic manufacturing mutation abstraction.
- Splitting an atomic write set across modules in a way that obscures transaction membership.
- Hiding WF-6's two-transaction seam.
- Treating WIP/cost/reservation/projection writes as optional side effects.
- Replacing workflow-specific state checks with aggregate/projection checks.
- Reclassifying operational anchors as derived state without proof and explicit approval.

## Exit Criteria For Phase A

Phase A is complete when this document is accepted as the Sprint 3 canonical boundary and the following are true:

- All included workflows are classified.
- Atomic write sets are explicit.
- Replay classes are explicit.
- WF-6 is documented as an architectural exception.
- Failure modes are mapped to invariants.
- Phase B constraints are binding and discoverable.

## Usage Instructions For Codex And Claude

Before implementing or refactoring WorkOrderExecution:

1. Identify the target workflow ID.
2. Locate its atomic write set in this document.
3. Confirm its replay class.
4. Confirm its state, quantity, WIP, reservation, and cost invariants.
5. Confirm the transaction boundary does not change.
6. Confirm no new ledger write path or projection-based validation is introduced.
7. Confirm WF-6 remains visibly two-transaction if the change touches report-production.

If any constraint cannot be satisfied, stop and escalate.

## Final Note

This document defines what must remain true.

Phase B defines how code is reorganized without violating it.
