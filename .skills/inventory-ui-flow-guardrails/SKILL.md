# SKILL: inventory-ui-flow-guardrails

## PURPOSE
Keep inventory UI flows aligned with backend truth so the interface does not misstate state, offer invalid actions, or hide operational exceptions.

## WHEN TO USE
- Use when a task changes inventory-facing screens, labels, status badges, action gating, confirmation flows, validation rules, or API-to-UI mappings.
- Use when frontend work touches receiving, putaway, allocation, picking, transfer, shipping, adjustment, quarantine, counting, or discrepancy workflows.
- Use when UI copy or state display could change operator interpretation of stock.

## INSTRUCTIONS
1. List the UI states involved.
2. List the invalid actions that the UI must prevent.
3. List the UI constraints required to preserve backend truth:
- explicit labels
- blocked-action messaging
- partial-completion visibility
- visible high-risk fields
- synchronized enum or state mapping
4. Record any mismatch between UI behavior and backend semantics.

## CONSTRAINTS
- Do not collapse multiple inventory truths into one quantity display.
- Do not imply that expected, received, picked, or in-transit stock is already in a later state.
- Do not use silent defaults for location, UOM, lot or serial, or adjustment reason.
- Do not use this skill to replace backend review, planning, or broad test strategy.
- Do not leave operator-facing ambiguity unresolved.
- UI must display distinct labels for:
  - on-hand
  - available
  - allocated
  - quarantined
  - in-transit
- UI must not imply completion for partially completed workflows.
- UI must show blocking reasons for disabled actions.
- UI must not allow submission of actions that backend will reject due to state constraints.

## OUTPUT EXPECTATIONS
- State the UI states and invalid actions clearly.
- State the constraints the UI must enforce.
- State any semantic mismatch that must be fixed before implementation is accepted.
- Keep the result focused on UI/domain alignment only.
- Explicitly state how UI prevents invalid actions.
- Explicitly state how partial completion is communicated.
- Explicitly state how state meaning is preserved in labels.

## FAILURE MODES TO PREVENT
- One badge hides multiple inventory states.
- Invalid actions remain enabled.
- Partial completion is shown as full success.
- UI and API state names drift apart.
- Hidden defaults cause mis-posting.
- UI guidance overlaps with planning, review, or backend test design.

## OUTPUT SCHEMA (REQUIRED)
- UI states involved:
- Invalid actions prevented:
- Required UI constraints:
- Mismatches detected:

## EXECUTION RULE
Do not proceed until the OUTPUT SCHEMA is fully completed.
Incomplete outputs are invalid.
