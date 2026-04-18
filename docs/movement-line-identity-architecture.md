# Movement Line Identity Architecture

> Specification for making receipt allocation rebuild fully deterministic,
> reconstructable, and independent of metadata heuristics.

---

## Identity Gaps (Current System)

### Gap 1: `sourceLineId` is generated but not persisted

Every movement-line creation site generates a `sourceLineId` value that uniquely identifies the originating domain entity (receipt line, putaway line, QC event, etc.). This value flows through `sortDeterministicMovementLines` to establish stable ordering, then is **discarded** — it is not written to `inventory_movement_lines`.

**Impact:** The strongest identity signal available at write time is lost. Rebuild must reconstruct it via heuristics.

### Gap 2: Receipt posting rebuild depends on note text parsing

Matching: `findMovementLine({ ..., noteIncludes: receiptLineId })`.
The receipt line ID is embedded in `line_notes` as `"PO receipt line {receiptLineId}"`. Rebuild finds the movement line by substring search against this formatted string.

**Impact:** Identity depends on a display-layer convention. If the note format changes, rebuild breaks silently.

### Gap 3: QC rebuild has no sub-movement discriminator

Matching: `findMovementLine({ movementId, itemId, locationId, quantity, direction: 'positive' })`.
No `noteIncludes` or structural identifier is used. Matching relies entirely on coordinate coincidence within a known movement.

**Impact:** Works today because each QC event creates exactly one movement (enforced by `UNIQUE(qc_event_id)` on `qc_inventory_links`) with one transfer pair. If QC ever produces multi-item or multi-line movements, matching becomes ambiguous with no discriminator available.

### Gap 4: Putaway rebuild depends on note text parsing

Matching: `findMovementLine({ ..., noteIncludes: 'Putaway {putawayId} line {lineNumber}' })`.
The putaway identity is embedded in `line_notes` via formatted string.

**Impact:** Same fragility as Gap 2. The `Putaway {id} line {num}` token is an implicit contract between the putaway service and the rebuilder, enforced only by convention.

### Gap 5: Reconciliation rebuild depends on reason_code convention

Matching: `findMovementLine({ ..., reasonCode: 'receipt_reconciliation' })`.
Movement ID is sourced from `receipt_reconciliation_resolutions.metadata.inventoryMovementId` (JSONB field, not a typed column).

**Impact:** Matching depends on a string convention in `reason_code` plus a JSONB metadata path. If multiple reconciliation lines share the same movement/item/location/quantity, matching is ambiguous.

### Gap 6: No structural back-link from movement lines to source entities

`inventory_movement_lines` has no column that references the originating domain line (receipt line, putaway line, QC event, etc.). The only quasi-identity mechanisms are:

| Workflow | Mechanism | Type |
|----------|-----------|------|
| Receipt | `line_notes` substring | Metadata heuristic |
| QC | Coordinate match only | Shape heuristic |
| Putaway | `line_notes` substring | Metadata heuristic |
| Reconciliation | `reason_code` exact match | Convention heuristic |

None of these are structural. All are fragile under system evolution.

---

## Target Identity Model

### Core Principle

**Every movement line must carry an immutable, structural identifier linking it to its originating domain entity.** This identifier must be sufficient, combined with `movement_id`, to uniquely resolve any movement line without heuristics.

### Entities and Identifiers

```
inventory_movements
  ├─ id (PK)
  ├─ source_type   ("po_receipt", "qc_event", "putaway", ...)
  └─ source_id     (originating entity ID)

inventory_movement_lines
  ├─ id (PK)
  ├─ movement_id (FK → inventory_movements)
  └─ source_line_id (NEW — stable domain-entity identifier)
```

### Relationships

```
(movement_id, source_line_id) → unique movement line   [within a movement]
source_line_id → originating domain sub-entity          [by convention per source_type]
```

### `source_line_id` Value Contracts

These are the values already generated at each creation site as `sourceLineId`. The column persists what already exists:

