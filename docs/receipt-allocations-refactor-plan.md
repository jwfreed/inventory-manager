# Receipt Allocations — Refactor Plan

## Classification Decision

`receipt_allocations` is **Operational Support State**. It is:
- Non-authoritative
- Mutable (INSERT / UPDATE / DELETE)
- Derivable from authoritative sources
- Useful for workflow coordination

It is NOT:
- A ledger table
- A projection (it is not rebuilt from ledger replay)
- A source of truth for quantity correctness

---

## 1. Allowed Uses

### 1.1 Workflow Coordination

`receipt_allocations` acts as a **materialized cursor** that tracks bin-level receipt quantity through inbound workflow phases (QC → putaway → reconciliation). It exists to answer: "Where is this receipt line's quantity right now, and what status is it in?"

Allowed coordination roles:

| Role | Description |
|------|-------------|
| QC routing | Track which bins hold QA-pending quantity so QC events can target the correct source |
| Putaway source | Identify QA allocations at a source bin for putaway line consumption |
| Reconciliation targeting | Locate allocations by location/bin/status for adjustment application |
| Status aggregation | Summarize QA / AVAILABLE / HOLD quantities per receipt line for API responses |

### 1.2 Allowed Write Patterns

Writes are permitted only when **paired with a corresponding ledger write** (inventory movement) in the same transaction. Every INSERT must populate `inventory_movement_id` and `inventory_movement_line_id` (enforced by existing `assertReceiptAllocationTraceability`).

| Writer | Service | Trigger | Operations |
|--------|---------|---------|------------|
| Receipt creation | `receipts.service.ts` | PO receipt posted | INSERT (status=QA) |
| QC accept/hold | `qc.service.ts` | QC event recorded | DELETE/UPDATE source QA, INSERT destination AVAILABLE/HOLD |
| Putaway completion | `putaways.service.ts` | Putaway line completed | DELETE/UPDATE source QA, INSERT destination AVAILABLE |
| Reconciliation adjustment | `closeout.service.ts` | Discrepancy resolved | INSERT (positive delta) or DELETE/UPDATE (negative delta) |

No other write paths are permitted.

### 1.3 Allowed Read Patterns

| Reader | Purpose | Constraint |
|--------|---------|------------|
| `loadReceiptAllocationsByLine()` | Load allocations for workflow mutation targeting | Must be followed by authoritative validation |
| `receivingAggregations.ts` | Compute QA/AVAILABLE/HOLD summaries for API | Display only — must not drive correctness decisions |
| `deriveReceiptAvailabilityFromAllocations()` | Determine receipt availability state | Informational — gated by lifecycle state, not allocation alone |
| Putaway readiness check | Sum AVAILABLE allocations per receipt | Informational — must not be sole gate for receipt closeout |

### 1.4 Acceptable Dependencies

- `receipt_allocations` MAY depend on: `purchase_order_receipt_lines`, `inventory_movements`, `inventory_movement_lines`, `inventory_bins`, `locations`, `inventory_cost_layers`
- Other tables MUST NOT depend on `receipt_allocations` (no inbound foreign keys)

---

## 2. Forbidden Uses

### 2.1 Never Source of Truth

| Forbidden Use | Reason | Enforcement |
|---------------|--------|-------------|
| Using allocation totals to validate inventory correctness | Allocations are mutable; ledger is authoritative | Truth test + code review |
| Using allocation status to gate ledger writes | Would make operational state a correctness prerequisite | Static analysis guard |
| Using allocations as input to `inventory_balance` projection rebuild | Projections derive from ledger only (AGENTS.md § Projection Rebuilds) | Existing truth test |
| Reading allocations during full-system replay | Replay consumes ledger only (System Model § 3.3) | Architecture invariant |
| Treating allocation quantity as canonical received quantity | `purchase_order_receipt_lines.quantity_received` is authoritative | Drift detection |

### 2.2 Never a Correctness Gate

No code path may allow a workflow to fail or succeed based **solely** on the state of `receipt_allocations`.

Specifically:

- **Receipt closeout** must not fail only because allocation totals disagree — it must validate against ledger movements.
- **QC event recording** must create the `qc_event` and the ledger movement regardless of allocation state. Allocation mutation is a side-effect, not a prerequisite.
- **Putaway completion** must succeed based on movement integrity, not allocation availability. If allocations are missing, the system must detect this as drift rather than block the workflow.

### 2.3 Never Written Outside Transaction + Movement Pair

