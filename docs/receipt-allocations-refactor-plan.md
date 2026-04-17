# Receipt Allocations — Refactor Plan (Corrected)

> **Revision note:** This version corrects a critical flaw in the prior plan. The prior plan assumed workflows (QC, putaway, reconciliation) could safely proceed with missing or inconsistent allocation state and "repair later." That assumption is unproven and likely unsafe. This version enforces: **validate before execution; fail fast or repair before proceeding. No silent continuation.**

---

## 1. Classification

`receipt_allocations` is **Operational Support State**.

### What This Means

- **Non-authoritative.** It is not the source of truth for any quantity or status. The authoritative sources are: `purchase_order_receipt_lines` (quantity received), `inventory_movements` + `inventory_movement_lines` (ledger), `qc_events` (QC decisions), `putaway_lines` (putaway completions), and `receipt_reconciliation_resolutions` (adjustments).
- **Reconstructable, not projection-owned.** The complete state of `receipt_allocations` can be reconstructed from the authoritative sources above only when every mapping is unambiguous. It is maintained transactionally by receipt workflows, not by background projection replay.
- **Mutable.** It is modified (INSERT / UPDATE / DELETE) during workflow execution. It is not append-only.

### What This Does NOT Mean

- **Not optional during execution.** Workflows depend on allocations for correct bin targeting, quantity partitioning, and status routing. A workflow cannot safely proceed if the allocation state it depends on is missing, stale, or inconsistent.
- **Not a projection.** It is not rebuilt from ledger replay. It is not updated by the projection rebuild machinery. It is maintained as a side-effect of inbound workflow transactions.
- **Not a ledger table.** It is not governed by `ledgerWriter.ts` or protected by the existing inventory write ownership guard.

### The Key Distinction

> **Non-authoritative ≠ optional during execution.**
>
> `receipt_allocations` is required for correct workflow execution. But it is never the source of truth. If allocations and authoritative sources disagree, the authoritative sources win — and the system must detect the disagreement before damage occurs, not after.

### Enforced Rebuild Contract

The rebuild contract is explicit in code and must remain explicit in design review:

- **Required upstream inputs:** receipt lines, inventory movements and movement lines, QC events plus QC inventory links, completed putaway lines, and reconciliation resolutions with movement metadata.
- **Deterministic mapping rules:** rebuild ordering is fixed by authoritative timestamps plus stable IDs; rebuilt allocation IDs are deterministic for identical authoritative inputs; each rebuild step must resolve to exactly one authoritative movement line.
- **Failure conditions:** rebuild aborts on missing links, ambiguous movement matching, incomplete reconciliation metadata, conflicting allocation targets for the same authoritative movement line, and any post-rebuild invariant violation.
- **Not provided:** rebuild does not guess, silently repair, or make upstream corruption valid. If authoritative inputs are incomplete or ambiguous, rebuild is invalid and must fail.

---

## 2. Responsibilities (Allowed Uses)

### 2.1 Coordination Roles

`receipt_allocations` acts as a **materialized cursor** that tracks bin-level receipt quantity through inbound workflow phases (QC → putaway → reconciliation). It answers: "Where is this receipt line's quantity right now, and what status is it in?"

| Role | Description |
|------|-------------|
| QC routing | Track which bins hold QA-pending quantity so QC events can target the correct source bin |
| Putaway source | Identify QA allocations at a source bin for putaway line consumption and destination placement |
| Reconciliation targeting | Locate allocations by location/bin/status for adjustment application |
| Status aggregation | Summarize QA / AVAILABLE / HOLD quantities per receipt line for API display |

### 2.2 Allowed Write Patterns

Writes are permitted **only when paired with a corresponding ledger write** (inventory movement) in the same transaction.

| Writer | Service | Trigger | Operations |
|--------|---------|---------|------------|
| Receipt creation | `receipts.service.ts` | PO receipt posted | INSERT (status=QA) |
| QC accept/hold | `qc.service.ts` | QC event recorded | DELETE/UPDATE source QA, INSERT destination AVAILABLE/HOLD |
| Putaway completion | `putaways.service.ts` | Putaway line completed | DELETE/UPDATE source QA, INSERT destination AVAILABLE |
| Reconciliation adjustment | `closeout.service.ts` | Discrepancy resolved | INSERT (positive delta) or DELETE/UPDATE (negative delta) |

No other write paths are permitted.

Every INSERT must populate `inventory_movement_id` and `inventory_movement_line_id` (enforced by `assertReceiptAllocationTraceability`).

### 2.3 Allowed Read Patterns