| Workflow | `source_line_id` pattern | Origin |
|----------|--------------------------|--------|
| Receipt posting | `{receiptLineId}` | `receiptPosting.ts` — bare UUID of receipt line |
| QC transfer (OUT) | `qc_event:{qcEventId}:out` | `transferPlan.ts` — `${sourceType}:${sourceId}:out` |
| QC transfer (IN) | `qc_event:{qcEventId}:in` | `transferPlan.ts` — `${sourceType}:${sourceId}:in` |
| Putaway (OUT) | `{putawayLineId}:out` | `putaways.service.ts` — `${line.id}:out` |
| Putaway (IN) | `{putawayLineId}:in` | `putaways.service.ts` — `${line.id}:in` |
| Reconciliation | `{receiptLineId}` | `receiptReconciliation.ts` — receipt line ID |
| Adjustment | `{adjustmentLineId}` | `posting.service.ts` |
| Cycle count | `{countDeltaLineId}` | `counts.service.ts` |
| Work order issue | `{workOrderLineId}` | `workOrderIssuePost.workflow.ts` |
| Work order completion | `{workOrderLineId}` | `workOrderCompletionPost.workflow.ts` |
| Returns receipt | `{returnLineId}` | `receiptPosting.ts` (returns) |
| Disposition | `{dispositionId}:{lineId}:out\|in` | `dispositionPosting.ts` |
| License plate ops | `{licensePlateId}:out\|in` | `licensePlates.service.ts` |
| Generic transfer | `{sourceType}:{sourceId}:out\|in` | `transferPlan.ts` |

No new value generation is required. The column stores what is already computed and discarded.

---

## Required Schema Changes (Minimal)

### Change 1: Add `source_line_id` to `inventory_movement_lines`

```sql
ALTER TABLE inventory_movement_lines
  ADD COLUMN source_line_id TEXT;
```

**Nullable.** Historical rows (pre-migration) will have `NULL`. New rows must always populate it.

### Change 2: Partial unique index for intra-movement uniqueness

```sql
CREATE UNIQUE INDEX idx_movement_lines_source_identity
  ON inventory_movement_lines (movement_id, source_line_id)
  WHERE source_line_id IS NOT NULL;
```

**Why partial:** Historical rows with `NULL` are excluded. The constraint applies only to post-migration data where identity is structural.

### Change 3: Persist `sourceLineId` in ledger writer

In `createInventoryMovementLine()` (`src/domains/inventory/internal/ledgerWriter.ts`):

- Add `source_line_id` to the `INSERT` column list
- Map from the existing `sourceLineId` field already present on `PersistInventoryMovementLineInput`

This is a one-line addition to the column list and parameter array. No new input types required.

### What is NOT changed

- No new tables
- No new foreign keys (the column is a domain-convention identifier, not a FK — source entities span multiple tables)
- No changes to `inventory_movements`
- No changes to existing `sourceLineId` generation at any creation site
- No changes to note formatting (notes remain for human audit; they are no longer the identity mechanism)
- No backfill of historical rows (respects ledger immutability)

---

## Invariants (Authoritative)

### I1: Intra-movement uniqueness

Within any single movement, no two lines may share the same non-null `source_line_id`.

```
∀ movement_id m:
  source_line_id values in {lines of m where source_line_id IS NOT NULL}
  are pairwise distinct
```

Enforced by: partial unique index `idx_movement_lines_source_identity`.

### I2: Post-migration completeness

Every movement line created after migration deployment MUST have a non-null `source_line_id`.

```
∀ movement_line l created after migration:
  l.source_line_id IS NOT NULL
```

Enforced by: truth test asserting no post-migration nulls.

### I3: Immutability

`source_line_id`, once written, is never modified. Inherits from ledger immutability (existing triggers prevent UPDATE/DELETE on `inventory_movement_lines`).

Enforced by: existing ledger immutability triggers.

### I4: Rebuild sufficiency

For any post-migration movement line, `(movement_id, source_line_id)` is sufficient to resolve exactly one line without coordinate matching or note parsing.

```
∀ authoritative source line s with known movement_id m and computed source_line_id k:
  SELECT * FROM inventory_movement_lines
  WHERE movement_id = m AND source_line_id = k
  → exactly 1 row
```

Enforced by: I1 + I2 together.

### I5: Value stability

The `source_line_id` for a given domain operation is deterministic — the same domain inputs always produce the same value. This is already guaranteed by the existing `sourceLineId` generation logic at each creation site.

