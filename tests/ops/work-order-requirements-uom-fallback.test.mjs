import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServiceHarness } from './helpers/service-harness.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { createBom } = require('../../src/services/boms.service.ts');

test('work order requirements reject legacy-only uom_conversions paths', { timeout: 120000 }, async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'wo-uom-fallback' });
  const { pool, tenantId, topology } = harness;

  const component = await harness.createItem({
    skuPrefix: 'COMP-PIECE',
    name: `Component Piece ${randomUUID().slice(0, 6)}`,
    type: 'packaging',
    defaultUom: 'legacy_piece',
    uomDimension: 'count',
    canonicalUom: 'each',
    stockingUom: 'each',
    defaultLocationId: topology.defaults.SELLABLE.id
  });

  const output = await harness.createItem({
    skuPrefix: 'FG-PIECE',
    name: `Finished Piece ${randomUUID().slice(0, 6)}`,
    type: 'finished',
    defaultUom: 'legacy_piece',
    uomDimension: 'count',
    canonicalUom: 'each',
    stockingUom: 'each',
    defaultLocationId: topology.defaults.QA.id
  });

  const overrideTableRes = await pool.query(
    `SELECT to_regclass(current_schema() || '.item_uom_overrides')::text AS table_name`
  );
  if (overrideTableRes.rows[0]?.table_name) {
    await pool.query(
      `DELETE FROM item_uom_overrides
        WHERE tenant_id = $1
          AND item_id = ANY($2::uuid[])`,
      [tenantId, [component.id, output.id]]
    );
  }

  for (const itemId of [component.id, output.id]) {
    await pool.query(
      `INSERT INTO uom_conversions (
          tenant_id,
          item_id,
          from_uom,
          to_uom,
          factor,
          created_at,
          updated_at
       ) VALUES
         ($1, $2, 'legacy_piece', 'each', 1, now(), now()),
         ($1, $2, 'each', 'legacy_piece', 1, now(), now())
       ON CONFLICT (tenant_id, item_id, from_uom, to_uom)
       DO UPDATE SET factor = EXCLUDED.factor, updated_at = EXCLUDED.updated_at`,
      [tenantId, itemId]
    );
  }

  await assert.rejects(
    () => createBom(tenantId, {
      bomCode: `BOM-PIECE-${randomUUID().slice(0, 6)}`,
      outputItemId: output.id,
      defaultUom: 'legacy_piece',
      version: {
        versionNumber: 1,
        yieldQuantity: 1,
        yieldUom: 'legacy_piece',
        components: [
          {
            lineNumber: 1,
            componentItemId: component.id,
            uom: 'legacy_piece',
            quantityPer: 1
          }
        ]
      }
    }),
    (error) => {
      const code = String(error?.code ?? '');
      const message = String(error?.message ?? '');
      return code === 'UOM_UNKNOWN' || message.includes('UOM_UNKNOWN');
    }
  );
});
