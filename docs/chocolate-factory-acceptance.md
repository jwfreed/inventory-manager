# Chocolate Factory Acceptance (Step 1)

## Canonical rules
- Mass base unit: **g**. Accept entry in **kg / g / mg**, normalize to grams when writing inventory (to be enforced in later steps).
- “Record batch” must post **two movements atomically**: one `issue`, one `receive`.
- Packaging: after bars are produced, **foil is consumed** and a **wrapped bar** is stored; retail packs then consume wrapped bars and packaging. Pack size must be editable per batch (not always 12).

## Acceptance checklist
- [ ] Seed data installs without errors against a migrated DB and running API.
- [ ] Items and locations for the Durian line exist (raw → intermediate → finished + packaging).
- [ ] BOMs active for:
  - Cacao nibs (75% yield from beans).
  - Base นม 50% (Milk).
  - Unwrapped durian bar (mass + powder).
  - Wrapped bar (consumes foil).
  - Retail pack (default 12 bars; pack size can be changed by editing BOM or scaling WO quantity).
- [ ] Locations: RM, WIP (kitchen), PACK, FG.
- [ ] Seed produces no duplicate rows on re-run (idempotent by code/SKU).
- [ ] Seed aligns all mass quantities in grams (even if entered as kg).
- [ ] Documented run command and expected artifacts (IDs/skus/codes).

## How to run the seed
1) Ensure DB is migrated and API is running (`npm run dev`).
2) From repo root:
```bash
npm run dev:seed:chocolate
```
Env overrides:
- `API_BASE_URL` (default `http://localhost:3000`)
- `SEED_PREFIX` (default `CHOC`)
- `LOG_LEVEL` (`info` default)
- `TIMEOUT_MS` (default `15000`)

## Seeded artifacts (SKUs / codes)
- Items (examples): `CHOC-BEANS`, `CHOC-NIBS`, `CHOC-BASE`, `CHOC-BAR-BIG-RAW`, `CHOC-BAR-BIG-WRAP`, `CHOC-BAR-BIG-PACK`, `CHOC-FOIL`, `CHOC-BOX`, `CHOC-SHIP`, `CHOC-SUGAR`, `CHOC-BUTTER`, `CHOC-MILKPOW`, `CHOC-LECITHIN`, `CHOC-DURIAN`.
- Locations: `RM-STOCK`, `WIP-KITCHEN`, `PACK-STAGE`, `FG-STOCK`.
