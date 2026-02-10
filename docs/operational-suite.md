# AK-47 Operational Test Suite

**AK-47** is the operational (“bring it all together”) suite. It exercises long, transactional flows that can fail silently in inventory systems—QC, ATP, reservations, negative stock, and ledger reconciliation.

## Purpose

- Catch cross-feature regressions early.
- Validate eventual consistency behavior.
- Verify warehouse defaults and role bins are respected in end-to-end flows.

## What it Includes

The AK-47 suite maps to `tests/ops/*.test.mjs` and includes:
- QC accept/hold flows
- ATP and backorder derivation
- Reservation lifecycle and reconciliation
- Receipts → QC → ledger posting
- Negative stock guardrails

## How to Run

```bash
npm run test:ops
# or
npm run test:ak47
```

For a full run:

```bash
npm run test:all
```

## Operational Principles

- Tests are warehouse-scoped and role-based.
- Standard warehouse template is the only supported bootstrap.
- Assertions check steady-state results, not transient states.

## Related Docs

- Warehouses: `docs/runbooks/warehouses.md`
- Debugging tests: `docs/runbooks/debugging_tests.md`