Every allocation write must occur:
1. Inside a `withTransaction` / `withTransactionRetry` boundary
2. In the same transaction as the corresponding inventory movement
3. After the movement has been created (allocation references the movement ID)

Writing allocation rows without a corresponding movement is forbidden.

---

## 3. Drift Detection Strategy

### 3.1 What Can Drift

| Drift Type | Description |
|------------|-------------|
| Quantity drift | Sum of allocations per receipt line ≠ `quantity_received` on `purchase_order_receipt_lines` |
| Movement link drift | Allocation references a movement ID that does not exist or has different quantity |
| Status drift | Allocation in status X but corresponding QC events / putaway lines indicate status Y |
| Orphan allocations | Allocation row references a receipt line that no longer exists or has been voided |
| Missing allocations | Receipt line has posted movements but no corresponding allocations |

### 3.2 When to Check

| Trigger | What to Check | Severity |
|---------|---------------|----------|
| Receipt closeout (pre-close validation) | Quantity conservation, movement link integrity, status completeness | **Hard fail** — closeout blocked until drift resolved |
| Periodic background job (recommended: daily) | All drift types across open receipts | **Soft alert** — log + expose in admin API |
| On-demand rebuild request | Full reconciliation of specified receipt | **Informational** — operator-initiated |
| Before reconciliation adjustment application | Quantity conservation for affected receipt line | **Hard fail** — adjustment blocked if pre-existing drift detected |

### 3.3 Drift Detection Implementation

#### 3.3.1 Quantity Conservation Check

Already exists as `assertReceiptAllocationQuantityConservation()` in `receiptAllocationModel.ts`. Currently called inline during individual workflows.

**New requirement:** Expose as a standalone callable check that can be run against any receipt line ID:

```
verifyAllocationQuantityConservation(client, tenantId, receiptLineIds)
  → { lineId, expected, actual, driftQty, pass }[]
```

Source of expected: `purchase_order_receipt_lines.quantity_received`
Source of actual: `SUM(receipt_allocations.quantity) WHERE receipt_line_id = X`

#### 3.3.2 Movement Link Integrity Check

New function:

```
verifyAllocationMovementLinks(client, tenantId, receiptLineIds)
  → { allocationId, movementId, movementLineId, exists, qtyMatch, pass }[]
```

For each allocation:
- Verify `inventory_movement_id` exists in `inventory_movements`
- Verify `inventory_movement_line_id` exists in `inventory_movement_lines`
- Verify movement line quantity is consistent with allocation purpose

#### 3.3.3 Status Consistency Check

New function:

```
verifyAllocationStatusConsistency(client, tenantId, receiptLineIds)
  → { lineId, qaQty, acceptedQty, heldQty, expectedFromEvents, drifts[] }
```

Derives expected status distribution from:
- `qc_events` (accept → AVAILABLE, hold → HOLD, reject → removed)
- `putaway_lines` with status=completed (QA → AVAILABLE)
- `receipt_reconciliation_resolutions` (adjustments)

Compares against actual allocation status breakdown.

### 3.4 Drift Logging

All drift detections must be logged with:
- Receipt ID, receipt line ID
- Drift type
- Expected vs actual values
- Timestamp
- Whether the check was blocking (closeout) or informational (background)

Drift events should be written to a `receipt_allocation_drift_events` table or logged to structured application logs (implementation detail — do not require a new table if structured logging is sufficient).

---

## 4. Rebuild Strategy

### 4.1 Rebuild Sources

`receipt_allocations` can be reconstructed from the following authoritative tables, processed in order:

| Step | Source Table | What It Provides |
|------|-------------|------------------|
| 1 | `purchase_order_receipt_lines` | Receipt line IDs, `quantity_received` |
| 2 | `inventory_movements` + `inventory_movement_lines` | Movement IDs, quantities, movement types for the receipt |
| 3 | `qc_events` | QC decisions (accept/hold/reject) with quantities, ordered by `occurred_at` |
| 4 | `putaway_lines` (status=completed) | Putaway completions with from/to location/bin, ordered by `updated_at` |
| 5 | `receipt_reconciliation_resolutions` (type=ADJUSTMENT) | Adjustment deltas applied during reconciliation |

### 4.2 Rebuild Algorithm