---

## Rebuild Contract (Post-Change)

### Determinism Guarantees

1. **Structural matching:** For post-migration data, `findMovementLine` matches by `(movement_id, source_line_id)` — a direct index lookup, O(1), no ambiguity possible.

2. **No heuristic dependency:** Rebuild does not parse `line_notes`, inspect `reason_code`, or rely on coordinate shape for post-migration movement lines.

3. **Identical inputs → identical outputs:** Deterministic allocation IDs, deterministic ordering, deterministic movement-line resolution. No dependence on query ordering or created_at timestamps for disambiguation.

### Matching Rules (Post-Change)

| Workflow | Current Matching | Post-Change Matching |
|----------|------------------|----------------------|
| Receipt | `noteIncludes: receiptLineId` | `sourceLineId: receiptLineId` |
| QC | Coordinate match (item + location + qty + direction) | `sourceLineId: 'qc_event:{qcEventId}:in'` |
| Putaway | `noteIncludes: 'Putaway {id} line {num}'` | `sourceLineId: '{putawayLineId}:in'` |
| Reconciliation | `reasonCode: 'receipt_reconciliation'` | `sourceLineId: receiptLineId` |

### Backward Compatibility

For pre-migration data (`source_line_id IS NULL`), the rebuilder falls back to current heuristic matching. This is safe because:

- Historical data already works with current matching
- New data uses structural matching
- The two populations are disjoint (distinguished by column nullability)
- Over time, active receipts cycle through and all live allocations become structurally matched

### Upgraded `findMovementLine`

```
function findMovementLine(params) {
  if (params.sourceLineId) {
    // Post-migration: structural match
    SELECT ... WHERE movement_id = $1 AND source_line_id = $2
    → must return exactly 1 row
  } else {
    // Pre-migration fallback: existing heuristic matching
    (current logic unchanged)
  }
}
```

---

## Migration Plan

### Phase 1: Schema Addition (Non-Breaking)

**Migration file:** Add nullable `source_line_id` column and partial unique index.

- Zero downtime: nullable column, no existing data modified
- No application code changes required to deploy
- Existing writes continue to work (column defaults to NULL)
- Ledger immutability preserved: no UPDATE of historical rows

### Phase 2: Writer Update

**Change:** `createInventoryMovementLine()` persists `sourceLineId` → `source_line_id`.

- Single-line change in the INSERT statement
- `sourceLineId` already exists on `PersistInventoryMovementLineInput`
- All creation sites already generate `sourceLineId`
- Deployed after Phase 1; new movements get structural identity immediately

### Phase 3: Rebuilder Update

**Change:** `findMovementLine()` accepts optional `sourceLineId` parameter. When provided, uses direct index lookup instead of heuristic matching.

Rebuilder call sites updated:

| Section | Change |
|---------|--------|
| Receipt lines | Pass `sourceLineId: receiptLineId` when movement line has `source_line_id` |
| QC events | Pass `sourceLineId: 'qc_event:{qcEventId}:in'` when movement line has `source_line_id` |
| Putaway lines | Pass `sourceLineId: '{putawayLineId}:in'` when movement line has `source_line_id` |
| Reconciliation | Pass `sourceLineId: receiptLineId` when movement line has `source_line_id` |

Detection: query movement lines to check for non-null `source_line_id` before choosing matching strategy. Or: always attempt structural match first, fall back on miss for pre-migration data.

### Phase 4: Deprecation of Heuristic Matching

Once all active receipts have cycled through (all live movement lines have `source_line_id`), the heuristic fallback path can be removed. This is a future cleanup, not part of the initial change.

### Backward Compatibility Strategy

- Phase 1 + 2 can deploy independently with zero behavior change
- Phase 3 adds the new matching path but retains fallback
- No data migration or backfill required
- No existing tests break at any phase
- Each phase is independently deployable and independently revertable

---

## Validation Tests

### Truth Tier (`test:truth`)

**T1: source_line_id uniqueness invariant**
Assert that the partial unique index `idx_movement_lines_source_identity` exists and rejects duplicate `(movement_id, source_line_id)` pairs.

**T2: source_line_id post-migration completeness**
After Phase 2 deployment, assert that all movement lines created after the migration timestamp have non-null `source_line_id`.

