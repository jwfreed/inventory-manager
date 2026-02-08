import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestServer, stopTestServer } from './helpers/testServer.mjs';

test('bootstrap server', async () => {
  await ensureTestServer();
  assert.ok(true);
});

test.after(async () => {
  await stopTestServer();
});
