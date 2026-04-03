# SKILL: inventory-ui-flow-guardrails

## PURPOSE
Keep inventory UI behavior aligned with domain truth so operators see the real state of stock, understand why actions are blocked, and cannot trigger misleading or invalid workflows.

## WHEN TO USE
- Use when a task changes any inventory-facing screen, action, label, status badge, table, modal, summary card, validation rule, or client-side state tied to inventory truth.
- Use when frontend work touches receiving, putaway, allocation, picking, transfer, shipping, adjustment, quarantine, counting, or discrepancy workflows.
- Use when UI text or API-to-UI mappings could change how operators interpret stock.

## INSTRUCTIONS
1. Read the relevant domain invariants and backend contract before changing the UI flow.
2. Identify the exact backend state each UI surface displays and the exact transition each action triggers.
3. Show current state, next allowed actions, and the blocking reason when an action is unavailable.
4. Use distinct labels for:
- on-hand
- available
- allocated
- quarantined
- in-transit
- expected inbound
- received
- accepted
- stored
- picked or staged
- shipped
5. Disable impossible actions instead of letting users submit and fail late.
6. Show partial completion explicitly for receipts, transfers, picks, shipments, and count workflows.
7. When an action changes quantity truth, surface confirmation context for:
- item
- quantity
- UOM
- source
- destination
- reason when exceptional
8. Keep API and UI enum or state names synchronized through a shared contract or an explicit mapping that is reviewed together.
9. Treat location, UOM, lot or serial, and reason code as visible decision inputs, not silent defaults.
10. Add or update UI tests that verify labels, action gating, blocking reasons, and partial-completion messaging.

## CONSTRAINTS
- Do not collapse multiple inventory truths into one generic quantity display.
- Do not present `on-hand` as `available`, `received` as `put away`, or `picked` as `shipped`.
- Do not imply certainty for expected, planned, or in-transit stock.
- Do not leave high-risk fields on hidden defaults for location, UOM, lot or serial, or adjustment reason.
- Do not add UI-only convenience shortcuts that bypass backend workflow states.
- Do not use this skill as a substitute for backend domain review, implementation planning, or broad test strategy.

## OUTPUT EXPECTATIONS
- Preserve exact operational meaning in labels, statuses, and action affordances.
- State why an action is blocked instead of failing silently or generically.
- Reflect partial success, discrepancy states, and investigation holds explicitly.
- Keep UI and backend state semantics aligned after the change.
- Add targeted UI tests where operator safety depends on gating or labeling.

## FAILURE MODES TO PREVENT
- One quantity badge hides several underlying states.
- Buttons stay enabled for blocked, quarantined, or unavailable stock.
- Receipt or transfer screens auto-post later workflow phases without verification.
- Partial success is hidden behind an all-or-nothing success message.
- UI and API state names drift and operators act on the wrong meaning.
- Silent defaults cause mis-posting to the wrong location, UOM, lot, serial, or reason.
- Users cannot see why stock is unavailable or under investigation.
