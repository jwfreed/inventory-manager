import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  acquireAtpLocks,
  buildAtpLockKeys,
  MAX_ATP_LOCK_TARGETS
} = require('../../src/domains/inventory/internal/atpLocks.ts');

function toUuidFromInt(seed) {
  const normalized = BigInt.asUintN(128, BigInt(seed));
  const hex = normalized.toString(16).padStart(32, '0');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join('-');
}

function createSeededRng(seed = 0x9e3779b9) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('ATP advisory key derivation snapshot stays stable for known tuples', () => {
  const snapshots = [
    {
      target: {
        tenantId: '00000000-0000-0000-0000-000000000001',
        warehouseId: '00000000-0000-0000-0000-000000000010',
        itemId: '00000000-0000-0000-0000-000000000100'
      },
      expected: { key1: 1283630161, key2: -534475107 }
    },
    {
      target: {
        tenantId: '11111111-1111-1111-1111-111111111111',
        warehouseId: '22222222-2222-2222-2222-222222222222',
        itemId: '33333333-3333-3333-3333-333333333333'
      },
      expected: { key1: 2092895250, key2: 520265234 }
    },
    {
      target: {
        tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        warehouseId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        itemId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      },
      expected: { key1: -251451367, key2: 289842928 }
    },
    {
      target: {
        tenantId: '123e4567-e89b-12d3-a456-426614174000',
        warehouseId: '123e4567-e89b-12d3-a456-426614174001',
        itemId: '123e4567-e89b-12d3-a456-426614174002'
      },
      expected: { key1: 433206931, key2: 1755800441 }
    }
  ];

  for (const snapshot of snapshots) {
    const key = buildAtpLockKeys([snapshot.target])[0];
    assert.ok(key, 'lock key expected');
    assert.equal(key.key1, snapshot.expected.key1);
    assert.equal(key.key2, snapshot.expected.key2);
  }
});

test('ATP advisory key-pair collision smoke test remains zero for deterministic sample', () => {
  // 100k keeps CI runtime bounded while still exercising a broad collision sample.
  const sampleSize = 100_000;
  const rng = createSeededRng(0x5eed1234);
  const seen = new Set();
  let collisions = 0;

  for (let i = 0; i < sampleSize; i += 1) {
    const tenantPart = Math.floor(rng() * 0xffffffff) ^ i;
    const warehousePart = Math.floor(rng() * 0xffffffff) ^ (i * 17);
    const itemPart = i * 7919 + 97;
    const [key] = buildAtpLockKeys([
      {
        tenantId: toUuidFromInt(tenantPart),
        warehouseId: toUuidFromInt(warehousePart),
        itemId: toUuidFromInt(itemPart)
      }
    ]);
    const pair = `${key.key1}:${key.key2}`;
    if (seen.has(pair)) {
      collisions += 1;
      continue;
    }
    seen.add(pair);
  }

  assert.equal(collisions, 0, `unexpected advisory key-pair collisions in ${sampleSize} sample`);
});

test('acquireAtpLocks fails loud before SQL when target count exceeds max', async () => {
  let queryCalled = false;
  const fakeClient = {
    query: async () => {
      queryCalled = true;
      return { rowCount: 0, rows: [] };
    }
  };
  const targets = Array.from({ length: MAX_ATP_LOCK_TARGETS + 1 }, (_, idx) => ({
    tenantId: '00000000-0000-0000-0000-000000000001',
    warehouseId: '00000000-0000-0000-0000-000000000010',
    itemId: toUuidFromInt(idx + 1)
  }));
  const lockContext = {
    operation: 'reserve',
    tenantId: '00000000-0000-0000-0000-000000000001',
    held: false,
    lockKeysCount: 0
  };

  let thrown = null;
  try {
    await acquireAtpLocks(fakeClient, targets, { lockContext });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown, 'expected ATP lock target count guard to throw');
  assert.equal(thrown.code, 'ATP_LOCK_TARGETS_TOO_MANY');
  assert.equal(thrown.details?.count, MAX_ATP_LOCK_TARGETS + 1);
  assert.equal(thrown.details?.max, MAX_ATP_LOCK_TARGETS);
  assert.equal(thrown.details?.operation, 'reserve');
  assert.equal(thrown.details?.tenantId, lockContext.tenantId);
  assert.equal(queryCalled, false, 'must reject before issuing SQL lock query');
});

