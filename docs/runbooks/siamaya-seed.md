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

Optional explicit paths:

```bash
npm run seed -- --pack siamaya_factory \
  --items-csv "/mnt/data/Siamaya items_cleaned.import.csv" \
  --bom-file "/mnt/data/-Siamaya- 6. BOM (mrp.routing.workcenter)_old.xlsx" \
  --bom-output-mapping-report "/mnt/data/bom_output_item_mapping_report.csv" \
  --bom-unmatched-component-report "/mnt/data/bom_unmatched_components_report.csv" \
  --review-report "scripts/seed/siamaya/seed_review_required.csv"
```

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
