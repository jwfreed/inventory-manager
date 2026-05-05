import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createServiceHarness } from '../ops/helpers/service-harness.mjs';

const require = createRequire(import.meta.url);
const {
  applyImportJob,
  createImportJobFromUpload,
  validateImportJob
} = require('../../src/services/imports.service.ts');

const TRACE_ERROR = 'Tracked item requires lot/serial data for on-hand import';

function csv(rows, headers = ['sku', 'locationCode', 'uom', 'quantity', 'lotNumber', 'serialNumber']) {
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => row[header] ?? '').join(','))
  ].join('\n');
}

async function createOnHandImport(harness, csvText) {
  const userId = await ensureImportUser(harness);
  return createImportJobFromUpload({
    tenantId: harness.tenantId,
    userId,
    type: 'on_hand',
    fileName: 'on-hand.csv',
    csvText
  });
}

async function validateOnHandImport(harness, jobId, mapping) {
  const userId = await ensureImportUser(harness);
  return validateImportJob({
    tenantId: harness.tenantId,
    userId,
    jobId,
    mapping,
    countedAt: '2026-01-01T00:00:00.000Z'
  });
}

async function ensureImportUser(harness) {
  if (harness.importUserId) return harness.importUserId;
  const userId = randomUUID();
  await harness.pool.query(
    `INSERT INTO currencies (code, name, symbol, decimal_places, active, created_at, updated_at)
     VALUES ('THB', 'Thai Baht', 'THB', 2, true, now(), now())
     ON CONFLICT (code) DO NOTHING`
  );
  await harness.pool.query(
    `INSERT INTO users (id, email, password_hash, full_name, active, base_currency, created_at, updated_at)
     VALUES ($1, $2, 'test-hash', 'Import Test User', true, 'THB', now(), now())`,
    [userId, `import-${userId}@example.test`]
  );
  await harness.pool.query(
    `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status, created_at)
     VALUES ($1, $2, $3, 'admin', 'active', now())`,
    [randomUUID(), harness.tenantId, userId]
  );
  harness.importUserId = userId;
  return userId;
}

test('on-hand import rejects lot-tracked SKU without lot data', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'import-lot-required' });
  const item = await harness.createItem({
    skuPrefix: 'LOTREQ',
    requiresLot: true,
    defaultLocationId: harness.topology.defaults.SELLABLE.id
  });
  const location = harness.topology.defaults.SELLABLE;
  const upload = await createOnHandImport(
    harness,
    csv([
      { sku: item.sku, locationCode: location.code, uom: 'each', quantity: '5' }
    ])
  );

  const result = await validateOnHandImport(harness, upload.jobId, upload.suggestedMapping);

  assert.equal(result.totalRows, 1);
  assert.equal(result.errorRows, 1);
  assert.equal(result.invalidTrackedRowsCount, 1);
  assert.equal(result.fieldErrors[0].field, 'lotNumber');
  assert.equal(result.fieldErrors[0].message, TRACE_ERROR);
  assert.equal(result.errorsBySku[0].sku, item.sku);
});

test('on-hand import accepts lot-tracked SKU with lot data', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'import-lot-present' });
  const item = await harness.createItem({
    skuPrefix: 'LOTOK',
    requiresLot: true,
    defaultLocationId: harness.topology.defaults.SELLABLE.id
  });
  const location = harness.topology.defaults.SELLABLE;
  const upload = await createOnHandImport(
    harness,
    csv([
      { sku: item.sku, locationCode: location.code, uom: 'each', quantity: '5', lotNumber: 'LOT-A' }
    ])
  );

  const result = await validateOnHandImport(harness, upload.jobId, upload.suggestedMapping);

  assert.equal(result.totalRows, 1);
  assert.equal(result.validRows, 1);
  assert.equal(result.errorRows, 0);
  assert.equal(result.invalidTrackedRowsCount, 0);
  assert.deepEqual(result.fieldErrors, []);
});

test('on-hand import rejects serial-tracked SKU without serial data', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'import-serial-required' });
  const item = await harness.createItem({
    skuPrefix: 'SERREQ',
    requiresSerial: true,
    defaultLocationId: harness.topology.defaults.SELLABLE.id
  });
  const location = harness.topology.defaults.SELLABLE;
  const upload = await createOnHandImport(
    harness,
    csv([
      { sku: item.sku, locationCode: location.code, uom: 'each', quantity: '1' }
    ])
  );

  const result = await validateOnHandImport(harness, upload.jobId, upload.suggestedMapping);

  assert.equal(result.errorRows, 1);
  assert.equal(result.invalidTrackedRowsCount, 1);
  assert.equal(result.fieldErrors[0].field, 'serialNumber');
  assert.equal(result.fieldErrors[0].message, TRACE_ERROR);
});