| Reader | Purpose | Constraint |
|--------|---------|------------|
| `loadReceiptAllocationsByLine()` | Load allocations for workflow mutation targeting | Workflow must validate allocation invariants before proceeding |
| `receivingAggregations.ts` | Compute QA/AVAILABLE/HOLD summaries for API | Display only — must not drive correctness decisions |
| `deriveReceiptAvailabilityFromAllocations()` | Determine receipt availability state | Informational — gated by lifecycle state, not allocation alone |
| Putaway readiness check | Sum AVAILABLE allocations per receipt | Informational — must not be sole gate for receipt closeout |

### 2.4 Acceptable Dependencies

- `receipt_allocations` MAY depend on: `purchase_order_receipt_lines`, `inventory_movements`, `inventory_movement_lines`, `inventory_bins`, `locations`, `inventory_cost_layers`
- Other tables MUST NOT depend on `receipt_allocations` (no inbound foreign keys)

---

## 3. Forbidden Uses

### 3.1 Never Source of Truth

| Forbidden Use | Reason | Enforcement |
|---------------|--------|-------------|
| Using allocation totals to validate inventory correctness | Allocations are mutable; ledger is authoritative | Truth test + code review |
| Treating allocation quantity as canonical received quantity | `purchase_order_receipt_lines.quantity_received` is authoritative | Drift detection |
| Using allocations as input to `inventory_balance` projection rebuild | Projections derive from ledger only (AGENTS.md § Projection Rebuilds) | Existing truth test |
| Reading allocations during full-system replay | Replay consumes ledger only (System Model § 3.3) | Architecture invariant |

### 3.2 Never Standalone Decision-Making

No workflow may make a **correctness decision** based solely on allocation state without cross-validation against authoritative data.

- **Receipt closeout** must validate posting integrity against ledger movements AND allocations — not allocations alone.
- **QC event quantity** is validated against QC event input, not allocation balance. Allocations provide bin targeting, not quantity authority.
- **Reconciliation adjustments** must validate expected quantities from authoritative sources before applying allocation mutations.

### 3.3 Never Written Outside Transaction + Movement Pair

Every allocation write must occur:
1. Inside a `withTransaction` / `withTransactionRetry` boundary
2. In the same transaction as the corresponding inventory movement
3. After the movement has been created (allocation references the movement ID)

Writing allocation rows without a corresponding movement is forbidden.

### 3.4 Never Used as Correctness Gate for Ledger Writes

Allocation state must never be a prerequisite for creating the authoritative record. Specifically:
- The `qc_events` row and its inventory movement must not fail to write because allocations are invalid.
- The putaway movement must not fail to write because allocations are invalid.
- The reconciliation movement must not fail to write because allocations are invalid.

If allocations are invalid, the workflow must **detect this before execution begins** and either repair or fail — not after the authoritative write has been skipped.

---

## 4. Operational Role Definition

### The Coordination Contract

`receipt_allocations` provides three things workflows need that authoritative tables do not directly expose:

1. **Bin-level quantity partitioning.** A single receipt line's `quantity_received` may be spread across multiple bins. Allocations track which quantity is in which bin. This cannot be derived from the receipt line alone at query time — it requires replaying movements. Allocations are the materialized result of that replay.

2. **Status partitioning.** A single receipt line's quantity may be partially in QA, partially AVAILABLE, partially on HOLD. Allocations partition by status so workflows can target the correct subset.

3. **Consumption cursor.** When a QC event or putaway consumes QA quantity, allocations track which specific bin-level rows have been consumed and which remain. This is mutable state that advances as workflows execute.

### Why Workflows Cannot Skip Allocations

Without valid allocation state:
- **QC** cannot know which bin holds the QA quantity to accept/hold/reject. The QC event itself records a quantity, but the allocation tells the system where that quantity physically is.
- **Putaway** cannot know which QA allocation to consume at the source bin. `putaway_lines` reference allocations by `from_bin_id` — without allocations, the system cannot execute the bin-level consumption.
- **Reconciliation** cannot target the correct location/bin/status combination for adjustment application.

### The Correct Model

```
Workflow execution requires:
  1. Load allocations
  2. Validate allocation invariants (conservation, traceability, status consistency)
  3. If valid → proceed with workflow (ledger write + allocation mutation in same transaction)
  4. If invalid → attempt repair (rebuild from authoritative sources)
  5. If repair succeeds → re-validate → proceed
  6. If repair fails → fail the workflow with explicit error
```

There is **no path** where a workflow proceeds with invalid or missing allocation state. There is **no "degraded mode."**

---

