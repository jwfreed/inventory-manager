# SKILL: inventory-domain-guardrails

## PURPOSE
Determine whether a task preserves inventory meaning, explicit state semantics, and audit-safe movement rules before implementation or approval proceeds.

## WHEN TO USE
- Use when a task changes quantity meaning, state transitions, movement semantics, reconciliation behavior, location truth, UOM handling, lot or serial handling, or audit exposure.
- Use when a task affects receiving, acceptance, putaway, storage, allocation, picking, transfer, shipping, consumption, quarantine, counting, or adjustment workflows.
- Use when API or UI labels could change how operators interpret inventory truth.

## INSTRUCTIONS
1. List the inventory truths involved and keep each quantity meaning separate.
2. Map the task to explicit lifecycle states and allowed transitions.
3. Check whether the task preserves physical versus recorded stock reconciliation.
4. Check whether each quantity-affecting movement remains explicit about item, quantity, UOM, source, destination, actor, timestamp, and reason.
5. Identify any shortcut that would collapse workflow phases, hide discrepancy handling, or treat unavailable stock as usable.
6. Record the safeguards required before the task may proceed.

## CONSTRAINTS
- Do not collapse `on-hand`, `available`, `allocated`, `on-hold`, `in-transit`, `WIP`, or `consumed`.
- Do not allow implicit states or skipped workflow phases.
- Do not allow direct balance overwrites; all quantity changes must be movement-based.
- Do not allow missing or inferred UOM, location, or audit reason on quantity-affecting behavior.
- Do not reinterpret historical stock meaning for convenience.
- Do not treat network-wide stock as equivalent to location-specific usable stock.
- Do not allow unavailable, quarantined, in-transit, or unaccepted stock to be treated as available.
- Do not bypass discrepancy workflows (detect -> isolate -> investigate -> adjust).
- Do not allow inventory state transitions without explicit intermediate states.

## OUTPUT EXPECTATIONS
- State the invariants at risk.
- State the exact states and transitions touched.
- State any detected domain violation or ambiguity.
- State the safeguards required before implementation or approval.

## FAILURE MODES TO PREVENT
- One quantity field represents multiple truths.
- Inventory is moved without explicit source or destination state semantics.
- Received, accepted, stored, staged, shipped, quarantined, and counted states are collapsed together.
- Physical and recorded stock divergence is hidden instead of investigated.
- Unavailable, quarantined, or in-transit stock is treated as immediately usable.
- Aggregate balances diverge from underlying movement history.
- Location-level stock is incorrect while global totals appear correct.
- Discrepancies are silently absorbed instead of investigated.
- Inventory becomes usable before validation or acceptance.
- Movement history cannot reconstruct current stock state.

## OUTPUT SCHEMA (REQUIRED)
- Invariants impacted:
- State transitions affected:
- Violations detected:
- Required safeguards:
- Files inspected:
- Evidence used:
- Unverified assumptions:

## EXECUTION RULE
Do not proceed until the OUTPUT SCHEMA is fully completed.
Incomplete outputs are invalid.