**T3: Ledger immutability includes source_line_id**
Assert that existing immutability triggers prevent UPDATE of `source_line_id` on posted movement lines.

### Contract Tier (`test:contracts`)

**C1: Structural matching — receipt posting**
Create a receipt with multiple lines. Rebuild. Assert each allocation resolves its movement line via `source_line_id` without note parsing.

**C2: Structural matching — QC events**
Create QC accept/hold events. Rebuild. Assert each allocation resolves the QC transfer inbound line via `source_line_id = 'qc_event:{id}:in'`.

**C3: Structural matching — batched putaway (duplicate shapes)**
Create a batched putaway where two lines have identical item, quantity, and destination location but different putaway line IDs. Rebuild. Assert each allocation resolves the correct movement line via `source_line_id = '{putawayLineId}:in'`.

**C4: Structural matching — reconciliation**
Create a reconciliation adjustment. Rebuild. Assert allocation resolves movement line via `source_line_id` without reason_code matching.

**C5: Fallback matching — pre-migration data**
Create movement lines without `source_line_id` (simulating historical data). Rebuild. Assert current heuristic matching still works and produces correct allocations.

**C6: Mixed population rebuild**
Create a receipt where some movement lines have `source_line_id` (post-migration) and some do not (pre-migration simulation). Rebuild. Assert correct resolution for both populations.

**C7: Rebuild determinism under reordering**
Run rebuild twice with different query orderings. Assert identical output when `source_line_id` is present.

### Edge Cases

**E1: Duplicate-shape lines in same movement**
Two positive lines with identical (item_id, location_id, quantity) but different `source_line_id`. Structural matching resolves each unambiguously. Heuristic matching (without source_line_id) would fail or be ambiguous.

**E2: Partial allocation consumption across workflows**
Receipt → QC (partial) → Putaway (partial). Rebuild correctly chains the allocations using structural identity at each step.

**E3: Reconciliation with positive and negative adjustments**
Both increase and decrease adjustments for the same receipt line. Each resolves to the correct movement line via `source_line_id`.

---

## Risk Assessment

### What Could Break

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Historical data has NULL `source_line_id` | Certain | None — fallback matching handles it | Heuristic fallback retained in Phase 3 |
| Unique index violation on deployment | Very low | Deployment blocked | Index is partial (NULL excluded); only applies to new data which hasn't been written yet |
| `sourceLineId` generation inconsistency across creation sites | Low | Wrong identity stored | All creation sites already generate `sourceLineId`; no new generation logic |
| Transfer reversal sourceLineId collision | Low | Index violation | Transfer reversals already generate distinct `sourceLineId` values |
| Migration interferes with ledger immutability | None | N/A | `ALTER TABLE ADD COLUMN` does not modify existing rows |
| Phase 3 structural matching fails for edge case | Low | Rebuild falls back to heuristic | Fallback is retained; structural match failure triggers fallback, not abort |

### What Is NOT at Risk

- **Existing behavior:** Zero changes until Phase 2 deploys. Phase 2 only adds a column value; no behavior changes. Phase 3 adds a faster matching path with fallback.
- **Ledger integrity:** No rows are updated or deleted. No immutability constraints are weakened.
- **Deterministic hashing:** `source_line_id` is orthogonal to `movement_deterministic_hash`. Hash computation is unchanged.
- **Write boundaries:** All writes still go through `createInventoryMovementLine()` in `ledgerWriter.ts`.
- **Cross-domain ownership:** No new cross-domain writes introduced.

---

## Verification Checklist

Before finalizing implementation:

- [ ] All identity paths are explicit (structural column, not metadata)
- [ ] Rebuild succeeds without heuristics for post-migration data
- [ ] All mappings are unambiguous (uniqueness index enforced)
- [ ] Solution is minimal (one column, one index, one INSERT change)
- [ ] Edge cases handled (duplicate shapes, partial allocations, mixed populations)
- [ ] No ledger table written outside `ledgerWriter.ts`
- [ ] No `withTransaction` boundary bypassed
- [ ] No existing behavior changed without fallback
- [ ] Deterministic hash computation unaffected
- [ ] Heuristic fallback retained for backward compatibility
