# inventory-manager

Inventory and operations system for warehouse, manufacturing, purchasing, quality, transfer, and fulfillment workflows. The system treats the inventory ledger as the source of truth and keeps operational states explicit so physical stock can be reconciled with recorded stock over time.

## Current Status

- Active development repository
- Backend and UI are both present in this repo
- Inventory correctness rules are established and treated as merge-blocking constraints
- Historical phase plans and implementation notes have been moved under `docs/decisions/` and `docs/audits/`

## Core Domain Rules

- Inventory truth must remain reconcilable between physical stock and recorded stock.
- Quantity meanings are distinct: `on-hand`, `available`, `allocated`, `on-hold`, `in-transit`, `WIP`, and `consumed`.
- Workflow states must stay explicit. Receiving, acceptance, putaway, storage, allocation, picking, transfer, shipping, counting, quarantine, and adjustment are separate operational steps.
- Quantity-affecting changes must remain auditable through append-only movement history.
- UI and documentation must not imply that blocked, partial, or unresolved stock is usable.

## Main Workflows

- Purchasing, receiving, QC, and putaway
- Inventory adjustments, counts, and ledger reconciliation
- Warehouse transfers and ATP checks
- Work orders, material issue, production reporting, and WIP handling
- Sales orders, reservations, shipments, and returns

## Tech Stack

- Node.js 20.19+
- TypeScript
- Express
- PostgreSQL
- React + Vite
- Playwright

## Quick Start

```bash
npm install
cp .env.example .env
```

Set `DATABASE_URL` in `.env`, then run:

```bash
npm run migrate
npm run dev
```

Useful checks:

```bash
npm run lint:inventory-writes
npm run test:truth
npm run test:contracts
npm run test:scenarios
```

## Local Demo Seed

With `DATABASE_URL` configured, migrations applied, and the API running, seed the chocolate demo data with:

```bash
npm run dev:seed:chocolate
```

The seed defaults to the local dev API at `http://localhost:3100`, is idempotent for the demo flow, and verifies a posted shipment for exactly 1,000 `Milk Chocolate Bar` units. It creates or reuses deterministic records including `PO-DEMO-1000-MILK-CHOCOLATE`, `SO-DEMO-1000-MILK-CHOCOLATE`, `Demo Customer`, and `SHIP-DEMO-1000-MILK-CHOCOLATE`.

For a local-only destructive operational reset before seeding:

```bash
CONFIRM_CANONICAL_RESET=1 npm run dev:seed:chocolate
```

## Project Structure

```text
src/        API, domain services, transaction boundaries, migrations
ui/         React application
tests/      Truth, contract, scenario, and supporting test suites
scripts/    Repo utilities, seeders, and verification scripts
docs/       Canonical docs, engineering runbooks, decisions, and audits
seeds/      Seed data assets
```

## Links To Docs

- Docs index: `docs/README.md`
- Domain invariants: `docs/inventory/domain-invariants.md`
- Architecture notes: `ARCHITECTURE.md` and `docs/architecture/`
- Engineering runbooks: `docs/engineering/runbooks/`
- Historical decisions and plans: `docs/decisions/archive/`
- Audit and implementation history: `docs/audits/`

## Development Rules

- Read `AGENTS.md` before non-trivial changes.
- Do not bypass `withTransaction(...)` / `withTransactionRetry(...)` for multi-step mutations.
- Do not write inventory ledger rows outside `src/domains/inventory/internal/ledgerWriter.ts`.
- Do not change schema or migrations casually. Schema changes must be intentional, reviewed, and covered by migration/testing updates.
- Keep changes small, explicit, and behavior-preserving unless the task says otherwise.