## 5. Invariants

### 5.1 Global Invariants

These invariants must hold at all times (enforced at write time and verifiable at check time):

| # | Invariant | Enforcement |
|---|-----------|-------------|
| G1 | **Quantity conservation.** For every non-voided receipt line: `SUM(receipt_allocations.quantity) = purchase_order_receipt_lines.quantity_received` (within epsilon) | `assertReceiptAllocationQuantityConservation()` (existing) + standalone drift check (new) |
| G2 | **Traceability.** Every allocation must have non-null `inventory_movement_id` and `inventory_movement_line_id` referencing existing ledger rows | `assertReceiptAllocationTraceability()` (existing) + drift check (new) |
| G3 | **Positive quantity.** All allocation quantities > 0. Zero-quantity rows must be deleted, not updated to zero | `CHECK (quantity > 0)` constraint (existing) |
| G4 | **Status validity.** Status must be one of `QA`, `AVAILABLE`, `HOLD` | Schema CHECK constraint (existing) |
| G5 | **Write ownership.** Writes only from the 4 allowed service files + `receiptAllocationModel.ts` | Static analysis guard (new) |
| G6 | **Transaction coupling.** Every allocation write occurs in the same transaction as its corresponding inventory movement | Architecture rule (existing) + code review |
| G7 | **Non-authority.** No ledger table, projection rebuild, or replay logic references `receipt_allocations` | Truth test (new) |

### 5.2 Per-Workflow Invariants

| Workflow | Pre-condition | Post-condition |
|----------|---------------|----------------|
| Receipt creation | Receipt line exists with `quantity_received > 0` | Allocations created in `QA` status, `SUM(qty) = quantity_received`, all linked to posting movement |
| QC accept/hold | QA allocations exist at source bin with sufficient quantity | Source QA consumed, destination AVAILABLE/HOLD created, linked to QC movement. Conservation preserved |
| Putaway completion | QA allocations exist at `from_bin_id` with sufficient quantity | Source QA consumed, destination AVAILABLE created at `to_bin_id`, linked to putaway movement. Conservation preserved |
| Reconciliation adjustment | Allocations at target location/bin/status exist (for negative delta) or conservation allows addition (for positive delta) | Allocations adjusted, linked to adjustment movement. Conservation preserved |

If any pre-condition fails, the workflow must not proceed with allocation mutation. See §6 for the specific handling.

---

## 6. Workflow Constraints

### 6.1 QC Workflow

| Aspect | Rule |
|--------|------|
| **Pre-execution validation** | Load QA allocations for the receipt line. Validate: (a) allocations exist, (b) quantity conservation holds against receipt line, (c) sufficient QA quantity at the source bin for the event quantity |
| **If validation passes** | Execute in single transaction: create QC event → create inventory movement → mutate allocations (consume QA, insert AVAILABLE/HOLD) |
| **If validation fails: insufficient QA quantity** | Attempt rebuild for the affected receipt line (§8). After rebuild, re-validate. If re-validation passes, proceed. If it fails, **fail the workflow** with error code `RECEIPT_ALLOCATION_DRIFT_UNRECOVERABLE` |
| **If validation fails: missing allocations entirely** | Attempt rebuild. If rebuild produces valid state with sufficient QA, proceed. If not, **fail the workflow** |
| **Authoritative record** | The QC event and its movement are authoritative. But they must not be written without valid allocation state — because the allocation provides the bin targeting that the movement requires |
| **Why not "proceed anyway"** | The inventory movement for a QC event encodes `from_location`, `from_bin`. Without valid allocations, the system does not know which bin to transfer from. A movement with incorrect bin targeting corrupts the ledger |

### 6.2 Putaway Workflow

| Aspect | Rule |
|--------|------|
| **Pre-execution validation** | Load QA allocations for the receipt line. Validate: (a) allocations exist, (b) quantity conservation holds, (c) sufficient QA quantity at `from_bin_id` for `quantity_planned` |
| **If validation passes** | Execute in single transaction: complete putaway line → create inventory movement → mutate allocations (consume QA, insert AVAILABLE at destination) |
| **If validation fails** | Attempt rebuild for the affected receipt line. After rebuild, re-validate. If re-validation passes, proceed. If it fails, **fail the workflow** with error code `RECEIPT_ALLOCATION_DRIFT_UNRECOVERABLE` |
| **Why not "proceed anyway"** | Putaway movements encode `from_bin` → `to_bin`. Without valid QA allocations at the source bin, the system would create a movement from a bin that (according to allocations) has no QA material. This is either incorrect or untraceable |

