# Inventory State Access Matrix

> Defines which operations are permitted on inventory in each state.
> Every cell is ALLOW, DENY, or CONDITIONAL with an explicit rule.

---

## Inventory States

The system defines seven explicit inventory states, enforced by CHECK constraint on `inventory_units.state`:

| State | Meaning | Location Context |
|-------|---------|-----------------|
| `received` | Arrived but not yet QC-evaluated | QA location |
| `qc_hold` | Placed on quality hold or rejected | Hold/reject location |
| `available` | Accepted and ready for demand | Sellable storage location |
| `allocated` | Committed against demand (reservation) | Storage location (logical hold) |
| `picked` | Staged for outbound shipment | Pick/staging location |
| `shipped` | Issued outbound; left the warehouse | N/A (terminal) |
| `adjusted` | Corrected by count/adjustment | Storage location (transient) |

### State Lifecycle

```
received ──→ qc_hold ──→ available ──→ allocated ──→ picked ──→ shipped
   │                        │                           │
   └──→ available           ├──→ shipped (direct)       │
                            ├──→ adjusted ──→ available  │
                            └──→ allocated ──→ available (release)
```

### Terminal States

- `shipped`: inventory has left the system; no further transitions
- Quantity reaches zero: unit becomes inert (record_quantity = 0)

---

## Access Matrix

### Legend

| Symbol | Meaning |
|--------|---------|
| **ALLOW** | Operation unconditionally permitted |
| **DENY** | Operation unconditionally forbidden |
| **COND** | Operation permitted only under stated condition |

---

### Matrix: State × Operation

| State | Transferable | Allocatable | Consumable (WO Issue) | Pickable | Countable | Adjustable | Shippable | Reversible | QC-Actionable |
|-------|-------------|------------|----------------------|----------|-----------|------------|-----------|------------|---------------|
| `received` | **COND** [1] | **DENY** | **DENY** | **DENY** | **DENY** | **DENY** | **DENY** | **COND** [7] | **ALLOW** |
| `qc_hold` | **COND** [2] | **DENY** | **DENY** | **DENY** | **DENY** | **DENY** | **DENY** | **COND** [7] | **ALLOW** |
| `available` | **ALLOW** | **ALLOW** | **ALLOW** | **COND** [4] | **ALLOW** | **ALLOW** | **ALLOW** | **COND** [7] | **DENY** |
| `allocated` | **DENY** | **DENY** | **DENY** | **ALLOW** | **DENY** | **DENY** | **DENY** | **COND** [8] | **DENY** |
| `picked` | **DENY** | **DENY** | **DENY** | **DENY** | **DENY** | **DENY** | **ALLOW** | **DENY** | **DENY** |
| `shipped` | **DENY** | **DENY** | **DENY** | **DENY** | **DENY** | **DENY** | **DENY** | **DENY** | **DENY** |
| `adjusted` | **COND** [3] | **COND** [5] | **COND** [6] | **DENY** | **ALLOW** | **ALLOW** | **DENY** | **COND** [7] | **DENY** |

---

## Conditional Rules

### [1] Transferable from `received`

- **ALLOW** only via QC action transfer (accept, hold, reject)
- QC accept: source must be QA location, destination must be sellable
- QC hold: source must be QA location, destination must be hold role
- QC reject: source must be QA location, destination must be reject role
- Manual transfer of `received` inventory: **DENY** — must go through QC workflow

### [2] Transferable from `qc_hold`

- **ALLOW** only via QC re-evaluation (second QC event)
- QC accept on held inventory: transfers from hold location to sellable location
- Destination constraints same as [1]
- Manual transfer of `qc_hold` inventory: **DENY**

### [3] Transferable from `adjusted`

- **ALLOW** — adjusted state is transient; inventory is considered available
- Standard transfer rules apply
- Adjusted → available transition implicit on next positive action

### [4] Pickable from `available`

- **ALLOW** only when a reservation/allocation exists for the demand line
- Pick task must reference an allocation
- Direct pick without allocation: **DENY** unless allocation created in same transaction

### [5] Allocatable from `adjusted`

- **ALLOW** — adjusted state does not block allocation
- System treats `adjusted` as available-equivalent for reservation purposes
- adjusted → allocated transition is valid

### [6] Consumable from `adjusted`

- **ALLOW** — adjusted state does not block WO issue
- System treats `adjusted` as available-equivalent for consumption
- adjusted → consumed via issue movement is valid

### [7] Reversible (general)

- **ALLOW** only if the originating movement has not been further consumed
- Receipt reversal: only if no putaways posted and cost layers unconsumed
- Transfer reversal: only if destination cost layers unconsumed
- Adjustment reversal: via correction adjustment (not movement reversal)
- Count reversal: not supported; correct via new count