```
rebuildReceiptAllocations(client, tenantId, receiptId):

  1. Load receipt lines for receiptId
  2. Load all inventory movements linked to this receipt (by reference)
  3. For each receipt line:
     a. Start with initial posting movement → create QA allocation(s)
        - Use movement line to derive warehouseId, locationId, binId, costLayerId
     b. Apply QC events in occurred_at order:
        - accept: consume QA qty → create AVAILABLE allocation
        - hold: consume QA qty → create HOLD allocation
        - reject: consume QA qty → no allocation (removed)
        - Use QC-linked movement for movement IDs and bin targeting
     c. Apply putaway completions in updated_at order:
        - consume QA qty at from_bin → create AVAILABLE allocation at to_bin
        - Use putaway-linked movement for movement IDs
     d. Apply reconciliation adjustments in created_at order:
        - positive delta: insert allocation at specified location/bin/status
        - negative delta: consume from matching allocations
        - Use adjustment-linked movement for movement IDs
  4. Delete existing receipt_allocations for this receipt
  5. Insert rebuilt allocations
  6. Validate quantity conservation against receipt line quantities
  7. Return rebuild report: { linesRebuilt, allocationsCreated, driftsDetected[] }
```

### 4.3 Ordering Guarantees

- QC events: ordered by `occurred_at ASC, id ASC`
- Putaway lines: ordered by `updated_at ASC, id ASC`
- Reconciliation resolutions: ordered by `created_at ASC, id ASC`
- Within each step, allocation consumption uses `created_at ASC, id ASC` (matching existing `loadReceiptAllocationsByLine` ordering)

### 4.4 Idempotency

Rebuild is idempotent: running it multiple times for the same receipt produces identical allocation state. The rebuild deletes all existing allocations and reconstructs from authoritative data.

### 4.5 When Rebuild Is Triggered

| Trigger | Scope | Automation |
|---------|-------|------------|
| Drift detected at closeout | Single receipt | Automatic — attempt rebuild, re-check, then proceed or fail |
| Operator request via admin API | Single receipt or batch | Manual |
| Background job finds persistent drift | Affected receipts | Semi-automatic — queued for review or auto-rebuild based on policy |
| Schema migration affecting allocations | All open receipts | Migration script |

---

## 5. API Boundaries

### 5.1 Write Rules

| Rule | Enforcement |
|------|-------------|
| Writes only from `receipts.service.ts`, `qc.service.ts`, `putaways.service.ts`, `closeout.service.ts` | Static analysis guard (new) |
| All writes within `withTransaction` / `withTransactionRetry` | Existing transaction boundary enforcement |
| INSERT must populate `inventory_movement_id` and `inventory_movement_line_id` | `assertReceiptAllocationTraceability()` (existing) |
| All INSERTs must go through `insertReceiptAllocations()` in `receiptAllocationModel.ts` | Static analysis guard (new) |
| DELETE/UPDATE inline SQL must reference `receipt_allocations` only in the 4 allowed service files | Static analysis guard (new) |

### 5.2 Read Rules

| Rule | Enforcement |
|------|-------------|
| Read via `loadReceiptAllocationsByLine()` for workflow operations | Convention — domain model provides the canonical loader |
| Reads for API display aggregation in `receivingAggregations.ts` | Allowed — clearly display-only |
| Reads must NOT be used as sole validation for ledger writes | Code review + truth tests |
| No cross-domain reads (e.g., manufacturing, sales order allocation must not read `receipt_allocations`) | Static analysis guard or code review |

### 5.3 Static Analysis Guard

Extend `scripts/check-inventory-writes.ts` (or create a parallel guard `scripts/check-receipt-allocation-writes.ts`) to enforce:

```typescript
const RECEIPT_ALLOCATION_WRITE_PATTERNS = [
  { name: 'receipt_allocations', regex: /\b(INSERT|UPDATE|DELETE)\s+.*\breceipt_allocations\b/i }
];

const RECEIPT_ALLOCATION_ALLOWED = new Set([
  'src/services/receipts.service.ts',
  'src/services/qc.service.ts',
  'src/services/putaways.service.ts',
  'src/services/closeout.service.ts',
  'src/domain/receipts/receiptAllocationModel.ts'  // insertReceiptAllocations only
]);
```

Add as `npm run lint:receipt-allocation-writes` and include in CI.

---

## 6. Workflow Constraints

### 6.1 QC Workflow

