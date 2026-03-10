# Siamaya Seed Pack (Factory)

## Real-Data Inputs

The default `siamaya_factory` run auto-detects and imports:
- Loyverse item CSV (`Siamaya items_cleaned.import.csv`)
- Odoo BOM workbook (`-Siamaya- 6. BOM (mrp.routing.workcenter)_old.xlsx`, sheet `3. bom`)
- Optional mapping reports:
  - `bom_output_item_mapping_report.csv`
  - `bom_unmatched_components_report.csv`

Unmapped BOM outputs/components are skipped and written to a deterministic review artifact:
- `scripts/seed/siamaya/seed_review_required.csv`

## Run Siamaya Seed

```bash
npm run seed -- --pack siamaya_factory
```

## Regenerate Full-Factory Simulation Assets

This refreshes the normalized BOM routing metadata, expanded opening inventory,
MRP explosion table, procurement metadata, demand/work-order scenarios, and
Graphviz factory diagrams in `scripts/seed/siamaya/`.

```bash
npm run seed:siamaya:generate-simulation
```

## Nuclear Dev Reset + Siamaya Seed (Local Only)

This is a destructive local/dev reset that drops all `public` schema data, reruns migrations, and seeds only the requested pack.

```bash
ALLOW_NUCLEAR_RESET=true npm run db:nuke-and-seed -- --pack siamaya_factory
```

Safety gates in the script:
- Requires `ALLOW_NUCLEAR_RESET=true`
- Refuses when `NODE_ENV=production`
- Prints redacted DB target (host/db/user) before reset
- Warns when hostname appears production-like
- Verifies post-seed that exactly one tenant exists and it is Siamaya, and that `jon.freed@gmail.com` exists

Optional explicit paths:

```bash
npm run seed -- --pack siamaya_factory \
  --items-csv "/mnt/data/Siamaya items_cleaned.import.csv" \
  --bom-file "/mnt/data/-Siamaya- 6. BOM (mrp.routing.workcenter)_old.xlsx" \
  --bom-output-mapping-report "/mnt/data/bom_output_item_mapping_report.csv" \
  --bom-unmatched-component-report "/mnt/data/bom_unmatched_components_report.csv" \
  --review-report "scripts/seed/siamaya/seed_review_required.csv"
```

Optional seed-only repair toggle (enabled by default) for opening-balance layers:

```bash
npm run seed -- --pack siamaya_factory --repair-opening-balance-layers=true
```

Repair guardrails:
- only targets `source_type='opening_balance'`
- only for the seed movement tied to `external_ref = seed:siamaya_factory:initial-stock:<tenant>:v<version>`
- fails loud if scoped layers were already consumed (no silent mutation of operational FIFO history)

Then run:

```bash
npm run test:financial-core
```

## Verify Key Counts (example SQL)

```sql
-- item classification
SELECT type, COUNT(*) FROM items i
JOIN tenants t ON t.id = i.tenant_id
WHERE t.slug = 'siamaya'
GROUP BY type
ORDER BY type;

-- BOM footprint
SELECT
  (SELECT COUNT(*) FROM boms b JOIN tenants t ON t.id=b.tenant_id WHERE t.slug='siamaya') AS boms,
  (SELECT COUNT(*) FROM bom_versions bv JOIN tenants t ON t.id=bv.tenant_id WHERE t.slug='siamaya') AS bom_versions,
  (SELECT COUNT(*) FROM bom_version_lines bl JOIN tenants t ON t.id=bl.tenant_id WHERE t.slug='siamaya') AS bom_lines;

-- initial stock movement + cost layers + lots
SELECT
  (SELECT COUNT(*) FROM inventory_movement_lines l JOIN inventory_movements m ON m.id=l.movement_id
    JOIN tenants t ON t.id=l.tenant_id
    WHERE t.slug='siamaya' AND m.external_ref LIKE 'seed:siamaya_factory:initial-stock:%') AS seed_lines,
  (SELECT COUNT(*) FROM inventory_cost_layers cl JOIN tenants t ON t.id=cl.tenant_id
    WHERE t.slug='siamaya' AND cl.source_type='opening_balance' AND cl.notes='Seeded opening stock') AS seed_cost_layers,
  (SELECT COUNT(*) FROM lots lo JOIN tenants t ON t.id=lo.tenant_id
    WHERE t.slug='siamaya') AS lots;
```