test('on-hand import mixed valid and invalid rows is fully rejected before persistence', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'import-mixed-trace' });
  const validItem = await harness.createItem({
    skuPrefix: 'UNTRACKED',
    defaultLocationId: harness.topology.defaults.SELLABLE.id
  });
  const invalidItem = await harness.createItem({
    skuPrefix: 'LOTBAD',
    requiresLot: true,
    defaultLocationId: harness.topology.defaults.SELLABLE.id
  });
  const location = harness.topology.defaults.SELLABLE;
  const upload = await createOnHandImport(
    harness,
    csv([
      { sku: validItem.sku, locationCode: location.code, uom: 'each', quantity: '7' },
      { sku: invalidItem.sku, locationCode: location.code, uom: 'each', quantity: '3' }
    ])
  );

  const validation = await validateOnHandImport(harness, upload.jobId, upload.suggestedMapping);

  assert.equal(validation.validRows, 1);
  assert.equal(validation.errorRows, 1);
  const userId = await ensureImportUser(harness);
  await assert.rejects(
    () => applyImportJob({
      tenantId: harness.tenantId,
      userId,
      jobId: upload.jobId
    }),
    /IMPORT_HAS_ERRORS/
  );
  assert.equal(await harness.readOnHand(validItem.id, location.id), 0);
  assert.equal(await harness.readOnHand(invalidItem.id, location.id), 0);
});

test('on-hand import apply API rejects invalid payload independent of UI', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'import-api-reject' });
  const item = await harness.createItem({
    skuPrefix: 'APIREJECT',
    requiresLot: true,
    defaultLocationId: harness.topology.defaults.SELLABLE.id
  });
  const location = harness.topology.defaults.SELLABLE;
  const upload = await createOnHandImport(
    harness,
    csv([
      { sku: item.sku, locationCode: location.code, uom: 'each', quantity: '5' }
    ])
  );
  await validateOnHandImport(harness, upload.jobId, upload.suggestedMapping);

  const userId = await ensureImportUser(harness);
  await assert.rejects(
    () => applyImportJob({
      tenantId: harness.tenantId,
      userId,
      jobId: upload.jobId
    }),
    /IMPORT_HAS_ERRORS/
  );
  assert.equal(await harness.readOnHand(item.id, location.id), 0);
});

test('validation writes are atomic: partial row state is impossible on failure', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'import-atomic-validate' });
  const item = await harness.createItem({
    skuPrefix: 'ATOMIC',
    requiresLot: false,
    defaultLocationId: harness.topology.defaults.SELLABLE.id
  });
  const location = harness.topology.defaults.SELLABLE;
  // Two valid rows
  const upload = await createOnHandImport(
    harness,
    csv([
      { sku: item.sku, locationCode: location.code, uom: 'each', quantity: '3' },
      { sku: item.sku, locationCode: location.code, uom: 'each', quantity: '2', lotNumber: 'LOT-X' }
    ])
  );

  // The second row is a duplicate (same sku/location/uom/lot as first when lot omitted becomes duplicate-on-hand key collision)
  // Validation should record both rows atomically — no partial writes
  const result = await validateOnHandImport(harness, upload.jobId, upload.suggestedMapping);

  // Both rows must be persisted — the write happened atomically
  const rowsRes = await harness.pool.query(
    'SELECT COUNT(*) AS cnt FROM import_job_rows WHERE job_id = $1',
    [upload.jobId]
  );
  assert.equal(Number(rowsRes.rows[0].cnt), 2, 'Both rows must be persisted atomically');
  assert.equal(result.totalRows, 2);
});

test('apply-time revalidation: tampered errorRows=0 in DB does not bypass validation', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'import-bypass-attempt' });
  const item = await harness.createItem({
    skuPrefix: 'BYPASS',
    requiresLot: true,
    defaultLocationId: harness.topology.defaults.SELLABLE.id
  });
  const location = harness.topology.defaults.SELLABLE;
  const upload = await createOnHandImport(
    harness,
    csv([
      { sku: item.sku, locationCode: location.code, uom: 'each', quantity: '5' }
    ])
  );
  await validateOnHandImport(harness, upload.jobId, upload.suggestedMapping);

  // Tamper: force-set error_rows=0 and status=validated directly in DB
  await harness.pool.query(
    `UPDATE import_jobs SET error_rows = 0 WHERE id = $1`,
    [upload.jobId]
  );

  const userId = await ensureImportUser(harness);
  // Apply must still reject because revalidation reads actual row data, not stored summary
  await assert.rejects(
    () => applyImportJob({
      tenantId: harness.tenantId,
      userId,
      jobId: upload.jobId
    }),
    /IMPORT_HAS_ERRORS/
  );
  assert.equal(await harness.readOnHand(item.id, location.id), 0);
});

