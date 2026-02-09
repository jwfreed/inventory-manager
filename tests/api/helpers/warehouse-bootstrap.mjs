import assert from 'node:assert/strict';

const DEFAULT_BASE_URL = (process.env.API_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const templateReadyByTenant = new Set();
const templateInFlightByTenant = new Map();
const warehouseIdByTenant = new Map();
const tenantByToken = new Map();

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
  includeReceivingQc = true,
  apiRequest = defaultApiRequest,
  scope = 'default'
} = {}) {
  if (!token) {
    throw new Error('WAREHOUSE_TEMPLATE_FAILED missing token');
  }
  const tenantCacheKey = `${token}::${scope}`;
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

  const cacheKey = `${tenantId}::${scope}`;

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

  const locations = await listAllLocations(apiRequest, token);
  const hintedWarehouseId = warehouseIdByTenant.get(cacheKey);
  const warehouse =
    locations.find((loc) => loc.id === hintedWarehouseId) || pickWarehouseRoot(locations, []);
  assert.ok(warehouse, 'Warehouse required');

  const byId = new Map(locations.map((loc) => [loc.id, loc]));
  const scoped = locations.filter(
    (loc) => loc.id === warehouse.id || isDescendant(loc, warehouse.id, byId)
  );

  const findRole = (role) =>
    scoped.find((loc) => loc.role === role && loc.parentLocationId === warehouse.id) || null;

  const roleCounts = scoped.reduce((acc, loc) => {
    if (loc.parentLocationId !== warehouse.id || !loc.role) return acc;
    acc[loc.role] = acc[loc.role] ? acc[loc.role].concat(loc) : [loc];
    return acc;
  }, {});

  for (const [role, locs] of Object.entries(roleCounts)) {
    if (locs.length > 1) {
      const ids = locs.map((loc) => loc.id);
      const codes = locs.map((loc) => loc.code);
      throw new Error(
        `WAREHOUSE_TEMPLATE_DUPLICATE_ROLE role=${role} warehouse=${warehouse.id} ids=${JSON.stringify(ids)} codes=${JSON.stringify(codes)}`
      );
    }
  }

  const defaults = {
    SELLABLE: findRole('SELLABLE'),
    QA: findRole('QA'),
    HOLD: findRole('HOLD'),
    REJECT: findRole('REJECT'),
    SCRAP: findRole('SCRAP')
  };

  const recv = scoped.find(
    (loc) => !loc.role && loc.parentLocationId === warehouse.id
  );

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

  const result = {
    warehouse,
    defaults,
    recv,
    locations: scoped
  };
  return result;
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
