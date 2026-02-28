# Siamaya Seed Pack (Factory)

## Regenerate Production BOM JSON

```bash
npm run seed:siamaya:bom:preprocess -- \
  --input "/path/to/3. bom-Table 1.csv" \
  --output scripts/seed/siamaya/siamaya-bom-production.json
```

Notes:
- Only Section 2 is imported.
- Wrapper lines with missing quantity default to `1 piece`.
- Byproduct rows are not inserted as BOM lines.

## Run Siamaya Seed

```bash
npm run seed -- --pack siamaya_factory
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
    WHERE t.slug='siamaya' AND cl.source_type='receipt' AND cl.notes='Seeded opening stock') AS seed_cost_layers,
  (SELECT COUNT(*) FROM lots lo JOIN tenants t ON t.id=lo.tenant_id
    WHERE t.slug='siamaya') AS lots;
```

Expected targets for the default `siamaya_factory` pack:
- Warehouses: `4`
- Role + operational non-root locations: `17` (`3x4` role defaults + `5` factory operational bins)
- Initial stock movement lines: `8`
- Initial stock receipt cost layers: `8`
- Seeded lots for tracked raw items: `4`