| Aspect | Constraint |
|--------|-----------|
| Allocation read | Load QA allocations by receipt line + source bin to target consumption |
| Allocation write | DELETE/UPDATE consumed QA rows, INSERT new AVAILABLE/HOLD rows |
| Must validate against | QC event quantity ≤ available QA quantity in allocations; if insufficient, this is a drift signal, not a workflow block |
| Authoritative action | `qc_events` INSERT + inventory movement creation must succeed regardless of allocation state |
| Failure mode | If allocations are missing/drifted, record QC event and movement, then trigger allocation rebuild for the affected receipt line |

### 6.2 Putaway Workflow

| Aspect | Constraint |
|--------|-----------|
| Allocation read | Load QA allocations by receipt line + from_bin_id |
| Allocation write | DELETE/UPDATE consumed QA rows, INSERT AVAILABLE rows at destination bin |
| Must validate against | Putaway `quantity_planned` ≤ available QA quantity; if insufficient, flag drift |
| Authoritative action | Putaway line completion + inventory movement must succeed based on planned quantity |
| Failure mode | If QA allocations insufficient, complete the putaway movement and schedule allocation rebuild |

### 6.3 Reconciliation Workflow

| Aspect | Constraint |
|--------|-----------|
| Allocation read | Load allocations at discrepancy location/bin/status |
| Allocation write | INSERT (positive delta), DELETE/UPDATE (negative delta) |
| Must validate against | Expected quantity from authoritative sources before applying adjustment |
| Authoritative action | Reconciliation resolution + adjustment movement is authoritative; allocation mutation follows |
| Failure mode | If matching allocations not found for negative delta, apply the adjustment movement anyway and trigger rebuild |

### 6.4 Receipt Closeout Workflow

| Aspect | Constraint |
|--------|-----------|
| Allocation read | Aggregate allocations by status to determine readiness |
| Allocation write | None during closeout itself |
| Must validate against | Posting integrity check: `buildReceiptPostingIntegrity()` compares allocations against receipt line quantities AND posted movement quantities |
| Pre-closeout gate | Run drift detection (§3). If drift found, attempt rebuild (§4). If rebuild fails, block closeout with explicit error |
| Authoritative action | Closeout state transition is authoritative; allocation state is informational input |

---

## 7. Test Guardrails

### 7.1 Truth Tests (add to `tests/truth/`)

#### T1: Allocation Write Ownership Guard

**File:** `tests/truth/receipt-allocation-write-ownership.test.mjs`

Verify that `receipt_allocations` write SQL (INSERT/UPDATE/DELETE) appears only in the allowed files. Mirrors the pattern in `scripts/check-inventory-writes.ts`.

Assertion: Scan `src/` for SQL statements referencing `receipt_allocations` with write verbs. Fail if found outside the allowed set.

#### T2: Allocation Never Used as Ledger Input

**File:** `tests/truth/receipt-allocation-non-authority.test.mjs`

Verify that:
- No file in `src/domains/inventory/` reads from `receipt_allocations`
- `receipt_allocations` does not appear in any projection rebuild logic
- `receipt_allocations` is not referenced in `ledgerWriter.ts`
- `receipt_allocations` is not referenced in `inventoryBalance.ts`

Assertion: Grep-based static check. Fail if `receipt_allocations` appears in ledger/projection files.

#### T3: Allocation Quantity Conservation (runtime)

**File:** `tests/truth/receipt-allocation-quantity-conservation.test.mjs`

After test seed data is loaded, verify that for every receipt line:
- `SUM(receipt_allocations.quantity)` = `purchase_order_receipt_lines.quantity_received`
- Or the receipt line has zero allocations (voided/rejected)

This runs against the test database to catch conservation violations.

#### T4: Allocation Movement Traceability

**File:** `tests/truth/receipt-allocation-traceability.test.mjs`

Verify that every `receipt_allocations` row with non-null `inventory_movement_id`:
- References a movement that exists in `inventory_movements`
- References a movement line that exists in `inventory_movement_lines`

### 7.2 Contract Tests (add to `tests/contracts/`)

#### C1: Drift Detection Catches Known Drift

**File:** extend `tests/contracts/receive.test.mjs` or new file

Create a receipt, manually corrupt an allocation quantity, then run drift detection. Verify drift is detected with correct type and magnitude.

#### C2: Rebuild Produces Identical State

**File:** new `tests/contracts/receipt-allocation-rebuild.test.mjs`

1. Create a receipt
2. Run QC accept on part of it
3. Complete putaway
4. Snapshot allocation state
5. Delete all allocations
6. Run rebuild
7. Assert rebuilt state matches snapshot (same rows, quantities, statuses, movement links)