### 6.3 Reconciliation Workflow

| Aspect | Rule |
|--------|------|
| **Pre-execution validation** | Load allocations for the receipt line. Validate quantity conservation. For negative deltas: verify matching allocations exist at the target location/bin/status with sufficient quantity |
| **If validation passes** | Execute in single transaction: record resolution → create adjustment movement → mutate allocations |
| **If validation fails** | Attempt rebuild. After rebuild, re-validate. If re-validation passes, proceed. If it fails, **fail the workflow** |
| **Special case: positive delta** | Positive-delta adjustments INSERT new allocations. Pre-condition: quantity conservation must hold BEFORE the adjustment (to ensure we are adjusting from a consistent baseline). After INSERT, conservation must still hold (with the new expected total) |

### 6.4 Receipt Closeout Workflow

| Aspect | Rule |
|--------|------|
| **Pre-closeout validation** | Run full drift detection (§7) for the receipt: quantity conservation, movement link integrity, status consistency |
| **If validation passes** | Validate posting integrity via `buildReceiptPostingIntegrity()` (compares allocations + receipt lines + posted movements). If posting integrity passes, proceed with closeout |
| **If drift detected** | Attempt rebuild (§8). After rebuild, re-run full drift detection. If clean, proceed. If drift persists, **block closeout** with explicit error listing all unresolved drifts |
| **Allocation writes** | None during closeout itself. Closeout is a read + state transition, not an allocation mutation |

### 6.5 Summary: No Workflow Proceeds With Invalid State

```
For all workflows:
  validate(allocations) → PASS → execute
                        → FAIL → rebuild → re-validate → PASS → execute
                                                        → FAIL → ABORT
```

There is no third branch. There is no "proceed and fix later."

---

## 7. Drift Detection Strategy

### 7.1 What Can Drift

| Drift Type | Description | Severity |
|------------|-------------|----------|
| Quantity drift | `SUM(allocations.quantity)` per receipt line ≠ `quantity_received` | **Critical** — blocks workflows |
| Movement link drift | Allocation references a movement ID that does not exist | **Critical** — indicates ledger-level issue |
| Status drift | Allocation status does not match expected state from QC events + putaway lines | **High** — causes incorrect bin targeting |
| Orphan allocations | Allocation references a voided or non-existent receipt line | **Medium** — inflates reported quantities |
| Missing allocations | Receipt line has posted movements but zero allocation rows | **Critical** — blocks all workflows for the receipt line |

### 7.2 When to Check

| Trigger | Checks Run | Action on Drift |
|---------|-----------|-----------------|
| Before QC/putaway/reconciliation execution | Quantity conservation + sufficient quantity at target bin | Attempt rebuild → re-validate → proceed or abort |
| Receipt closeout (pre-close) | All drift types | Attempt rebuild → re-validate → proceed or block |
| Background job (daily) | All drift types across open receipts | Log + alert. Do NOT auto-rebuild in background (rebuild must occur within workflow transaction context) |
| On-demand admin request | All drift types for specified receipt | Report only, or operator-triggered rebuild |

### 7.3 Drift Detection Functions

#### 7.3.1 Quantity Conservation Check

Exists as `assertReceiptAllocationQuantityConservation()`. Extend with a standalone non-throwing verifier:

```
verifyAllocationQuantityConservation(client, tenantId, receiptLineIds)
  → { lineId, expected, actual, driftQty, pass }[]
```

Source of expected: `purchase_order_receipt_lines.quantity_received`
Source of actual: `SUM(receipt_allocations.quantity) WHERE receipt_line_id = X`

#### 7.3.2 Movement Link Integrity Check

```
verifyAllocationMovementLinks(client, tenantId, receiptLineIds)
  → { allocationId, movementId, movementLineId, exists, pass }[]
```

For each allocation: verify referenced movement and movement line exist in ledger tables.

#### 7.3.3 Status Consistency Check

```
verifyAllocationStatusConsistency(client, tenantId, receiptLineIds)
  → { lineId, allocatedByStatus: {QA, AVAILABLE, HOLD}, expectedByStatus: {QA, AVAILABLE, HOLD}, drifts[] }
```

Derives expected status distribution from:
- `qc_events`: accept → AVAILABLE, hold → HOLD, reject → removed
- `putaway_lines` (status=completed): QA → AVAILABLE
- `receipt_reconciliation_resolutions`: adjustments

Compares against actual allocation status breakdown.

### 7.4 Drift Logging

All drift detections logged with:
- Receipt ID, receipt line ID
- Drift type and magnitude
- Expected vs actual values
- Trigger context (workflow pre-check, closeout, background, admin)
- Whether repair was attempted and its outcome