test('acquireAtpLocks reports monotonic lockWaitMs for lock query duration', async () => {
  const queryDurations = [];
  const fakeClient = {
    query: async () => {
      const startedAt = process.hrtime.bigint();
      await new Promise((resolve) => setTimeout(resolve, 22));
      const elapsedNs = process.hrtime.bigint() - startedAt;
      queryDurations.push(Number(elapsedNs) / 1_000_000);
      return { rowCount: 1, rows: [] };
    }
  };

  const result = await acquireAtpLocks(fakeClient, [
    {
      tenantId: '00000000-0000-0000-0000-000000000001',
      warehouseId: '00000000-0000-0000-0000-000000000010',
      itemId: '00000000-0000-0000-0000-000000000100'
    }
  ]);

  assert.ok(result.lockKeys.length > 0);
  assert.ok(result.lockWaitMs > 0, `lockWaitMs should be positive; got ${result.lockWaitMs}`);
  assert.ok(result.lockWaitMs >= 15, `lockWaitMs too low for delayed query: ${result.lockWaitMs}`);
  assert.ok(result.lockWaitMs <= 2_000, `lockWaitMs unexpectedly high: ${result.lockWaitMs}`);
  assert.equal(queryDurations.length, 1);
});

test('buildAtpLockKeys fails loud when any target is invalid (no silent drop)', () => {
  let thrown = null;
  try {
    buildAtpLockKeys([
      {
        tenantId: '00000000-0000-0000-0000-000000000001',
        warehouseId: '00000000-0000-0000-0000-000000000010',
        itemId: '00000000-0000-0000-0000-000000000100'
      },
      {
        tenantId: '00000000-0000-0000-0000-000000000001',
        warehouseId: '',
        itemId: '00000000-0000-0000-0000-000000000101'
      }
    ]);
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown, 'expected invalid target to throw');
  assert.equal(thrown.code ?? thrown.message, 'INVALID_ATP_LOCK_TARGET');
  assert.equal(thrown.details?.invalidCount, 1);
  assert.equal(thrown.details?.totalCount, 2);
  assert.ok(Array.isArray(thrown.details?.samples), 'expected bounded invalid target samples');
  assert.ok(thrown.details.samples.length >= 1);
  assert.equal(thrown.details.samples[0].warehouseId, '__missing__');
});

test('ATP lock target ordering and dedupe are deterministic regardless of input order', () => {
  const baseTargets = [
    {
      tenantId: '00000000-0000-0000-0000-000000000001',
      warehouseId: '00000000-0000-0000-0000-000000000010',
      itemId: '00000000-0000-0000-0000-000000000100'
    },
    {
      tenantId: '00000000-0000-0000-0000-000000000001',
      warehouseId: '00000000-0000-0000-0000-000000000010',
      itemId: '00000000-0000-0000-0000-000000000101'
    },
    {
      tenantId: '00000000-0000-0000-0000-000000000001',
      warehouseId: '00000000-0000-0000-0000-000000000011',
      itemId: '00000000-0000-0000-0000-000000000099'
    }
  ];
  const withDuplicates = [
    baseTargets[1],
    baseTargets[2],
    baseTargets[0],
    baseTargets[1],
    baseTargets[0]
  ];
  const reversed = [...withDuplicates].reverse();

  const forwardKeys = buildAtpLockKeys(withDuplicates).map((entry) => ({
    tenantId: entry.tenantId,
    warehouseId: entry.warehouseId,
    itemId: entry.itemId,
    key1: entry.key1,
    key2: entry.key2
  }));
  const reversedKeys = buildAtpLockKeys(reversed).map((entry) => ({
    tenantId: entry.tenantId,
    warehouseId: entry.warehouseId,
    itemId: entry.itemId,
    key1: entry.key1,
    key2: entry.key2
  }));

  assert.equal(forwardKeys.length, 3, 'duplicate lock targets should be deduped');
  assert.deepEqual(forwardKeys, reversedKeys, 'lock key sequence must be stable across input order');
  assert.deepEqual(
    forwardKeys.map((entry) => `${entry.tenantId}:${entry.warehouseId}:${entry.itemId}`),
    [
      '00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000011:00000000-0000-0000-0000-000000000099',
      '00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000010:00000000-0000-0000-0000-000000000100',
      '00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000010:00000000-0000-0000-0000-000000000101'
    ]
  );
});
