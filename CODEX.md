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

## Skills

- Before implementing any non-trivial task, follow the Skill Execution Contract in `AGENTS.md`.
- Skill OUTPUT SCHEMAs required by `AGENTS.md` must be completed before implementation. They may be kept in the agent's working notes unless the user asks for them. Final responses should still report changed files, verification run, and unresolved risk when implementation is complete.

## Verification

Use the checklist in `AGENTS.md § Verification Checklist`. If any item fails, the task is incomplete.
