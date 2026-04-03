# SKILL: inventory-domain-guardrails

## PURPOSE
Protect inventory truth before code or review work proceeds. This skill forces explicit inventory states, explicit quantity meanings, auditable movements, and reconcilable physical versus recorded stock.

## WHEN TO USE
- Use when a task changes inventory quantities, state transitions, movement rules, ledger behavior, reconciliation behavior, location assignment, UOM handling, lot or serial handling, or audit history.
- Use when a task adds or changes receiving, putaway, storage, allocation, picking, transfer, shipping, consumption, quarantine, counting, or adjustment workflows.
- Use when a task changes labels or API fields that operators may interpret as inventory truth.
- Use before approving, refactoring, or migrating inventory code if there is any chance the change could reinterpret existing stock.

## INSTRUCTIONS
1. Identify the inventory truths involved:
- which quantity meanings are in play: `on-hand`, `available`, `allocated`, `on-hold`, `in-transit`, `WIP`, `consumed`
- whether the task changes physical stock, recorded stock, or reconciliation between them
2. Map the workflow to explicit states. Use only explicit lifecycle states:
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
3. Check the transition path. Reject or redesign work that bypasses required phases such as receipt, acceptance, putaway, transfer receipt, count investigation, or adjustment justification.
4. Confirm every quantity-affecting mutation carries:
- item or SKU
- quantity
- UOM
- source state and location
- destination state and location
- actor or system source
- timestamp
- reason or transaction type
5. Require movement-style deltas rather than silent balance overwrites. If the task touches derived balances, verify the underlying movement trail remains authoritative and auditable.
6. Validate location integrity, SKU integrity, and deterministic UOM handling. If lot or serial tracking applies, require it to stay tied to the movement and location path.
7. Check whether negative inventory is possible. If it is allowed, require the task to make it explicit, exceptional, and auditable rather than a silent fallback.
8. Check multi-location truth separately from network rollups. Do not let total network stock stand in for pickable stock at a specific node.
9. Require discrepancy handling when record and physical truth can diverge:
- detect
- isolate
- investigate
- adjust or restore
10. Write down the invariants that must remain true after the change and the exact failure modes the task must avoid.

## CONSTRAINTS
- Do not collapse multiple quantity meanings into one field, one query, one badge, or one mutation path.
- Do not hide divergence between physical and recorded stock.
- Do not post stock movement without explicit source and destination state semantics.
- Do not accept missing, inferred, or incompatible UOM on quantity-bearing transactions.
- Do not bypass receiving, acceptance, putaway, transfer receipt, quarantine, or count investigation with convenience APIs or UI shortcuts.
- Do not allow direct writes to aggregate balances outside approved transaction or movement services.
- Do not allow unavailable, quarantined, expected, or in-transit stock to be treated as immediately consumable.
- Do not reuse an existing field for a new inventory meaning.

## OUTPUT EXPECTATIONS
- State the quantity meanings involved and keep them separate.
- State the lifecycle states and allowed transitions touched by the task.
- List the invariants at risk and whether the proposed change preserves them.
- Name any required audit, discrepancy, location, UOM, lot, serial, idempotency, or concurrency protections.
- If the task is unsafe, say which shortcut or ambiguity must be removed before proceeding.

## FAILURE MODES TO PREVENT
- One quantity field represents multiple truths.
- Receipts are posted before physical arrival or accepted before verification.
- Inventory moves between locations without immediately updating the location relationship.
- Transfers decrement origin stock without a durable linked destination receipt path.
- UI or API exposes `available` when stock is actually reserved, on hold, quarantined, or still in QC.
- Negative stock appears silently because of race conditions or fallback logic.
- UOM conversions drift across database, API, and UI.
- Backdated or retried transactions reorder history without preserving derived truth.
- Counts overwrite book quantity without preserving discrepancy history.
- Demand consumes stock that is in transit, quarantined, or otherwise unavailable.
- Multi-step workflows are collapsed into a single success state that hides partial completion.