Expected topology targets for the default `siamaya_factory` pack:
- Warehouses: `4`
- Role + operational non-root locations: `17` (`3x4` role defaults + `5` factory operational bins)
- Initial stock movement/cost layers: dynamic from Loyverse `In stock [Factory]` rows with qty `> 0`
- Seeded lots for tracked raw items: `4` minimum when tracked items exist in opening stock

## Ledger vs Cost Layers Diagnostics

If inventory health reports a ledger-vs-layer variance, run:

```sql
-- A) ledger > 0 but layers = 0 (location view)
WITH ledger AS (
  SELECT tenant_id, item_id, location_id, uom, on_hand_qty
  FROM inventory_on_hand_location_v
),
layers AS (
  SELECT tenant_id, item_id, location_id, uom, SUM(remaining_quantity) AS layer_qty
  FROM inventory_cost_layers
  GROUP BY tenant_id, item_id, location_id, uom
)
SELECT i.sku, l.code AS location_code, ledger.uom,
       ledger.on_hand_qty AS ledger_qty,
       COALESCE(layers.layer_qty, 0) AS layer_qty,
       (ledger.on_hand_qty - COALESCE(layers.layer_qty,0)) AS variance
FROM ledger
JOIN items i ON i.id = ledger.item_id
JOIN locations l ON l.id = ledger.location_id
LEFT JOIN layers
  ON layers.tenant_id = ledger.tenant_id
 AND layers.item_id = ledger.item_id
 AND layers.location_id = ledger.location_id
 AND layers.uom = ledger.uom
WHERE ledger.on_hand_qty > 0
  AND COALESCE(layers.layer_qty,0) = 0
ORDER BY variance DESC
LIMIT 50;

-- B) offenders attributed by movement source_type
WITH offenders AS (
  SELECT oh.tenant_id, oh.item_id, oh.location_id, oh.uom
  FROM inventory_on_hand_location_v oh
  LEFT JOIN (
    SELECT tenant_id, item_id, location_id, uom, SUM(remaining_quantity) AS layer_qty
    FROM inventory_cost_layers
    GROUP BY tenant_id, item_id, location_id, uom
  ) cl
    ON cl.tenant_id = oh.tenant_id
   AND cl.item_id = oh.item_id
   AND cl.location_id = oh.location_id
   AND cl.uom = oh.uom
  WHERE oh.on_hand_qty > 0
    AND COALESCE(cl.layer_qty,0) = 0
)
SELECT m.source_type, COUNT(*) AS receipt_lines
FROM inventory_movement_lines ml
JOIN inventory_movements m ON m.id = ml.movement_id
JOIN offenders o
  ON o.tenant_id = m.tenant_id
 AND o.item_id = ml.item_id
 AND o.location_id = ml.location_id
 AND o.uom = ml.uom
WHERE ml.quantity_delta > 0
GROUP BY m.source_type
ORDER BY receipt_lines DESC;

-- C) UOM mismatch between on-hand view and layers
SELECT i.sku, oh.uom AS ledger_uom, cl.uom AS layer_uom,
       oh.on_hand_qty, SUM(cl.remaining_quantity) AS layer_qty
FROM inventory_on_hand_location_v oh
JOIN items i ON i.id = oh.item_id
JOIN inventory_cost_layers cl
  ON cl.tenant_id = oh.tenant_id
 AND cl.item_id = oh.item_id
 AND cl.location_id = oh.location_id
WHERE oh.on_hand_qty > 0
GROUP BY i.sku, oh.uom, cl.uom, oh.on_hand_qty
HAVING oh.uom <> cl.uom
ORDER BY oh.on_hand_qty DESC
LIMIT 50;
```

Inventory health uses canonical movement UOM (`canonical_uom`/`quantity_delta_canonical`) when comparing with cost layers.  
Expected healthy result after seed+repair: no positive ledger rows without matching remaining cost-layer quantity for opening balances.
