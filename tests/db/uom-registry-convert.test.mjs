import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { query } = require('../../src/db.ts');
const {
  resolveUom,
  assertUomActive,
  listUoms,
  invalidateUomRegistryCache
} = require('../../src/services/uomRegistry.service.ts');
const { convertQty } = require('../../src/services/uomConvert.service.ts');

test('uom registry resolves canonical and alias codes', async () => {
  const canonical = await resolveUom('ea');
  assert.equal(canonical?.code, 'ea');
  assert.equal(canonical?.dimension, 'count');

  const alias = await resolveUom('  each  ');
  assert.equal(alias?.code, 'ea');
  assert.equal(alias?.dimension, 'count');

  const list = await listUoms();
  assert.ok(list.some((entry) => entry.code === 'ea'));
  assert.ok(list.some((entry) => entry.code === 'kg'));
});

test('assertUomActive rejects inactive registry entries', async () => {
  const code = `inactive_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await query(
    `INSERT INTO uoms (code, name, dimension, base_code, to_base_factor, precision, active, created_at, updated_at)
     VALUES ($1, $2, 'count', $1, 1, 6, false, now(), now())`,
    [code, `Inactive ${code}`]
  );
  invalidateUomRegistryCache();

  try {
    await assert.rejects(
      assertUomActive(code),
      (error) => String(error?.code ?? '') === 'UOM_INACTIVE'
    );
  } finally {
    await query('DELETE FROM uoms WHERE code = $1', [code]);
    invalidateUomRegistryCache();
  }
});

test('convertQty converts between canonical registry units', async () => {
  const kgToG = await convertQty({
    qty: '1',
    fromUom: 'kg',
    toUom: 'g',
    roundingContext: 'transfer',
  });
  assert.equal(kgToG.exactQty, '1000');
  assert.equal(kgToG.qty, '1000');

  const gToKg = await convertQty({
    qty: '1000',
    fromUom: 'g',
    toUom: 'kg',
    roundingContext: 'transfer',
  });
  assert.equal(gToKg.exactQty, '1');
  assert.equal(gToKg.qty, '1');

  const lbToG = await convertQty({
    qty: '1',
    fromUom: 'lb',
    toUom: 'g',
    roundingContext: 'transfer',
  });
  assert.equal(lbToG.exactQty, '453.59237');
  assert.equal(lbToG.qty, '453.59237');
});

test('convertQty enforces same-dimension conversions', async () => {
  await assert.rejects(
    convertQty({
      qty: '1',
      fromUom: 'kg',
      toUom: 'l',
      roundingContext: 'transfer',
    }),
    (error) => String(error?.code ?? '') === 'UOM_DIMENSION_MISMATCH'
  );
});

test('convertQty applies context-bound rounding and precision-min rule', async () => {
  const receipt = await convertQty({
    qty: '1555',
    fromUom: 'g',
    toUom: 'kg',
    roundingContext: 'receipt',
    contextPrecision: 2,
  });
  assert.equal(receipt.exactQty, '1.555');
  assert.equal(receipt.qty, '1.55');

  const issue = await convertQty({
    qty: '1555',
    fromUom: 'g',
    toUom: 'kg',
    roundingContext: 'issue',
    contextPrecision: 2,
  });
  assert.equal(issue.qty, '1.56');

  const count = await convertQty({
    qty: '1555',
    fromUom: 'g',
    toUom: 'kg',
    roundingContext: 'count',
    contextPrecision: 2,
  });
  assert.equal(count.qty, '1.56');

  const precisionMin = await convertQty({
    qty: '1234.56789',
    fromUom: 'g',
    toUom: 'kg',
    roundingContext: 'count',
    contextPrecision: 12,
  });
  assert.equal(precisionMin.qty, '1.234568');
});

test('convertQty rejects legacy uom_conversions without fallback', async () => {
  const anchor = await query(
    `SELECT tenant_id, id
       FROM items
      LIMIT 1`
  );
  assert.ok(anchor.rowCount > 0, 'expected at least one seeded item');
  const { tenant_id: tenantId, id: itemId } = anchor.rows[0];

  const fromUom = `legacy_from_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const toUom = `legacy_to_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const conversionId = randomUUID();

  await query(
    `INSERT INTO uom_conversions (id, tenant_id, item_id, from_uom, to_uom, factor, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 2.5, now(), now())`,
    [conversionId, tenantId, itemId, fromUom, toUom]
  );

  try {
    await assert.rejects(
      convertQty({
        qty: '4',
        fromUom,
        toUom,
        roundingContext: 'transfer',
        tenantId,
        itemId
      }),
      (error) => error.code === 'UOM_CONVERSION_MISSING' || error.code === 'UOM_UNKNOWN'
    );
  } finally {
    await query(`DELETE FROM uom_conversions WHERE id = $1`, [conversionId]);
  }
});

test('unknown uom returns actionable suggestion context', async () => {
  await assert.rejects(
    convertQty({
      qty: '1',
      fromUom: 'zzzz_unknown_unit',
      toUom: 'g',
      roundingContext: 'transfer'
    }),
    (error) => {
      assert.equal(error?.code, 'UOM_UNKNOWN');
      assert.ok(Array.isArray(error?.context?.suggestions));
      assert.ok(error.context.suggestions.length > 0);
      return true;
    }
  );
});