#### C3: Workflow Succeeds Without Allocations (degraded mode)

If the design moves to non-blocking allocation updates (§6), add a contract test:

1. Create a receipt (allocations created)
2. Delete allocations (simulate corruption)
3. Run QC accept (should succeed — QC event + movement created)
4. Verify allocations were rebuilt
5. Verify ledger is correct

This test validates that allocations are truly non-authoritative.

### 7.3 Scenario Tests

#### S1: Full Lifecycle Drift and Recovery

End-to-end: receipt → QC → putaway → introduce drift → closeout detects drift → rebuild → closeout succeeds.

---

## 8. Failure Modes & Recovery

### 8.1 Quantity Drift

| Aspect | Detail |
|--------|--------|
| Cause | Bug in allocation mutation logic (partial update without matching delete), concurrent transaction conflict, application crash between movement write and allocation write |
| Detection | `verifyAllocationQuantityConservation()` at closeout or background check |
| System behavior | Closeout blocked; background alert raised |
| Recovery | Rebuild allocations from authoritative sources (§4). If rebuild also fails quantity conservation, escalate — indicates ledger/receipt line mismatch (separate issue) |

### 8.2 Missing Allocations

| Aspect | Detail |
|--------|--------|
| Cause | Application crash after movement creation but before allocation INSERT; partial transaction rollback where movement committed but allocation did not (should not happen with proper transaction boundaries) |
| Detection | Receipt line has posted movements but zero `receipt_allocations` rows |
| System behavior | QC/putaway workflow finds no QA allocations to consume |
| Recovery | Rebuild allocations for affected receipt line. If movements exist, allocations are reconstructable |

### 8.3 Orphan Allocations

| Aspect | Detail |
|--------|--------|
| Cause | Receipt line deleted or voided without cleaning up allocations; FK cascade should handle receipt deletion but voiding may not |
| Detection | Allocation references a receipt line that is voided or does not exist |
| System behavior | Allocations inflate reported QA/AVAILABLE/HOLD quantities |
| Recovery | Delete orphan allocations. Verify receipt line status before deletion |

### 8.4 Status Drift

| Aspect | Detail |
|--------|--------|
| Cause | QC event recorded but allocation status not updated (partial failure); putaway completed but allocation still shows QA |
| Detection | `verifyAllocationStatusConsistency()` — compare allocation status distribution against QC events + putaway lines |
| System behavior | API shows incorrect QA/AVAILABLE/HOLD breakdown; operator sees stale status |
| Recovery | Rebuild allocations. QC events and putaway lines are authoritative for status derivation |

### 8.5 Movement Link Corruption

| Aspect | Detail |
|--------|--------|
| Cause | Allocation `inventory_movement_id` references a deleted or non-existent movement (should not happen — movements are append-only) |
| Detection | `verifyAllocationMovementLinks()` — join check against movement tables |
| System behavior | Traceability broken — cannot audit allocation back to ledger event |
| Recovery | This indicates a serious system integrity issue. If the movement truly does not exist, this is a ledger problem, not an allocation problem. Allocation rebuild would produce allocations linked to existing movements only; the missing-movement gap must be investigated separately |

### 8.6 Concurrent Mutation Conflict

| Aspect | Detail |
|--------|--------|
| Cause | Two workflows (e.g., QC accept + putaway) attempt to consume the same QA allocation concurrently |
| Detection | Transaction serialization failure or insufficient-quantity error |
| System behavior | One transaction succeeds, the other retries or fails |
| Recovery | Existing `withTransactionRetry` handles serialization conflicts. The retry will reload current allocation state |

---

## 9. Implementation Phases

### Phase 1: Classification and Documentation (no code changes)

1. Update `docs/refactor_master_plan.md` to resolve the carry-forward:
   - `receipt_allocations` is classified as **Operational Support State**
   - Document allowed/forbidden uses from §1–§2
2. Update `docs/domain-invariants.md` with explicit receipt allocation invariant:
   - "receipt_allocations is non-authoritative operational support state. It must never be used as the source of truth for quantity correctness."
3. Add inline code comment to `receiptAllocationModel.ts`:
   - Classification header explaining the table's role and constraints

### Phase 2: Write Ownership Guard (static analysis)

1. Create `scripts/check-receipt-allocation-writes.ts`
   - Mirrors `check-inventory-writes.ts` pattern
   - Allowed files: `receipts.service.ts`, `qc.service.ts`, `putaways.service.ts`, `closeout.service.ts`, `receiptAllocationModel.ts`
   - Fail if any other `.ts` file contains `INSERT|UPDATE|DELETE ... receipt_allocations`
