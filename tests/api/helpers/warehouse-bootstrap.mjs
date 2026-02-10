/**
 * Helper: standard warehouse bootstrap
 * Purpose: Create or fetch a Phase 6–correct warehouse graph via the standard template endpoint.
 * Preconditions: Valid API token; /locations/templates/standard-warehouse available.
 * Postconditions: Returns { warehouse, defaults, recv, locations } scoped to a single warehouse root.
 * Consumers: API and ops tests that need warehouse-scoped role bins and defaults.
 * Common failures: WAREHOUSE_TEMPLATE_FAILED on API error; duplicate role bins under root.
 */
import assert from 'node:assert/strict';
import { waitForCondition } from './waitFor.mjs';

const DEFAULT_BASE_URL = (process.env.API_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const templateReadyByTenant = new Set();
const templateInFlightByTenant = new Map();
const warehouseIdByTenant = new Map();
const canonicalByTenant = new Map();
const tenantByToken = new Map();
const recvCreateInFlightByTenant = new Map();
const inflightInitByTenant = new Map();

async function defaultApiRequest(method, path, { token, body, params, headers } = {}) {
  const url = new URL(DEFAULT_BASE_URL + path);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  const mergedHeaders = { 'Content-Type': 'application/json', ...(headers ?? {}) };
  if (token) mergedHeaders.Authorization = `Bearer ${token}`;
  const res = await fetch(url.toString(), {
    method,
    headers: mergedHeaders,
    body: body ? JSON.stringify(body) : undefined
  });
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : await res.text().catch(() => '');
  return { res, payload };
}

function isDescendant(location, warehouseId, byId) {
  let current = location;
  const visited = new Set();
  let depth = 0;
  while (current && current.parentLocationId) {
    if (visited.has(current.id)) return false;
    visited.add(current.id);
    if (current.parentLocationId === warehouseId) return true;
    current = byId.get(current.parentLocationId);
    depth += 1;
    if (depth > 50) return false;
  }
  return false;
}

async function listAllLocations(apiRequest, token) {
  const limit = 200;
  let offset = 0;
  const all = [];
  while (true) {
    const res = await apiRequest('GET', '/locations', { token, params: { limit, offset } });
    assert.equal(res.res.status, 200);
    const rows = res.payload?.data || [];
    all.push(...rows);
    if (rows.length < limit) break;
    offset += limit;
  }
  return all;
}

function pickWarehouseRoot(locations, created) {
  const createdWarehouse = created?.find((loc) => loc.type === 'warehouse');
  if (createdWarehouse) return createdWarehouse;
  const roots = locations.filter((loc) => loc.type === 'warehouse' && loc.parentLocationId == null);
  if (roots.length === 0) return null;
  roots.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return roots[0];
}

export async function ensureStandardWarehouse({
  token,
  includeReceivingQc = false,
  apiRequest = defaultApiRequest,
  scope = 'default',
  mode = 'init'
} = {}) {
  if (!token) {
    throw new Error('WAREHOUSE_TEMPLATE_FAILED missing token');
  }
  const tenantCacheKey = token;
  let tenantId = tenantByToken.get(tenantCacheKey);
  if (!tenantId) {
    const meRes = await apiRequest('GET', '/auth/me', { token });
    if (meRes.res.status !== 200) {
      throw new Error(`WAREHOUSE_TEMPLATE_FAILED status=${meRes.res.status} body=${JSON.stringify(meRes.payload)}`);
    }
    tenantId = meRes.payload?.tenantId || meRes.payload?.tenant?.id || meRes.payload?.user?.tenantId;
    if (!tenantId) {
      throw new Error('WAREHOUSE_TEMPLATE_FAILED tenantId missing');
    }
    tenantByToken.set(tenantCacheKey, tenantId);
  }

  const cacheKey = tenantId;

  if (mode === 'init') {
    if (warehouseIdByTenant.has(cacheKey) && canonicalByTenant.has(cacheKey)) {
      return ensureStandardWarehouse({
        token,
        includeReceivingQc,
        apiRequest,
        scope,
        mode: 'reuse'
      });
    }
    const inflight = inflightInitByTenant.get(cacheKey);
    if (inflight) {
      await inflight;
      return ensureStandardWarehouse({
        token,
        includeReceivingQc,
        apiRequest,
        scope,
        mode: 'reuse'
      });
    }
  }

  if (mode === 'reuse') {
    const cachedWarehouseId = warehouseIdByTenant.get(cacheKey);
    const cachedCanonicals = canonicalByTenant.get(cacheKey);
    if (!cachedWarehouseId || !cachedCanonicals) {
      throw new Error(
        `WAREHOUSE_TEMPLATE_REUSE_FAILED missing cache for tenant=${tenantId}`
      );
    }

    const locations = await listAllLocations(apiRequest, token);
    const warehouse = locations.find((loc) => loc.id === cachedWarehouseId);
    assert.ok(warehouse, `Warehouse required for reuse tenant=${tenantId}`);

    const byId = new Map(locations.map((loc) => [loc.id, loc]));
    const scoped = locations.filter(
      (loc) => loc.id === warehouse.id || isDescendant(loc, warehouse.id, byId)
    );

    const resolveCached = (id, role) => {
      const loc = scoped.find((row) => row.id === id);
      assert.ok(loc, `Cached ${role} location missing for tenant=${tenantId}`);
      return loc;
    };

    const defaults = {
      SELLABLE: resolveCached(cachedCanonicals.roles.SELLABLE, 'SELLABLE'),
      QA: resolveCached(cachedCanonicals.roles.QA, 'QA'),
      HOLD: resolveCached(cachedCanonicals.roles.HOLD, 'HOLD'),
      REJECT: resolveCached(cachedCanonicals.roles.REJECT, 'REJECT'),
      SCRAP: resolveCached(cachedCanonicals.roles.SCRAP, 'SCRAP')
    };

    const recv = includeReceivingQc && cachedCanonicals.recvId
      ? resolveCached(cachedCanonicals.recvId, 'RECV')
      : null;

    return {
      warehouse,
      defaults,
      recv,
      locations: scoped
    };
  }

  const initPromise = (async () => {
    if (!templateReadyByTenant.has(cacheKey)) {
      if (!templateInFlightByTenant.has(cacheKey)) {
        templateInFlightByTenant.set(
          cacheKey,
          (async () => {
            const templateRes = await apiRequest('POST', '/locations/templates/standard-warehouse', {
              token,
              body: { includeReceivingQc }
            });
            if (![200, 201].includes(templateRes.res.status)) {
              throw new Error(
                `WAREHOUSE_TEMPLATE_FAILED status=${templateRes.res.status} body=${JSON.stringify(templateRes.payload)}`
              );
            }
            const created = templateRes.payload?.created ?? [];
            const createdWarehouse = created.find((loc) => loc.type === 'warehouse');
            if (createdWarehouse?.id) {
              warehouseIdByTenant.set(cacheKey, createdWarehouse.id);
            }
            templateReadyByTenant.add(cacheKey);
          })()
        );
      }
      await templateInFlightByTenant.get(cacheKey);
      templateInFlightByTenant.delete(cacheKey);
    }

    const requiredRoles = ['SELLABLE', 'QA', 'HOLD', 'REJECT', 'SCRAP'];
    const snapshot = await waitForCondition(
      async () => {
        const locations = await listAllLocations(apiRequest, token);
        const hintedWarehouseId = warehouseIdByTenant.get(cacheKey);
        const roots = locations.filter((loc) => loc.type === 'warehouse' && loc.parentLocationId == null);
        let warehouse = hintedWarehouseId
          ? locations.find((loc) => loc.id === hintedWarehouseId)
          : null;
        if (!warehouse) {
          if (roots.length > 0) {
            roots.sort((a, b) => {
              const aTime = new Date(a.createdAt).getTime();
              const bTime = new Date(b.createdAt).getTime();
              if (aTime !== bTime) return aTime - bTime;
              return String(a.id).localeCompare(String(b.id));
            });
            warehouse = roots[0];
            warehouseIdByTenant.set(cacheKey, warehouse.id);
          }
        }
        if (!warehouse) {
          return { ok: false, reason: 'missing_root' };
        }

        const byId = new Map(locations.map((loc) => [loc.id, loc]));
        const scoped = locations.filter(
          (loc) => loc.id === warehouse.id || isDescendant(loc, warehouse.id, byId)
        );

        const rootChildren = scoped.filter((loc) => loc.parentLocationId === warehouse.id);

        const roleBuckets = rootChildren.reduce((acc, loc) => {
          if (!loc.role) return acc;
          acc[loc.role] = acc[loc.role] ? acc[loc.role].concat(loc) : [loc];
          return acc;
        }, {});

        const roleSummary = Object.fromEntries(
          requiredRoles.map((role) => [role, (roleBuckets[role] ?? []).length])
        );

        let recvBuckets = rootChildren.filter((loc) => !loc.role);

        if (includeReceivingQc && recvBuckets.length === 0) {
          if (!recvCreateInFlightByTenant.has(cacheKey)) {
            recvCreateInFlightByTenant.set(
              cacheKey,
              (async () => {
                const code = `RECV-${warehouse.id}`;
                const name = `Receiving ${warehouse.code || warehouse.id}`;
                const body = {
                  code,
                  name,
                  type: 'bin',
                  role: null,
                  isSellable: false,
                  parentLocationId: warehouse.id,
                  active: true
                };
                const createRes = await apiRequest('POST', '/locations', { token, body });
                if (![200, 201, 409].includes(createRes.res.status)) {
                  throw new Error(
                    `WAREHOUSE_TEMPLATE_RECV_FAILED status=${createRes.res.status} body=${JSON.stringify(createRes.payload)}`
                  );
                }
              })().finally(() => {
                recvCreateInFlightByTenant.delete(cacheKey);
              })
            );
          }
          await recvCreateInFlightByTenant.get(cacheKey);
          recvBuckets = rootChildren.filter((loc) => !loc.role);
        }

        const missingRoles = requiredRoles.filter((role) => (roleBuckets[role] ?? []).length < 1);
        const recvOk = includeReceivingQc ? recvBuckets.length >= 1 : true;

        const children = rootChildren.map((loc) => ({
          id: loc.id,
          code: loc.code,
          role: loc.role,
          type: loc.type
        }));

        return {
          ok: missingRoles.length === 0 && recvOk,
          warehouse,
          scoped,
          byId,
          roleSummary,
          recvCount: recvBuckets.length,
          children,
          includeReceivingQc
        };
      },
      (value) => Boolean(value?.ok),
      {
        label: `warehouse-template-converge tenant=${tenantId} scope=${scope}`,
        timeoutMs: 20000
      }
    );

    const { warehouse, scoped, byId, roleSummary } = snapshot;

    const findRole = (role) => {
      const cached = canonicalByTenant.get(cacheKey)?.roles?.[role];
      if (cached) {
        const cachedLoc = scoped.find((loc) => loc.id === cached);
        if (cachedLoc && cachedLoc.parentLocationId === warehouse.id) {
          return cachedLoc;
        }
      }
      const candidates = scoped.filter(
        (loc) => loc.role === role && loc.parentLocationId === warehouse.id
      );
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => {
        const aTime = new Date(a.createdAt).getTime();
        const bTime = new Date(b.createdAt).getTime();
        if (aTime !== bTime) return aTime - bTime;
        return String(a.id).localeCompare(String(b.id));
      });
      return candidates[0];
    };
    const findRecv = () => {
      const cached = canonicalByTenant.get(cacheKey)?.recvId;
      if (cached) {
        const cachedLoc = scoped.find((loc) => loc.id === cached);
        if (cachedLoc && cachedLoc.parentLocationId === warehouse.id) {
          return cachedLoc;
        }
      }
      const candidates = scoped.filter(
        (loc) => !loc.role && loc.parentLocationId === warehouse.id
      );
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => {
        const aTime = new Date(a.createdAt).getTime();
        const bTime = new Date(b.createdAt).getTime();
        if (aTime !== bTime) return aTime - bTime;
        return String(a.id).localeCompare(String(b.id));
      });
      return candidates[0];
    };

    const defaults = {
      SELLABLE: findRole('SELLABLE'),
      QA: findRole('QA'),
      HOLD: findRole('HOLD'),
      REJECT: findRole('REJECT'),
      SCRAP: findRole('SCRAP')
    };

    const recv = findRecv();

    canonicalByTenant.set(cacheKey, {
      warehouseId: warehouse.id,
      roles: Object.fromEntries(
        Object.entries(defaults).map(([role, loc]) => [role, loc?.id ?? null])
      ),
      recvId: recv?.id ?? null
    });

    for (const [role, loc] of Object.entries(defaults)) {
      assert.ok(loc, `Missing ${role} location under warehouse root`);
      assert.ok(
        loc.parentLocationId === warehouse.id || isDescendant(loc, warehouse.id, byId),
        `Location for ${role} not under warehouse root`
      );
    }

    if (recv) {
      assert.ok(
        recv.parentLocationId === warehouse.id || isDescendant(recv, warehouse.id, byId),
        'Receiving location not under warehouse root'
      );
    }

    return {
      warehouse,
      defaults,
      recv,
      locations: scoped
    };
  })();

  inflightInitByTenant.set(cacheKey, initPromise);
  try {
    return await initPromise;
  } finally {
    inflightInitByTenant.delete(cacheKey);
  }
}

export function assertLocationsScoped(locations, warehouseId, allLocations) {
  const byId = new Map(allLocations.map((loc) => [loc.id, loc]));
  for (const loc of locations) {
    if (loc.id === warehouseId) continue;
    assert.ok(
      loc.parentLocationId === warehouseId || isDescendant(loc, warehouseId, byId),
      `Location ${loc.id} not under warehouse root`
    );
  }
}
