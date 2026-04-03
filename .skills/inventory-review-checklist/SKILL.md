# SKILL: inventory-review-checklist

## PURPOSE
Review inventory changes for correctness and silent-corruption risk before they are accepted. This skill focuses on whether the implementation is safe to merge, not on how to plan or test it.

## WHEN TO USE
- Use for PR review, code review, self-review, or acceptance review on any change that can affect inventory truth, workflow states, movement paths, projections, APIs, migrations, or UI actions.
- Use when reviewing quantity mutations, state transitions, retry behavior, or audit behavior.
- Use after implementation exists and before calling the work acceptable.

## INSTRUCTIONS
1. Start with the acceptance sequence:
1. What inventory problem is this solving?
2. Which states and transitions does it change?
3. What happens under duplicate submission?
4. What happens under partial failure?
5. What happens under stale reads or concurrent edits?
6. Can the result be audited later?
2. Verify the mutation path:
- source and destination state correctness
- location integrity
- UOM integrity
- lot or serial integrity where applicable
- reason capture for adjustments, write-offs, overrides, and unblock actions
3. Check for hidden balance mutation or direct aggregate overwrites.
4. Check whether unavailable stock can be consumed, transferred, shipped, or reported as available.
5. Check multi-location behavior explicitly instead of accepting single-node assumptions.
6. Compare UI behavior with backend truth:
- labels
- disabled actions
- validation rules
- partial completion visibility
7. Review reviewer notes or draft notes and name the exact failure modes discovered.
8. Reject the change if any required state is implicit, any workflow step is bypassed, or any audit trail becomes incomplete.

## CONSTRAINTS
- Do not approve based on clean code, naming, or coverage counts alone.
- Do not accept generic review comments that fail to name the specific inventory failure mode.
- Do not treat response-shape correctness as proof that side effects are safe.
- Do not skip duplicate, retry, stale-read, or partial-failure reasoning for quantity mutations.
- Do not broaden the review into unrelated architecture cleanup or new feature design.
- Do not rewrite the test plan here; focus on acceptability of the implemented behavior.

## OUTPUT EXPECTATIONS
- State whether the change is accepted, accepted with conditions, or rejected.
- Name the exact domain risk, regression risk, test adequacy concern, and operational edge case when relevant.
- Reference the states, transitions, or workflow steps that are unsafe or confirmed safe.
- Call out missing auditability, idempotency, concurrency handling, or location and UOM protections explicitly.
- Keep findings actionable and specific enough for the implementer to fix without guesswork.

## FAILURE MODES TO PREVENT
- Clean-looking code is approved even though it encodes wrong inventory logic.
- API shape is reviewed but transaction side effects are not.
- Duplicate submissions, retries, late receipts, partial transfers, or stale reads are ignored.
- UI screens are reviewed without checking actual backend states and blocked actions.
- Derived metrics start driving mutations without reviewer scrutiny.
- Historical inventory behavior changes without backward-compatibility review.
- Review comments say “edge case” without identifying the exact corruption path.
