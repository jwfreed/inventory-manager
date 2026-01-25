# Architecture Boundaries (Phase 0)

This document defines bounded contexts and write ownership rules.

## Bounded Contexts (Folders/Modules)
- Catalog: `src/domains/catalog`
- Inventory: `src/domains/inventory`
- Orders/Shipments: `src/domains/orders`
- Warehouse/Locations: `src/domains/warehouse`
- Costing: `src/domains/costing`
- Integrations: `src/domains/integrations`
- Auth: `src/domains/auth`
- Audit: `src/domains/audit`

## Write Ownership
Only the Inventory domain may write inventory ledger/balance tables.

| Table | Owner | Notes |
| --- | --- | --- |
| inventory_movements | Inventory | Write via `src/domains/inventory/internal/ledgerWriter.ts` |
| inventory_movement_lines | Inventory | Write via `src/domains/inventory/internal/ledgerWriter.ts` |
| inventory_balance | Inventory | Reserved for Phase 1 (single writer) |

## Enforcement
- Static guard: `scripts/check-inventory-writes.ts` scans for inventory table writes outside the Inventory writer.
- Lint guard: import boundary restriction for `src/domains/inventory/internal/*`.

## Policy Requirements
- Perpetual inventory: any outbound event that removes sellable availability must post an ISSUE movement.
- Idempotency: all inventory mutations must be idempotent and transactional.
- Integrations are unreliable: use timeouts, retries (backoff + jitter), circuit breakers, and bulkheads.
