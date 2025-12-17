# Phase 1 — Canonical Inventory Vocabulary + Snapshot Endpoint (Backend-first, no UX/workflow changes)

You are a Codex engineering agent working in an existing monorepo:

- `src/` Express API + DB
- `ui/` Vite/React frontend

Mission: introduce a canonical, shared “inventory snapshot” domain model grounded in standard inventory concepts (on-hand, reserved, available, on-order, in-transit, backordered, inventory position). Do not change user workflows or existing endpoint behavior.

## Repo realities (do not guess)

- Canonical item key is `items.id` (UUID) referenced as `itemId` across backend and UI. `sku` exists for search/display but is not the primary key.
- Inventory is scoped by `locationId` (`locations.id`) and `uom` (existing inventory summary and reservations group by location + uom).

## Non-goals (hard constraints)

- No UI redesign; no changes to existing screens beyond wiring a new typed API client.
- No breaking changes to existing endpoints, payloads, or DB schema unless explicitly requested.
- Do not invent new business rules; reuse existing repo logic/sources wherever possible.

## Deliverables

### 1) Canonical model + contract

Define a stable `InventorySnapshotRow` contract (all quantities numeric; default `0` if unknown; never `null` unless an established pattern in this repo):

- `itemId` (UUID; `items.id`)
- `locationId` (UUID; `locations.id`)
- `uom` (string)
- `onHand` (ledger-derived)
- `reserved` (a.k.a. allocated; ensure shipped/closed/canceled are excluded; avoid double-counting)
- `available` (= `onHand - reserved`, do not clamp unless existing semantics already clamp)
- `onOrder` (open POs not fully received)
- `inTransit` (defensible proxy from existing data; ordered-not-received stays `onOrder`)
- `backordered` (only if reliably computable; otherwise `0` and document limitation)
- `inventoryPosition` (explicit formula; implemented consistently)

### Endpoint contract (no guessing)

- Route: `GET /inventory-snapshot`
- Query params:
  - `itemId` (required, UUID)
  - `locationId` (required, UUID)
  - `uom` (optional, string). If omitted, return rows for all UOMs found for that `itemId`+`locationId` across underlying sources.
- Response shape (always): `200 OK` returns `{ data: InventorySnapshotRow[] }`, sorted by `uom` asc.
- Errors:
  - `400` invalid query params
  - `404` if `itemId` not found or `locationId` not found (match `inventorySummary` route behavior)
- Phase 1 explicitly does not accept `sku` as an input to this endpoint (avoid ambiguity). If needed later, add a separate resolution endpoint or mutually-exclusive param support.

### 2) Backend implementation

Required repo touchpoints:

- Add service: `src/services/inventorySnapshot.service.ts`
- Add route: `src/routes/inventorySnapshot.routes.ts`
- Register route in `src/server.ts`
- Add zod schema(s): `src/schemas/inventorySnapshot.schema.ts`

Implementation constraints (reuse existing logic; do not rewrite):

- `onHand`: reuse ledger-derived logic in `src/services/inventorySummary.service.ts` (location + uom grouped).
- `reserved`: reuse reservation/allocation sources used by `src/routes/orderToCash.routes.ts` and related services; ensure you exclude shipped/closed/cancelled lines and do not double count.
- `onOrder`: derive from existing PO/receipt tables/statuses: “open PO qty not fully received”, scoped to `shipToLocationId`/location where applicable.
- `inTransit`: choose the best available repo proxy (e.g., received-not-putaway, transfer staging). Document what you chose and why.
- `backordered`: only compute if there is a first-class notion in this repo; otherwise return `0` and document.

Error handling:

- Validate query params with zod; return consistent 4xx on invalid input.
- Use existing Postgres error helpers (`src/lib/pgErrors.ts`) if applicable.

### 3) Frontend typing + API client wiring (no UI changes)

- Update `ui/src/api/types.ts` to include `InventorySnapshotRow` (or `InventorySnapshot` as `{ data: InventorySnapshotRow[] }`, consistent with existing client patterns).
- Add `ui/src/api/endpoints/inventorySnapshot.ts` to call `GET /inventory-snapshot` with `itemId`, `locationId`, optional `uom`.
- Do not change UI screens except what is required to compile and to make the client usable elsewhere.

### 4) Documentation

Create `docs/inventory-concepts.md` (short + operational) that:

- Defines each field in plain English
- States the exact `inventoryPosition` formula
- Clarifies “onHand vs available vs inventoryPosition”
- Lists approximations/limitations (especially `inTransit` and `backordered`)
- Includes a small glossary mapping API fields → user-facing meaning used in the app today (if different terminology exists)

### 5) Verification

- Add minimal unit tests if a test harness already exists (prefer service-level tests).
- If no tests exist, add a brief verification checklist (curl example + invariants like `available = onHand - reserved`).

## Acceptance criteria

- A consumer can call `GET /inventory-snapshot?itemId=...&locationId=...` and receive a stable, typed response.
- `docs/inventory-concepts.md` matches the response fields and formulas.
- No breaking changes to existing endpoints.