### [8] Reversible from `allocated`

- **ALLOW** only via reservation cancellation (deallocate command)
- Direct movement reversal of allocation: **DENY**
- Reservation must be canceled first, releasing quantity back to available

---

## Cross-State Interaction Rules

### Rule: Allocation blocks transfer

Inventory in state `allocated` cannot be transferred. The reservation must be canceled first to release the inventory back to `available`, after which it becomes transferable.

### Rule: QC blocks allocation

Inventory in states `received` or `qc_hold` cannot be allocated. It must pass QC (accept) and transition to `available` before it can serve demand.

### Rule: Pick requires allocation

Inventory cannot be picked unless it is `allocated` or a reservation is created and allocated in the same transaction as the pick. The system does not support speculative picking.

### Rule: Ship requires pick or available

Shipment consumes inventory from `picked` (normal flow) or `available` (direct ship). It cannot ship from `received`, `qc_hold`, `allocated` (must be picked first), or `adjusted` states.

### Rule: Count reads physical truth

Cycle count can be performed on `available` and `adjusted` inventory. It cannot be performed on `received` (still in QC), `allocated` (committed), `picked` (staged), or `shipped` (gone). The count captures physical quantity; variance creates adjustment movement.

### Rule: WO issue consumes available

Work order issue can only consume `available` or `adjusted` (available-equivalent) inventory. It cannot consume `received`, `qc_hold`, `allocated`, `picked`, or `shipped` inventory.

### Rule: Shipped is terminal

No operation can be performed on shipped inventory. It has left the system. Returns create new inbound inventory; they do not reverse the shipped state.

### Rule: Adjusted is transient

The `adjusted` state exists to mark inventory that was corrected by count or adjustment. It behaves identically to `available` for all operations except that it records the correction provenance. The next state transition from `adjusted` is always to `available` (or consumption).

---

## State × Movement Type Mapping

| Movement Type | Source State(s) | Result State | Direction |
|---------------|----------------|--------------|-----------|
| `receive` | (none) | `received` or `available` | +quantity |
| `receive` (WO output) | (none) | `received` (QA) or `available` | +quantity |
| `receive` (return) | (none) | `received` | +quantity |
| `receive` (reversal) | `received`/`qc_hold`/`available` | (decrement) | -quantity |
| `transfer` (QC accept) | `received`/`qc_hold` | `available` | relocation |
| `transfer` (QC hold) | `received` | `qc_hold` | relocation |
| `transfer` (QC reject) | `received` | `qc_hold` | relocation |
| `transfer` (putaway) | `available` | `available` | relocation |
| `transfer` (manual) | `available`/`adjusted` | `available` | relocation |
| `issue` (shipment) | `available`/`picked` | `shipped` | -quantity |
| `issue` (WO issue) | `available` | (consumed) | -quantity |
| `issue` (WO void output) | `received` | (removed) | -quantity |
| `adjustment` | `available` | `adjusted`/`available` | ±quantity |
| `count` | `available` | `adjusted`/`available` | ±quantity |

---

## Balance Projection Mapping

The `inventory_balance` table tracks three quantity dimensions:

| Balance Field | What It Represents | Modified By |
|---------------|-------------------|-------------|
| `on_hand` | Physical quantity present | receive (+), issue (-), transfer (net 0), adjustment (±), count (±) |
| `reserved` | Soft-reserved against demand | reservation create (+), reservation cancel (-), fulfillment (-) |
| `allocated` | Firm-allocated to demand | allocate (+), deallocate (-), fulfillment (-) |

### Derived Quantities

| Quantity | Formula | Meaning |
|----------|---------|---------|
| Available | `on_hand - reserved - allocated` | Free to promise |
| ATP | `on_hand - reserved - allocated + planned_inbound - planned_outbound` | Forward-looking availability |

### Invariant

```
on_hand >= 0 (unless overrideNegative=true with reason)
reserved >= 0
allocated >= 0
available >= 0 (enforced at mutation time via ATP check)
```

---

## FIFO Consumption Order

When consuming inventory (issue, WO issue, shipment), units are consumed in FIFO order:

1. Filter: `state = 'available'` AND `record_quantity > 0`
2. Sort: `first_event_timestamp ASC`, then `id ASC` (deterministic tiebreak)
3. Consume in order until requested quantity exhausted
4. Partial consumption of a unit is allowed (record_quantity decremented)

**Violation:** Consuming out of FIFO order is forbidden. The `inventoryUnitAuthority.ts` enforces this ordering.