2. Add `npm run lint:receipt-allocation-writes` script to `package.json`
3. Add to CI pipeline (alongside `lint:inventory-writes`)
4. Create truth test `receipt-allocation-write-ownership.test.mjs`
5. Create truth test `receipt-allocation-non-authority.test.mjs`

### Phase 3: Drift Detection (new code)

1. Implement `verifyAllocationQuantityConservation()` as standalone function in `receiptAllocationModel.ts`
2. Implement `verifyAllocationMovementLinks()` in `receiptAllocationModel.ts`
3. Implement `verifyAllocationStatusConsistency()` in `receiptAllocationModel.ts`
4. Wire quantity conservation check into closeout pre-validation (hard fail)
5. Create truth tests for quantity conservation and traceability (T3, T4)

### Phase 4: Rebuild Capability (new code)

1. Implement `rebuildReceiptAllocations()` in a new file `src/domain/receipts/receiptAllocationRebuilder.ts`
2. Build from authoritative sources per §4.2 algorithm
3. Create contract test `receipt-allocation-rebuild.test.mjs` (C2)
4. Wire rebuild into closeout: if drift detected → attempt rebuild → re-validate → proceed or fail
5. Create contract test for drift-detection-catches-known-drift (C1)

### Phase 5: Workflow Hardening (code changes to existing services)

1. In each write service (`qc.service.ts`, `putaways.service.ts`, `closeout.service.ts`):
   - Ensure allocation mutation failure does NOT block the authoritative action (movement + event)
   - If allocation mutation fails, log the failure and trigger rebuild
   - Authoritative writes must complete independently of allocation state
2. This is the highest-risk phase — requires careful contract test coverage for each workflow
3. Create contract test C3 (workflow succeeds without allocations)
4. Create scenario test S1 (full lifecycle drift and recovery)

### Phase 6: Background Monitoring (operational)

1. Implement background drift check job (daily or configurable)
2. Scan all open (non-closed-out) receipts
3. Log drift events to structured logs or drift events table
4. Expose drift summary in admin API (optional, lower priority)

---

## 10. Confidence

| Section | Confidence | Notes |
|---------|-----------|-------|
| Allowed uses | **High** | Directly observed from codebase; 4 write paths, 4 read paths, well-bounded |
| Forbidden uses | **High** | Aligns with existing system model (§3.1 of refactor master plan) and AGENTS.md invariants |
| Drift detection | **High** | `assertReceiptAllocationQuantityConservation()` already exists; extending to standalone checks is straightforward |
| Rebuild strategy | **Medium-High** | Algorithm is sound but rebuild from QC events + putaway lines ordering has not been validated against edge cases (partial QC, multiple putaway rounds, reconciliation on top of partial putaway). Contract test C2 is the key validator |
| API boundaries | **High** | Static guard is a proven pattern (mirrors `check-inventory-writes.ts`) |
| Workflow constraints | **Medium-High** | Phase 5 (non-blocking allocation mutation) is the highest-risk change. Today, QC/putaway workflows throw if allocations are insufficient. Making them non-blocking requires careful failure path design |
| Test guardrails | **High** | Truth tests are static analysis; contract tests follow established patterns; scenario test covers end-to-end |
| Failure modes | **High** | All modes are observable in practice or derivable from the transaction model |

**Overall: High confidence** that this plan correctly positions `receipt_allocations` as operational support state with enforceable boundaries. The rebuild algorithm (Phase 4) and workflow hardening (Phase 5) are the areas requiring the most careful validation during implementation.

---

## Verification

- [x] Allowed vs forbidden uses are unambiguous — §1 and §2 are enumerated and non-overlapping
- [x] No path allows allocations to become authoritative — write ownership guard (§5.3) + truth test T2 prevent cross-domain use; forbidden-use rules (§2) prevent correctness gating
- [x] Drift is always detectable — three detection functions cover quantity, movement link, and status dimensions; closeout gates on drift check
- [x] Rebuild is always possible — authoritative sources (receipt lines, movements, QC events, putaway lines, reconciliation resolutions) are append-only or immutable; ordering is deterministic
- [x] Tests are sufficient to prevent regression — 4 truth tests, 3 contract tests, 1 scenario test cover write ownership, non-authority, quantity conservation, traceability, drift detection, rebuild correctness, and degraded-mode operation
