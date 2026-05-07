# Power of Ten Inventory Standard

This standard adapts NASA's Power of Ten rules for a TypeScript, Node.js, and Postgres inventory system. It is not an embedded-C standard. Its purpose is to make inventory behavior deterministic, bounded, auditable, and statically checked without forcing a broad rewrite.

The inventory ledger, ATP locking, idempotency, replay determinism, and projection rebuild paths are high-risk areas. New work in those paths should satisfy this document before it is considered production-ready.

## Enforcement

- `npm run typecheck:core` enforces strict TypeScript on core source outside migrations.
- `npm run lint` runs a focused, warning-free ESLint gate on guard scripts and selected high-risk platform inventory modules.
- `npm run check:power10` runs repository-specific static guardrails in `scripts/check-power10-guards.mjs`.
- `npm run test:power10-guards` runs fixture tests for the Power10 scanner.
- `npm run check:quality` combines typecheck, lint, build, Power10 guard fixture tests, and Power10 guards.
- CI runs the quality gate, truth tests, and the push-only contracts suite. Heavy scenarios remain in the scheduled nightly workflow and are not CI-gated on pull requests.

## 1. Simple Control Flow

Interpretation: production inventory paths should be readable as explicit workflows. Avoid hidden exits, dynamic dispatch that obscures mutation behavior, and control flow that makes replay/execution parity hard to inspect.

Enforcement: TypeScript typecheck, focused ESLint, architecture tests, and review.

Allowed:

```ts
if (!movementLines.length) {
  throw new Error('MOVEMENT_REQUIRES_LINES');
}
return postMovement(command);
```

Disallowed:

```ts
handlerMap[action]?.(payload); // action mutates inventory but bypasses command review.
```

## 2. Bounded Loops

Interpretation: loops in production code must have an explicit upper bound, data-size bound, or a reviewed annotation. Retrying forever is not acceptable. Pagination must have a `limit` and progress condition.

Enforcement: `check:power10` flags `while (true)` unless it is a structurally bounded retry or has a local `power10: bounded-loop` annotation.

Allowed:

```ts
for (let batch = 0; batch < maxBatches; batch += 1) {
  const rows = await loadRows(limit);
  if (rows.length === 0) break;
}
```

Disallowed:

```ts
while (true) {
  await pollAndMutateInventory();
}
```

## 3. Bounded Memory

Interpretation: Node services must not accumulate unbounded rows, promises, request bodies, or batch work in production paths. Prefer limits, streaming, capped concurrency, and explicit request-size caps.

Enforcement: Express JSON body limits, DB query limits, `check:power10` scans for obvious unbounded batch patterns, and review for production source.

Allowed:

```ts
const limit = Math.min(requestedLimit, 500);
const rows = await listMovements({ limit, offset });
```

Disallowed:

```ts
const rows = await query('SELECT * FROM inventory_movements');
await Promise.all(rows.map(rebuildProjection));
```

## 4. Small Functions

Interpretation: inventory functions should expose one workflow decision or one persistence operation. Large orchestration is acceptable only when it preserves a single canonical path and is easier to audit than split alternatives.

Enforcement: review and future lint expansion. Do not split ledger execution and replay into parallel implementations just to reduce function size.

Allowed: small validation helpers, canonical planners, single-purpose persistence helpers.

Disallowed: a route handler that validates, locks, writes ledger rows, updates projections, and emits events without using the canonical command boundary.

## 5. Runtime Assertions

Interpretation: inventory invariants must fail closed at runtime. Assertions should protect states, UOM, quantities, idempotency ownership, and ledger line completeness.

Enforcement: truth tests, contract tests, database constraints, runtime validation, and review.

Allowed:

```ts
if (line.quantityDelta === 0) {
  throw new Error('MOVEMENT_LINE_ZERO_QUANTITY');
}
```

Disallowed:

```ts
const quantity = Number(input.quantity) || 0;
```

## 6. Minimized Scope

Interpretation: variables should be declared near use, transaction-scoped state should not escape the transaction callback, and mutable state should not be shared across inventory operations.

Enforcement: TypeScript, focused ESLint, and review.

Allowed: local transaction variables and immutable command objects.

Disallowed: module-level mutable state that affects quantity calculation, lock ordering, or movement identity.

## 7. Checked Results and Explicit Errors

Interpretation: database results, idempotency claims, lock acquisition, and external calls must be checked. Empty catches are forbidden unless locally justified.

Enforcement: `check:power10` flags suspicious empty `catch {}` blocks; ESLint disallows empty catch blocks in linted files.

Allowed:

```ts
if ((result.rowCount ?? 0) !== 1) {
  throw new Error('EXPECTED_SINGLE_ROW_UPDATE');
}
```

Disallowed:

```ts
try {
  await writeAuditEvent();
} catch {}
```

## 8. Limited Magic and Metaprogramming

Interpretation: avoid runtime code generation, dynamic table names, hidden decorators, and mutation-by-convention in inventory paths. SQL table ownership must be obvious to static scanners.

Enforcement: ESLint restrictions, Power10 direct-write scanning, and architecture guards.

Allowed: explicit SQL with parameterized values and canonical helper functions.

Disallowed:

```ts
await client.query(`UPDATE ${tableName} SET quantity = $1`, [quantity]);
```

## 9. Static Analysis

Interpretation: static checks must run in CI and be cheap enough for routine use. TypeScript must not be bypassed for production correctness paths.

Enforcement: `typecheck:core`, focused `lint`, `check:power10`, existing architecture tests, and CI quality gate.

Allowed: `ts-node --transpile-only` for local dev scripts when a separate typecheck gate covers production source.

Disallowed: adding a new production command path that only runs through `transpile-only` and is excluded from typecheck.

## 10. Zero Warnings

Interpretation: enforced quality commands must run warning-free. If a rule is too noisy today, scope it narrowly and document expansion instead of accepting warnings.

Enforcement: `npm run lint` uses `--max-warnings=0`; `check:power10` exits non-zero with actionable messages.

Allowed: a scoped lint gate that passes with zero warnings and expands over time.

Disallowed: CI commands that emit warnings but still pass as a normal operating mode.

## Exception Annotations

Exceptions must be local, specific, and reviewed. Do not add broad excludes.

- Bounded loop: `// power10: bounded-loop -- <why progress and termination are bounded>`
- Bounded batch: `// power10: bounded-batch -- <max rows/concurrency or caller guarantee>`
- Empty catch: `// power10: intentional-empty-catch -- <why no action is correct>`
- TypeScript ignore: `// @ts-ignore power10: ts-ignore -- <specific reason>`

Exception comments are not a substitute for inventory correctness. Ledger writes still must use `createInventoryMovement()` and `createInventoryMovementLine()`, mutations still must run inside the transaction boundary, ATP locks still must be acquired inside the transaction, and replay/execution must continue to share canonical logic.

## Deferred Items

- Full-repository ESLint is not yet a CI gate because existing code has many pre-existing `any`, unused variable, and narrow import-zone findings.
- `test:scenarios` remains nightly-only because it covers heavy operational and load workflows that are intentionally outside the pull request merge gate.
- Runtime scripts still use `ts-node --transpile-only` in several places. The production-grade direction is to keep a strict typecheck gate in CI first, then migrate operational scripts away from transpile-only where practical.
- Function-size enforcement remains review-based until the codebase can absorb a low-noise metric gate.
