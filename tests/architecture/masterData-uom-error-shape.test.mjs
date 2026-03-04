import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  createPatchItemUomHandler,
  createUomConvertHandler
} = require('../../src/routes/masterData.uomHandlers.ts');

function createMockResponse() {
  const state = { status: 200, body: undefined };
  const res = {
    status(code) {
      state.status = code;
      return this;
    },
    json(payload) {
      state.body = payload;
      return this;
    }
  };
  return { res, state };
}

test('uom convert handler returns stable unknown-uom payload with suggestedCodes compatibility', async () => {
  const handler = createUomConvertHandler({
    enforceUomRegistry: true,
    assertUomActive: async (code) => {
      if (String(code).includes('unknown')) {
        const error = new Error(`Unknown UOM code: ${code}`);
        error.code = 'UOM_UNKNOWN';
        error.context = {
          inputUomCode: code,
          suggestions: ['ea', 'kg']
        };
        throw error;
      }
      return { code: 'g', dimension: 'mass', active: true };
    },
    convertQty: async () => {
      throw new Error('convert should not execute for unknown uom');
    },
    warn: () => undefined
  });

  const { res, state } = createMockResponse();
  await handler(
    {
      body: {
        qty: '1',
        fromUom: 'unknown_metric_unit',
        toUom: 'g',
        roundingContext: 'transfer'
      },
      auth: { tenantId: 'tenant-1' }
    },
    res
  );

  assert.equal(state.status, 400);
  assert.equal(state.body?.error?.code, 'UOM_UNKNOWN');
  assert.equal(typeof state.body?.error?.message, 'string');
  assert.deepEqual(state.body?.error?.context?.suggestions, ['ea', 'kg']);
  assert.deepEqual(state.body?.error?.context?.suggestedCodes, ['ea', 'kg']);
});

test('patch item uom handler returns stable dimension-mismatch payload shape', async () => {
  const handler = createPatchItemUomHandler({
    enforceUomRegistry: true,
    assertUomActive: async () => ({ code: 'kg', dimension: 'mass', active: true }),
    updateItemUomPolicy: async () => {
      throw new Error('update should not execute for mismatched dimension');
    }
  });

  const { res, state } = createMockResponse();
  await handler(
    {
      params: { id: '2c34b96f-b2cf-4a80-ad87-4fb7c18fca1c' },
      body: {
        uomDimension: 'count',
        stockingUom: 'kg',
        defaultUom: 'kg'
      },
      auth: { tenantId: 'tenant-1' }
    },
    res
  );

  assert.equal(state.status, 400);
  assert.equal(state.body?.error?.code, 'UOM_DIMENSION_MISMATCH');
  assert.equal(typeof state.body?.error?.message, 'string');
  assert.deepEqual(state.body?.error?.context, {
    stockingUom: 'kg',
    expectedDimension: 'count',
    actualDimension: 'mass'
  });
});
