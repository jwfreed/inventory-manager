import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  WAREHOUSE_DEFAULTS_EVENT,
  isWarehouseDefaultsEventPayload
} = require('../../src/observability/warehouseDefaults.events.ts');

test('warehouse default event names are stable constants and unique', () => {
  const values = Object.values(WAREHOUSE_DEFAULTS_EVENT);
  assert.equal(values.length, 5);
  assert.equal(new Set(values).size, values.length);
});

test('warehouse defaults service uses event constants (no free-typed event names)', async () => {
  const source = await readFile(path.resolve(process.cwd(), 'src/services/warehouseDefaults.service.ts'), 'utf8');
  const rawEventNames = [
    'WAREHOUSE_DEFAULT_REPAIRING',
    'WAREHOUSE_DEFAULT_REPAIRED',
    'WAREHOUSE_DEFAULT_ORPHAN_ROOTS_REPAIRING',
    'WAREHOUSE_DEFAULT_ORPHAN_ROOTS_REPAIRED',
    'WAREHOUSE_DEFAULT_ORPHAN_WAREHOUSE_ROOTS_DETECTED'
  ];

  for (const eventName of rawEventNames) {
    assert.equal(
      source.includes(`'${eventName}'`),
      false,
      `warehouseDefaults.service.ts must use WAREHOUSE_DEFAULTS_EVENT constants, found raw ${eventName}`
    );
  }
});

test('event payload guards enforce required keys', () => {
  const repairingPayload = {
    tenantId: 't1',
    warehouseId: 'w1',
    role: 'SELLABLE',
    defaultLocationId: 'l1',
    mappingId: null,
    reason: 'role_mismatch',
    expected: {
      role: 'SELLABLE',
      warehouse_id: 'w1',
      parent_location_id: 'w1',
      type: 'bin',
      is_sellable: true
    },
    actual: {
      role: 'QA',
      warehouse_id: 'w1',
      parent_location_id: 'w1',
      type: 'bin',
      is_sellable: false
    }
  };
  assert.equal(
    isWarehouseDefaultsEventPayload(WAREHOUSE_DEFAULTS_EVENT.DEFAULT_REPAIRING, repairingPayload),
    true
  );
  assert.equal(
    isWarehouseDefaultsEventPayload(WAREHOUSE_DEFAULTS_EVENT.DEFAULT_REPAIRING, {
      ...repairingPayload,
      expected: null
    }),
    false
  );

  const repairedPayload = {
    ...repairingPayload,
    repaired: {
      tenantId: 't1',
      warehouseId: 'w1',
      role: 'SELLABLE',
      locationId: 'l2',
      defaultLocationId: 'l2',
      mappingId: 'm1'
    }
  };
  assert.equal(
    isWarehouseDefaultsEventPayload(WAREHOUSE_DEFAULTS_EVENT.DEFAULT_REPAIRED, repairedPayload),
    true
  );
  assert.equal(
    isWarehouseDefaultsEventPayload(WAREHOUSE_DEFAULTS_EVENT.DEFAULT_REPAIRED, {
      ...repairingPayload,
      repaired: { tenantId: 't1' }
    }),
    false
  );

  const orphanSummaryPayload = {
    orphanCount: 3,
    tenantId: null,
    sampleWarehouseIds: ['w1'],
    sampleTenantIds: ['t1']
  };
  assert.equal(
    isWarehouseDefaultsEventPayload(WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_DETECTED, orphanSummaryPayload),
    true
  );

  const orphanRepairedPayload = {
    ...orphanSummaryPayload,
    createdWarehouseRootsCount: 1,
    createdWarehouseRootIds: ['w1'],
    reparentedCount: 0,
    relinkedWarehouseCount: 2,
    skippedRelinkLocalCodeConflictCount: 0,
    remainingCount: 0,
    remainingSampleWarehouseIds: [],
    remainingSampleTenantIds: []
  };
  assert.equal(
    isWarehouseDefaultsEventPayload(WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_REPAIRED, orphanRepairedPayload),
    true
  );
  assert.equal(
    isWarehouseDefaultsEventPayload(WAREHOUSE_DEFAULTS_EVENT.ORPHAN_ROOTS_REPAIRED, {
      ...orphanSummaryPayload,
      createdWarehouseRootsCount: 1
    }),
    false
  );
});