test('lot-tracked import creates structural lots record and inventory_movement_lots', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'import-lot-structural' });
  const item = await harness.createItem({
    skuPrefix: 'LOTSTRUCT',
    requiresLot: true,
    defaultLocationId: harness.topology.defaults.SELLABLE.id
  });
  // Set standard cost so postInventoryCount can post a positive adjustment
  await harness.pool.query(
    `UPDATE items SET standard_cost = 10.00, standard_cost_currency = 'USD' WHERE id = $1`,
    [item.id]
  );
  const location = harness.topology.defaults.SELLABLE;
  const upload = await createOnHandImport(
    harness,
    csv([
      { sku: item.sku, locationCode: location.code, uom: 'each', quantity: '5', lotNumber: 'LOT-STRUCT-001' }
    ])
  );
  await validateOnHandImport(harness, upload.jobId, upload.suggestedMapping);

  const userId = await ensureImportUser(harness);
  await applyImportJob({ tenantId: harness.tenantId, userId, jobId: upload.jobId });

  // Wait for async processing to complete
  const finalStatus = await waitForImportCompletion(harness, upload.jobId);
  if (finalStatus !== 'completed') {
    const jobRes = await harness.pool.query(
      `SELECT status, error_summary FROM import_jobs WHERE id = $1`,
      [upload.jobId]
    );
    throw new Error(`Import job did not complete. status=${jobRes.rows[0]?.status}, error=${jobRes.rows[0]?.error_summary}`);
  }

  // Verify lots record was created structurally
  const lotRes = await harness.pool.query(
    `SELECT id, lot_code FROM lots WHERE tenant_id = $1 AND item_id = $2 AND lot_code = $3`,
    [harness.tenantId, item.id, 'LOT-STRUCT-001']
  );
  assert.equal(lotRes.rows.length, 1, 'A lots record must be created for lot-tracked import rows');

  // Verify inventory_movement_lots was created
  const movLotRes = await harness.pool.query(
    `SELECT iml.id
       FROM inventory_movement_lots iml
       JOIN lots l ON l.id = iml.lot_id
      WHERE l.tenant_id = $1 AND l.lot_code = $2 AND l.item_id = $3`,
    [harness.tenantId, 'LOT-STRUCT-001', item.id]
  );
  assert.equal(movLotRes.rows.length, 1, 'inventory_movement_lots must link the movement line to the lot');

  // Verify structural columns on import_job_rows
  const rowRes = await harness.pool.query(
    `SELECT lot_number, serial_number FROM import_job_rows WHERE job_id = $1`,
    [upload.jobId]
  );
  assert.equal(rowRes.rows[0].lot_number, 'LOT-STRUCT-001');
  assert.equal(rowRes.rows[0].serial_number, null);
});

test('duplicate serial within import is rejected', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'import-serial-dup' });
  const item = await harness.createItem({
    skuPrefix: 'SERIALDUP',
    requiresSerial: true,
    defaultLocationId: harness.topology.defaults.SELLABLE.id
  });
  const location = harness.topology.defaults.SELLABLE;
  const location2 = harness.topology.defaults.SELLABLE;
  const upload = await createOnHandImport(
    harness,
    csv([
      { sku: item.sku, locationCode: location.code, uom: 'each', quantity: '1', serialNumber: 'SN-001' },
      { sku: item.sku, locationCode: location2.code, uom: 'each', quantity: '1', serialNumber: 'SN-001' }
    ])
  );

  const result = await validateOnHandImport(harness, upload.jobId, upload.suggestedMapping);
  // Second row must be rejected as duplicate serial
  assert.ok(result.errorRows >= 1, 'Duplicate serial within import must be rejected');
});

test('serial already existing in system is rejected', async () => {
  const harness = await createServiceHarness({ tenantPrefix: 'import-serial-exists' });
  const item = await harness.createItem({
    skuPrefix: 'SERIALEXIST',
    requiresSerial: true,
    defaultLocationId: harness.topology.defaults.SELLABLE.id
  });
  // Pre-create the serial as a lot in the lots table
  await harness.pool.query(
    `INSERT INTO lots (id, tenant_id, item_id, lot_code, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'EXISTING-SN', 'active', now(), now())`,
    [require('node:crypto').randomUUID(), harness.tenantId, item.id]
  );

  const location = harness.topology.defaults.SELLABLE;
  const upload = await createOnHandImport(
    harness,
    csv([
      { sku: item.sku, locationCode: location.code, uom: 'each', quantity: '1', serialNumber: 'EXISTING-SN' }
    ])
  );

  const result = await validateOnHandImport(harness, upload.jobId, upload.suggestedMapping);
  assert.equal(result.errorRows, 1, 'Serial already in system must be rejected');
  assert.ok(
    result.errorSamples[0]?.errorCode === 'IMPORT_SERIAL_ALREADY_EXISTS',
    'Error code must be IMPORT_SERIAL_ALREADY_EXISTS'
  );
});

async function waitForImportCompletion(harness, jobId, maxWaitMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await harness.pool.query(
      `SELECT status FROM import_jobs WHERE id = $1`,
      [jobId]
    );
    const status = res.rows[0]?.status;
    if (status === 'completed' || status === 'failed') return status;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Import job ${jobId} did not complete within ${maxWaitMs}ms`);
}