Use structured application logging. A dedicated drift events table is not required unless operational experience shows structured logs are insufficient.

---

## 8. Repair / Rebuild Strategy

### 8.1 Purpose

Rebuild exists for **recovery and validation** — not for normal workflow execution. It is triggered when drift is detected, not as a routine operation.

### 8.2 Rebuild Sources

| Step | Source Table | What It Provides |
|------|-------------|------------------|
| 1 | `purchase_order_receipt_lines` | Receipt line IDs, `quantity_received` |
| 2 | `inventory_movements` + `inventory_movement_lines` | Movement IDs, quantities, types for the receipt |
| 3 | `qc_events` | QC decisions (accept/hold/reject) with quantities |
| 4 | `putaway_lines` (status=completed) | Completed putaways with from/to location/bin |
| 5 | `receipt_reconciliation_resolutions` (type=ADJUSTMENT) | Adjustment deltas |

### 8.3 Rebuild Algorithm

```
rebuildReceiptAllocations(client, tenantId, receiptId):

  1. Load receipt lines for receiptId
  2. Load all inventory movements linked to this receipt
  3. For each receipt line:
     a. Start with initial posting movement → create QA allocation(s)
        - Use movement line for warehouseId, locationId, binId, costLayerId
     b. Apply QC events in occurred_at ASC, id ASC order:
        - accept: consume QA qty → create AVAILABLE allocation
        - hold: consume QA qty → create HOLD allocation
        - reject: consume QA qty → no allocation
        - Use QC-linked movement for movement IDs and bin targeting
     c. Apply putaway completions in updated_at ASC, id ASC order:
        - consume QA qty at from_bin → create AVAILABLE allocation at to_bin
        - Use putaway-linked movement for movement IDs
     d. Apply reconciliation adjustments in created_at ASC, id ASC order:
        - positive delta: insert at specified location/bin/status
        - negative delta: consume from matching allocations
        - Use adjustment-linked movement for movement IDs
  4. Validate rebuilt state: quantity conservation per receipt line
  5. If validation fails: ABORT rebuild, return error (authoritative sources are inconsistent — escalate)
  6. Delete existing receipt_allocations for this receipt (within same transaction)
  7. Insert rebuilt allocations
  8. Return: { linesRebuilt, allocationsCreated, driftsCorrected[] }
```

### 8.4 Ordering Guarantees

- QC events: `occurred_at ASC, id ASC`
- Putaway lines: `updated_at ASC, id ASC`
- Reconciliation resolutions: `created_at ASC, id ASC`
- Allocation consumption within each step: `created_at ASC, id ASC` (matches existing `loadReceiptAllocationsByLine` ordering)

### 8.5 Idempotency

Rebuild is idempotent: running it N times for the same receipt produces identical allocation state. It deletes all existing allocations and reconstructs from authoritative data.

### 8.6 When Rebuild Is Triggered

| Trigger | Context | Transaction Boundary |
|---------|---------|---------------------|
| Workflow pre-check fails (§6) | Single receipt line | Within the workflow's transaction — rebuild, re-validate, then proceed or abort. If the workflow aborts, the rebuild is also rolled back |
| Closeout drift detection (§6.4) | Entire receipt | Within closeout transaction — rebuild, re-validate, then proceed or block |
| Operator-initiated admin request | Single receipt or batch | Dedicated transaction |

**Rebuild must NEVER run in a background job without operator authorization.** Background jobs detect and report drift; they do not repair it. Repair occurs only within an active workflow transaction or via explicit operator action.

### 8.7 Rebuild Failure

If rebuild itself fails (e.g., authoritative sources are inconsistent — QC events imply more quantity than receipt line has), this is NOT an allocation problem. It indicates inconsistency in the authoritative sources themselves. The system must:
1. Abort the rebuild (no partial writes)
2. Log the authoritative inconsistency with full details
3. Fail the requesting workflow with `RECEIPT_AUTHORITATIVE_DATA_INCONSISTENT`
4. Require manual investigation

---

## 9. API & Write Boundaries

### 9.1 Write Rules

| Rule | Enforcement |
|------|-------------|
| Writes only from `receipts.service.ts`, `qc.service.ts`, `putaways.service.ts`, `closeout.service.ts` | Static analysis guard (new) |
| All writes within `withTransaction` / `withTransactionRetry` | Existing transaction boundary enforcement |
| INSERT must populate `inventory_movement_id` and `inventory_movement_line_id` | `assertReceiptAllocationTraceability()` (existing) |
| All INSERTs must go through `insertReceiptAllocations()` in `receiptAllocationModel.ts` | Static analysis guard (new) |
| DELETE/UPDATE inline SQL must reference `receipt_allocations` only in the allowed service files | Static analysis guard (new) |

