import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  isTrustedHttpOrigin,
  resolveAllowedHttpOrigins,
  resolveCorsAllowedOrigin
} = require('../../src/config/httpOrigins.ts');

test('default local UI origin is allowed consistently for CORS and auth in development', () => {
  const allowedOrigins = resolveAllowedHttpOrigins({ env: { NODE_ENV: 'development' } });

  assert.equal(resolveCorsAllowedOrigin('http://localhost:5173', allowedOrigins), 'http://localhost:5173');
  assert.equal(resolveCorsAllowedOrigin('http://127.0.0.1:4173', allowedOrigins), 'http://127.0.0.1:4173');
  assert.equal(
    isTrustedHttpOrigin('http://localhost:5173', 'http://localhost:3100', allowedOrigins),
    true
  );
  assert.equal(
    isTrustedHttpOrigin('http://127.0.0.1:4173', 'http://127.0.0.1:3100', allowedOrigins),
    true
  );
});

test('production requires configured CORS origins and does not trust arbitrary browser origins', () => {
  const allowedOrigins = resolveAllowedHttpOrigins({ env: { NODE_ENV: 'production' } });

  assert.deepEqual(allowedOrigins, []);
  assert.equal(resolveCorsAllowedOrigin('https://example.test', allowedOrigins), null);
  assert.equal(
    isTrustedHttpOrigin('https://example.test', 'https://api.example.test', allowedOrigins),
    false
  );
});

test('configured CORS origins are shared by CORS and auth origin checks', () => {
  const allowedOrigins = resolveAllowedHttpOrigins({
    env: {
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://app.example.test, https://ops.example.test'
    }
  });

  assert.deepEqual(allowedOrigins, ['https://app.example.test', 'https://ops.example.test']);
  assert.equal(resolveCorsAllowedOrigin('https://ops.example.test', allowedOrigins), 'https://ops.example.test');
  assert.equal(
    isTrustedHttpOrigin('https://ops.example.test', 'https://api.example.test', allowedOrigins),
    true
  );
});
