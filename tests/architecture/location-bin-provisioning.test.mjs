import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  ensureLocationInventoryReady,
  assertLocationInventoryReady
} = require('../../src/domain/inventory/binProvisioning.ts');

function buildMockTx(handlers) {
  return {
    async query(sql, params) {
      for (const handler of handlers) {
        if (handler.when.test(sql)) {
          return handler.reply(sql, params);
        }
      }
      throw new Error(`UNEXPECTED_QUERY ${sql}`);
    }
  };
}

test('ensureLocationInventoryReady creates a default bin for an inventory-capable location with no bins', async () => {
  const inserts = [];
  const tx = buildMockTx([
    {
      when: /FROM locations/,
      reply: () => ({
        rowCount: 1,
        rows: [{
          warehouse_id: 'warehouse-1',
          parent_location_id: 'warehouse-1',
          code: 'SELLABLE-A',
          name: 'Sellable A',
          type: 'bin',
          role: 'SELLABLE',
          is_sellable: true
        }]
      })
    },
    {
      when: /FROM inventory_bins[\s\S]*ORDER BY[\s\S]*is_default DESC/,
      reply: (() => {
        let callCount = 0;
        return (_sql, params) => {
          callCount += 1;
          if (callCount === 1) {
            return { rowCount: 0, rows: [] };
          }
          return { rowCount: 1, rows: [{ id: params[2], is_default: true }] };
        };
      })()
    },
    {
      when: /INSERT INTO inventory_bins/,
      reply: (_sql, params) => {
        inserts.push(params);
        return { rowCount: 1, rows: [] };
      }
    }
  ]);

  const ensured = await ensureLocationInventoryReady('location-1', 'tenant-1', tx);

  assert.equal(inserts.length, 1);
  assert.equal(ensured.created, true);
  assert.equal(ensured.normalized, false);
  assert.equal(ensured.binId, ensured.defaultBinId);
  assert.match(String(inserts[0][4]), /-DEFAULT$/);
});

test('ensureLocationInventoryReady normalizes bins with no default to exactly one deterministic choice', async () => {
  const updates = [];
  const tx = buildMockTx([
    {
      when: /FROM locations/,
      reply: () => ({
        rowCount: 1,
        rows: [{
          warehouse_id: 'warehouse-1',
          parent_location_id: 'warehouse-1',
          code: 'QA-A',
          name: 'QA A',
          type: 'bin',
          role: 'QA',
          is_sellable: false
        }]
      })
    },
    {
      when: /FROM inventory_bins[\s\S]*ORDER BY[\s\S]*is_default DESC/,
      reply: () => ({
        rowCount: 2,
        rows: [
          { id: 'bin-1', is_default: false },
          { id: 'bin-2', is_default: false }
        ]
      })
    },
    {
      when: /UPDATE inventory_bins/,
      reply: (_sql, params) => {
        updates.push(params);
        return { rowCount: 1, rows: [] };
      }
    }
  ]);

  const ensured = await ensureLocationInventoryReady('location-1', 'tenant-1', tx);

  assert.equal(ensured.created, false);
  assert.equal(ensured.normalized, true);
  assert.equal(ensured.defaultBinId, 'bin-1');
  assert.equal(updates.length, 1);
  assert.equal(updates[0][2], 'bin-1');
});

test('assertLocationInventoryReady enforces at least one bin and exactly one default bin', async () => {
  const readyTx = buildMockTx([
    {
      when: /SELECT COUNT\(\*\)::text AS bin_count/,
      reply: () => ({
        rowCount: 1,
        rows: [{ bin_count: '2', default_count: '1', default_bin_id: 'bin-default' }]
      })
    }
  ]);
  const notReadyTx = buildMockTx([
    {
      when: /SELECT COUNT\(\*\)::text AS bin_count/,
      reply: () => ({
        rowCount: 1,
        rows: [{ bin_count: '2', default_count: '0', default_bin_id: null }]
      })
    }
  ]);

  const ready = await assertLocationInventoryReady('location-1', 'tenant-1', readyTx);
  assert.equal(ready.defaultBinId, 'bin-default');

  await assert.rejects(
    assertLocationInventoryReady('location-1', 'tenant-1', notReadyTx),
    /LOCATION_INVENTORY_NOT_READY/
  );
});

test('ensureLocationInventoryReady rejects warehouse roots and other non-inventory-capable locations', async () => {
  const tx = buildMockTx([
    {
      when: /FROM locations/,
      reply: () => ({
        rowCount: 1,
        rows: [{
          warehouse_id: 'warehouse-1',
          parent_location_id: null,
          code: 'WH-1',
          name: 'Warehouse 1',
          type: 'warehouse',
          role: null,
          is_sellable: false
        }]
      })
    }
  ]);

  await assert.rejects(
    ensureLocationInventoryReady('warehouse-1', 'tenant-1', tx),
    /LOCATION_BIN_PROVISIONING_LOCATION_NOT_INVENTORY_CAPABLE/
  );
});