### 9.2 Read Rules

| Rule | Enforcement |
|------|-------------|
| Read via `loadReceiptAllocationsByLine()` for workflow operations | Convention — domain model provides the canonical loader |
| Reads for API display aggregation via `receivingAggregations.ts` | Allowed — clearly display-only |
| Reads must NOT be used as sole validation for ledger writes | Code review + truth tests |
| No cross-domain reads (manufacturing, sales orders must not read `receipt_allocations`) | Static analysis guard or code review |

### 9.3 Static Analysis Guard

Create `scripts/check-receipt-allocation-writes.ts`:

```typescript
const RECEIPT_ALLOCATION_WRITE_PATTERNS = [
  { name: 'receipt_allocations', regex: /\b(INSERT|UPDATE|DELETE)\s+.*\breceipt_allocations\b/i }
];

const RECEIPT_ALLOCATION_ALLOWED = new Set([
  'src/services/receipts.service.ts',
  'src/services/qc.service.ts',
  'src/services/putaways.service.ts',
  'src/services/closeout.service.ts',
  'src/domain/receipts/receiptAllocationModel.ts'
]);
```

Register as `npm run lint:receipt-allocation-writes`. Include in CI alongside `lint:inventory-writes`.

---

## 10. Test Guardrails

### 10.1 Truth Tests (add to `tests/truth/`)

#### T1: Allocation Write Ownership Guard

**File:** `tests/truth/receipt-allocation-write-ownership.test.mjs`

Scan `src/` for SQL statements containing `INSERT|UPDATE|DELETE ... receipt_allocations`. Fail if found outside the allowed set.

#### T2: Allocation Never Used as Ledger Input

**File:** `tests/truth/receipt-allocation-non-authority.test.mjs`

Verify:
- No file in `src/domains/inventory/` reads from `receipt_allocations`
- `receipt_allocations` does not appear in projection rebuild logic
- `receipt_allocations` is not referenced in `ledgerWriter.ts` or `inventoryBalance.ts`

#### T3: Allocation Quantity Conservation (runtime)

**File:** `tests/truth/receipt-allocation-quantity-conservation.test.mjs`

After test seed data: for every non-voided receipt line, `SUM(receipt_allocations.quantity) = quantity_received` (within epsilon).

#### T4: Allocation Movement Traceability (runtime)

**File:** `tests/truth/receipt-allocation-traceability.test.mjs`

Every allocation with non-null `inventory_movement_id` references an existing movement and movement line.

### 10.2 Contract Tests (add to `tests/contracts/`)

#### C1: Drift Detection Catches Known Drift

Create a receipt, manually corrupt an allocation quantity via direct SQL, run drift detection. Assert drift detected with correct type and magnitude.

#### C2: Rebuild Produces Identical State

1. Create receipt → QC accept (partial) → complete putaway
2. Snapshot allocation state
3. Delete all allocations
4. Run rebuild
5. Assert rebuilt state matches snapshot (quantities, statuses, movement links)

#### C3: Workflow Blocks on Invalid Allocations

1. Create receipt (allocations created in QA)
2. Corrupt allocations (e.g., delete one row, breaking quantity conservation)
3. Attempt QC accept
4. Assert: workflow detects drift, attempts rebuild, re-validates
5. Assert: if rebuild succeeds, workflow completes correctly
6. Assert: if rebuild cannot fix (simulate by corrupting authoritative data), workflow fails with explicit error — NOT silent continuation

#### C4: Workflow Blocks on Missing Allocations

1. Create receipt
2. Delete all allocations (simulate total loss)
3. Attempt QC accept
4. Assert: workflow detects missing allocations, attempts rebuild from authoritative sources
5. Assert: if receipt has valid movements, rebuild succeeds and workflow completes
6. Assert: conservation holds after rebuild + workflow

### 10.3 Scenario Tests

#### S1: Full Lifecycle with Drift Detection and Recovery

Receipt → QC accept → putaway → introduce quantity drift → attempt closeout → closeout detects drift → rebuild triggered → re-validation passes → closeout succeeds.

#### S2: Full Lifecycle with Unrecoverable Drift

Receipt → QC accept → introduce drift that rebuild cannot fix (simulate authoritative inconsistency) → attempt putaway → rebuild fails → workflow fails with explicit error → no silent data corruption.

