# SKILL: inventory-review-checklist

## PURPOSE
Evaluate whether an implemented change is safe to merge without introducing inventory corruption risk.

## WHEN TO USE
- Use for self-review, PR review, or acceptance review after implementation exists.
- Use when reviewing quantity mutations, state transitions, retries, partial failures, concurrency handling, audit behavior, or UI/backend alignment.
- Use before calling inventory-related work complete or safe to merge.

## INSTRUCTIONS

Evaluate using this checklist:

- Problem clarity
- State transition correctness
- Duplicate/retry safety
- Partial failure behavior
- Concurrency safety
- Auditability
- UI/backend alignment

Reject if any item fails.

## CONSTRAINTS
- Do not redefine task scope or create a test plan in this skill.
- Do not approve based on code cleanliness, style, or coverage counts alone.
- Do not use generic review language that hides the exact failure mode.
- Do not accept implicit states, hidden balance mutation, or missing audit protection.

## OUTPUT EXPECTATIONS
- State the review decision.
- Name the domain risks and failure modes found.
- State the protections that are still missing.
- State the exact fixes required before merge if the change is not accepted.

## FAILURE MODES TO PREVENT
- Wrong inventory logic is approved because the review stayed superficial.
- Duplicate, retry, partial-failure, or concurrency hazards are missed.
- Audit gaps are ignored because the API shape looks correct.
- UI and backend state behavior diverge without blocking merge.
- Review output drifts into planning or test-design work instead of merge safety.

## REQUIRED INVENTORY CHECKS

- No hidden balance mutation
- No unavailable stock treated as usable
- No implicit state transitions
- No missing audit reason on quantity changes
- No UI/backend state mismatch

## OUTPUT SCHEMA (REQUIRED)
- Decision: (accept / accept with conditions / reject)
- Domain risks:
- Failure modes identified:
- Missing protections:
- Required fixes:

## EXECUTION RULE
Do not proceed until the OUTPUT SCHEMA is fully completed.
Incomplete outputs are invalid.
