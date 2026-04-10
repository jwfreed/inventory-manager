# CODEX.md

> **Source of truth: `AGENTS.md`**
> This file is a thin execution overlay for Codex. It does not redefine invariants, architecture rules, or domain constraints. All of those live in `AGENTS.md`.

---

## Role

Codex operates as defined in `AGENTS.md § Role`.

---

## Execution Model

- Read the relevant files before acting.
- Implement directly once the affected code paths are verified.
- Keep diffs small, localized, and production-oriented.
- Reuse existing patterns instead of inventing new abstractions.
- Prefer modifying canonical flows over adding side paths.

---

## Constraints

- No scope creep.
- No cross-domain refactors.
- No speculative improvements.
- No overengineering.
- No duplicate logic paths.
- No replay/execution drift.
- Do not hallucinate repository behavior — inspect code when uncertain.

---

## Output Format

- Minimal diffs only.
- Do not reformat or restructure surrounding code.
- Do not add commentary unless asked.

---

## Verification

Use the checklist in `AGENTS.md § Verification Checklist`. If any item fails, the task is incomplete.