---

## 11. Failure Modes & Handling

### 11.1 Quantity Drift

| Aspect | Detail |
|--------|--------|
| Cause | Bug in allocation mutation (partial update without matching delete), concurrent conflict, application crash mid-transaction |
| Detection | `verifyAllocationQuantityConservation()` at workflow pre-check or closeout |
| System behavior | Workflow pauses, attempts rebuild |
| Recovery | Rebuild from authoritative sources. If rebuild passes conservation, proceed. If rebuild also fails, escalate — indicates authoritative source inconsistency |

### 11.2 Missing Allocations

| Aspect | Detail |
|--------|--------|
| Cause | Application crash after movement but before allocation INSERT (should not happen if transaction boundaries are correct); data migration error |
| Detection | Receipt line has movements but zero allocation rows |
| System behavior | Workflow pre-check fails, triggers rebuild |
| Recovery | Rebuild from authoritative sources. If movements exist, allocations are fully reconstructable |

### 11.3 Orphan Allocations

| Aspect | Detail |
|--------|--------|
| Cause | Receipt voided without cleaning allocations (FK cascade handles deletion but not voiding) |
| Detection | Background drift check finds allocations referencing voided receipt lines |
| System behavior | API over-reports QA/AVAILABLE/HOLD quantities |
| Recovery | Delete orphan allocations. Not workflow-blocking — caught by background check |

### 11.4 Status Drift

| Aspect | Detail |
|--------|--------|
| Cause | QC event written but allocation status not updated (partial failure before allocation mutation in same transaction — should not happen with correct transaction boundaries) |
| Detection | `verifyAllocationStatusConsistency()` — compares allocation status breakdown against QC events + putaway lines |
| System behavior | Workflow targets wrong bin or status. Pre-check catches insufficient QA at expected bin |
| Recovery | Rebuild from authoritative sources |

### 11.5 Movement Link Corruption

| Aspect | Detail |
|--------|--------|
| Cause | Should not occur — movements are append-only |
| Detection | `verifyAllocationMovementLinks()` — join check against ledger |
| System behavior | Traceability broken |
| Recovery | If movement does not exist, this is a **ledger integrity issue**, not an allocation issue. Rebuild will link to existing movements only. The missing-movement gap requires separate investigation |

### 11.6 Concurrent Mutation Conflict

| Aspect | Detail |
|--------|--------|
| Cause | Two workflows attempt to consume the same QA allocation simultaneously |
| Detection | Transaction serialization failure or insufficient-quantity error on retry |
| System behavior | One transaction succeeds, the other retries via `withTransactionRetry` |
| Recovery | Retry reloads current allocation state. Standard behavior — not a drift scenario |

### 11.7 Rebuild Failure (Authoritative Inconsistency)

| Aspect | Detail |
|--------|--------|
| Cause | QC events + putaway lines + reconciliation imply a quantity that does not match `quantity_received`. The authoritative sources themselves disagree |
| Detection | Rebuild post-validation fails conservation check |
| System behavior | Rebuild aborted (no partial writes). Requesting workflow fails with `RECEIPT_AUTHORITATIVE_DATA_INCONSISTENT` |
| Recovery | Manual investigation required. This is not an allocation problem — it is a deeper data integrity issue |

---

## 12. Implementation Phases

### Phase 1: Classification and Documentation (no code changes)

1. Update `docs/refactor_master_plan.md` to resolve the carry-forward:
   - `receipt_allocations` classified as **Operational Support State**
   - Non-authoritative but required for execution
   - Document allowed/forbidden uses
2. Update `docs/domain-invariants.md` with receipt allocation invariant:
   - "receipt_allocations is non-authoritative operational support state. It is required for correct workflow execution but must never be used as the source of truth for quantity correctness."
3. Add classification header comment to `receiptAllocationModel.ts`

### Phase 2: Write Ownership Guard (static analysis)

1. Create `scripts/check-receipt-allocation-writes.ts`
2. Add `npm run lint:receipt-allocation-writes` to `package.json`
3. Include in CI
4. Create truth test T1 (`receipt-allocation-write-ownership.test.mjs`)
5. Create truth test T2 (`receipt-allocation-non-authority.test.mjs`)

### Phase 3: Standalone Drift Detection (new code)

1. Implement `verifyAllocationQuantityConservation()` as standalone non-throwing verifier in `receiptAllocationModel.ts`
2. Implement `verifyAllocationMovementLinks()` in `receiptAllocationModel.ts`
3. Implement `verifyAllocationStatusConsistency()` in `receiptAllocationModel.ts`
4. Create truth tests T3 (quantity conservation) and T4 (traceability)
5. Create contract test C1 (drift detection catches known drift)

