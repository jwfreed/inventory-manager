# Siamaya 1,000 Milk Chocolate Bar Demo

## Purpose

This demo seeds the minimum data required to walk through:

Purchase Order -> Receive ingredients -> QC release if required -> Produce 1,000 Milk Chocolate Bar 75g units -> Reserve for sales order -> Ship 1,000 bars.

It is intentionally narrow. It does not create broad sample catalogs, unrelated products, or opening inventory balances in manual mode.

## Reset, Migrate, Seed

From the repo root:

```bash
CONFIRM_DB_RESET=1 npm run db:reset
npm run migrate
npm run dev
```

In another terminal:

```bash
CONFIRM_CANONICAL_RESET=1 ALLOW_LOCAL_AUTH_REPAIR=1 npm run dev:seed:siamaya:manual
```

Required and useful environment variables:

- `DATABASE_URL`: local migrated database.
- `API_BASE_URL`: API URL, defaults to `http://localhost:3100`.
- `CONFIRM_CANONICAL_RESET=1`: allows the demo seed to truncate operational seed tables before seeding.
- `ALLOW_LOCAL_AUTH_REPAIR=1`: allows local-only tenant/admin repair for the demo login.
- `SEED_TENANT_SLUG`: defaults to `siamaya`.
- `SEED_ADMIN_EMAIL`: defaults to `jon.freed@gmail.com`.
- `SEED_ADMIN_PASSWORD`: defaults to `admin@local`.

The reset and auth repair guards remain blocked in production.

## Seeded Entities

- Finished good: `SIAMAYA-MILK-CHOCOLATE-BAR-75G`, `Milk Chocolate Bar 75g`, finished, manufactured, not purchasable.
- BOM: `SIAMAYA-BOM-MILK-CHOCOLATE-BAR-75G`, active, yield `1 each`.
- Components per bar:
  - `SIAMAYA-MILK-CHOC-CACAO-NIBS`: `30g`
  - `SIAMAYA-MILK-CHOC-SUGAR`: `20g`
  - `SIAMAYA-MILK-CHOC-MILK-POWDER`: `15g`
  - `SIAMAYA-MILK-CHOC-CACAO-BUTTER`: `9.5g`
  - `SIAMAYA-MILK-CHOC-LECITHIN`: `0.5g`
  - `SIAMAYA-MILK-CHOC-FOIL-WRAPPER`: `1 each`
- Supplier: `SIAMAYA-DEMO-INGREDIENT-SUPPLIER`.
- Customer: `SIAMAYA-DEMO-CUSTOMER`.
- Purchase order: `PO-MILK-CHOC-1000-INGREDIENTS`, with the exact component requirements for 1,000 bars.
- Sales order: `SO-MILK-CHOC-1000-BARS`, for `1,000 each` finished bars.

## Manual Walkthrough

1. Log in to tenant `siamaya` with the seeded admin account.
2. Open `PO-MILK-CHOC-1000-INGREDIENTS`.
3. Receive all PO lines for the exact ordered quantities.
4. If the receipt lands in QA, QC accept/release the received lines.
5. If the UI presents a putaway task, put the demo components into the operational location required by the current production workflow. In this build, the single-stage production route consumes from the warehouse sellable/raw-material location.
6. Create or execute a production work order for `1,000 each` of `SIAMAYA-MILK-CHOCOLATE-BAR-75G` using `SIAMAYA-BOM-MILK-CHOCOLATE-BAR-75G`.
7. Confirm finished goods are received into finished goods staging/sellable stock.
8. Reserve or allocate `1,000 each` to `SO-MILK-CHOC-1000-BARS`.
9. Create and post the shipment for `1,000 each`.

Manual mode stops before receiving, QC, production, reservation, and shipment. Those are the operator demo steps.

## Completed Mode

Completed mode runs the same focused data set end-to-end:

```bash
CONFIRM_CANONICAL_RESET=1 ALLOW_LOCAL_AUTH_REPAIR=1 npm run dev:seed:chocolate
```

or explicitly:

```bash
CHOCOLATE_SEED_MODE=completed CONFIRM_CANONICAL_RESET=1 ALLOW_LOCAL_AUTH_REPAIR=1 npm run dev:seed:chocolate
```

Completed mode creates/approves the component PO, receives and QC accepts the components, reports production for 1,000 bars, creates the SO, reserves the finished bars, and posts the shipment.

## Troubleshooting

- Reset refused: set `CONFIRM_CANONICAL_RESET=1`; production environments are still blocked.
- Login failed: for local demo only, set `ALLOW_LOCAL_AUTH_REPAIR=1`.
- API unavailable: start `npm run dev` and confirm `API_BASE_URL` matches the server port.
- Receipt blocked: confirm the PO is approved and the line UOM matches the PO line.
- Production blocked: confirm components were QC released into the workflow's sellable/raw-material consume location and no component is short.
