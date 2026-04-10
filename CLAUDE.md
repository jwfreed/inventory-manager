# CLAUDE.md

> **Source of truth: `AGENTS.md`**
> This file is a thin execution overlay for Claude. It does not redefine invariants, architecture rules, or domain constraints. All of those live in `AGENTS.md`.

---

<role>

## Role

Claude operates as defined in `AGENTS.md § Role`. Claude's job is to make the smallest safe change that satisfies the stated requirement — nothing more.

</role>

---

<reasoning_style>

## Reasoning Style

### Correctness First
- A change that is correct and minimal is always preferred over one that is elegant but broad.
- Never sacrifice determinism, idempotency, or auditability for convenience.

### Minimal Scope
- Only touch what the task requires.
- Do not refactor adjacent code, rename symbols, or restructure files unless explicitly asked.
- Do not add error handling for impossible states or paths that are not reachable.

### No Overengineering
- Do not introduce abstractions for single-use cases.
- Do not add helpers, wrappers, or utilities that are not immediately needed.
- Do not add docstrings, comments, or type annotations to code that was not changed.

</reasoning_style>

---

<execution_behavior>

## Execution Behavior

### Before Acting
- Read the relevant files before making any change.
- Trace the actual call path from the route or command entry point to the ledger write.
- Identify what invariants the affected code upholds.

### Work Incrementally
- Complete one logical unit of change at a time.
- Do not batch unrelated changes into a single edit.
- Validate each step before proceeding.

### Track Changes
- Keep a clear mental model of what changed, what was preserved, and why.
- If a change has a risk of affecting auditability or correctness, state it explicitly before proceeding.

### Skills
- Before implementing any non-trivial task, follow the Skill Execution Contract in `AGENTS.md`.

</execution_behavior>

---

<constraints>

## Constraints

### No Hallucination
- Do not invent function signatures, table columns, type names, or behaviors that are not confirmed to exist in the codebase.
- If the existence of something is uncertain, read the file first.

### No Speculative Improvements
- Do not improve performance, naming, structure, or test coverage unless the task explicitly requires it.
- Do not add logging, metrics, or observability hooks unless asked.

### No Cross-Domain Refactors
- Do not move code between domains.
- Do not change interfaces shared across bounded contexts unless the task requires it and the impact is fully understood.

</constraints>

---

<output_expectations>

## Output Expectations

### Minimal Diffs
- Output only the lines that change.
- Do not reformat, reorder, or rewrite surrounding code.
- Do not change whitespace, import order, or style in lines that are not part of the change.

### No Unsolicited Commentary
- Do not explain the change unless asked.
- Do not summarize what was done unless asked.
- Do not suggest follow-up improvements unless asked.

### Test Coverage
- When tests are required, scope them to the changed behavior and its failure paths.
- Do not add tests for behaviors that already have coverage unless the existing tests are incorrect.
- Follow the Test Tier Policy in `AGENTS.md`.

</output_expectations>

---

<verification>

## Verification

Use the checklist in `AGENTS.md § Verification Checklist`. If any item fails, the task is not complete.

</verification>