### Phase 4: Rebuild Capability (new code)

1. Implement `rebuildReceiptAllocations()` in `src/domain/receipts/receiptAllocationRebuilder.ts`
2. Rebuild from authoritative sources per §8.3 algorithm
3. Include post-rebuild conservation validation (abort on failure)
4. Create contract test C2 (rebuild produces identical state)

### Phase 5: Workflow Pre-Check Integration (code changes to existing services)

Wire the validate → rebuild → re-validate → execute-or-abort pattern into each workflow:

1. **QC workflow** (`qc.service.ts`): Before `moveReceiptAllocationsFromQa()`, validate allocations. On failure, rebuild and retry. On rebuild failure, abort QC event.
2. **Putaway workflow** (`putaways.service.ts`): Before `moveReceiptAllocationsToAvailable()`, validate. On failure, rebuild and retry. On rebuild failure, abort putaway completion.
3. **Reconciliation workflow** (`closeout.service.ts`): Before `applyAdjustmentResolution()`, validate. On failure, rebuild and retry. On rebuild failure, abort resolution.
4. **Closeout workflow** (`closeout.service.ts`): Before closeout state transition, run full drift detection. On drift, rebuild and re-check. On persistent drift, block closeout.

This phase does NOT introduce dual execution paths. The existing workflow path is unchanged — a validation gate and repair attempt are inserted before the existing execution logic. The execution logic itself is not modified.

5. Create contract tests C3 (workflow blocks on invalid allocations) and C4 (workflow blocks on missing allocations)
6. Create scenario tests S1 (lifecycle with recovery) and S2 (lifecycle with unrecoverable drift)

### Phase 6: Background Monitoring (operational)

1. Implement background drift check job (daily or configurable)
2. Scan all open (non-closed-out) receipts
3. Log drift events to structured logs
4. Report-only — background jobs do NOT auto-rebuild

---

## 13. Confidence

| Section | Confidence | Notes |
|---------|-----------|-------|
| Classification | **High** | Directly supported by codebase structure and refactor master plan |
| Allowed/forbidden uses | **High** | Enumerated from code; 4 write paths, 4 read paths, well-bounded |
| Operational role definition | **High** | bin targeting and quantity partitioning requirements are observable in QC, putaway, and reconciliation code |
| Invariants | **High** | Conservation and traceability already partially enforced; extending to standalone checks is straightforward |
| Workflow constraints | **High** | Validate → repair → retry → abort is a single code path with no branching. No dual execution model. No "degraded mode" |
| Drift detection | **High** | Three dimensions (quantity, links, status) cover all observable drift types |
| Rebuild strategy | **Medium-High** | Algorithm is sound but ordering edge cases (partial QC + partial putaway + reconciliation) need validation via contract test C2 |
| API boundaries | **High** | Static guard mirrors proven `check-inventory-writes.ts` pattern |
| Test guardrails | **High** | 4 truth tests, 4 contract tests, 2 scenario tests. C3 and C4 specifically validate that workflows fail correctly on invalid state |
| Failure modes | **High** | All modes derivable from transaction model; §11.7 explicitly handles rebuild failure |

**Overall: High.** The highest-risk area is the rebuild algorithm (Phase 4) — specifically whether it correctly replays all workflow events in order for edge cases. Contract test C2 is the key validator. Phase 5 (workflow pre-check integration) is lower risk than the prior plan's Phase 5 because it does not change the execution logic — it adds a validation gate before it.

---

## Verification

- [x] **No path where workflows proceed with invalid allocations.** §6.5 defines the single execution model: validate → repair → re-validate → proceed-or-abort. There is no "proceed anyway" branch. C3 and C4 test this explicitly.
- [x] **`receipt_allocations` never treated as truth.** §3 enumerates forbidden uses. T2 enforces via static analysis. G7 invariant prevents cross-domain reference.
- [x] **Drift always detected before correctness is impacted.** Drift detection runs as a pre-check before every workflow execution (§6) and before closeout (§6.4). No workflow reaches its mutation step with invalid allocation state.
- [x] **Rebuild used only for recovery.** §8.1 states this explicitly. §8.6 constrains triggers to drift detection within workflows or operator action. Background jobs report only — they do not rebuild.
- [x] **Complexity minimized.** No dual execution paths. No "degraded mode." No "temporal inconsistency." One execution model: validate → repair → execute or abort. The existing workflow code is unchanged — a validation gate is added before it.
