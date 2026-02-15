import assert from 'node:assert/strict';
import { waitForCondition } from '../api/helpers/waitFor.mjs';

async function getLedgerOnHand({ db, tenantId, itemId, locationId, uom }) {
  const params = [tenantId, itemId, locationId];
  let uomClause = '';
  if (uom) {
    params.push(uom);
    uomClause = 'AND iml.uom = $4';
  }
  let res;
  const sql = `SELECT COALESCE(SUM(COALESCE(iml.quantity_delta_canonical, iml.quantity_delta)), 0) AS on_hand
       FROM inventory_movement_lines iml
       JOIN inventory_movements im
         ON im.id = iml.movement_id
        AND im.tenant_id = iml.tenant_id
      WHERE iml.tenant_id = $1
        AND iml.item_id = $2
        AND iml.location_id = $3
        AND im.status = 'posted'
        ${uomClause}`;
  try {
    res = await db.query(sql, params);
  } catch (err) {
    const message = err?.message || String(err);
    throw new Error(
      `expectSnapshotEventuallyMatchesLedger: ledger SUM query failed: ${message} sql=${sql} params=${JSON.stringify(
        params
      )}`
    );
  }
  return Number(res.rows[0]?.on_hand ?? 0);
}

export async function expectSnapshotEventuallyMatchesLedger({
  db,
  apiRequest,
  token,
  tenantId,
  itemId,
  locationId,
  uom,
  label
}) {
  assert.ok(db, 'db required');
  assert.ok(apiRequest, 'apiRequest required');
  assert.ok(token, 'token required');
  assert.ok(tenantId, 'tenantId required');
  assert.ok(itemId, 'itemId required');
  assert.ok(locationId, 'locationId required');

  const result = await waitForCondition(
    async () => {
      const ledgerOnHand = await getLedgerOnHand({ db, tenantId, itemId, locationId, uom });
      const snapshot = await apiRequest('GET', '/inventory-snapshot', {
        token,
        params: { itemId, locationId }
      });
      assert.equal(snapshot.res.status, 200);
      const snapshotOnHand = Number(snapshot.payload.data?.[0]?.onHand ?? 0);
      const ok = Math.abs(snapshotOnHand - ledgerOnHand) < 1e-6;
      return { ok, ledgerOnHand, snapshotOnHand };
    },
    (value) => Boolean(value?.ok),
    {
      label: label || `snapshot matches ledger item=${itemId} location=${locationId}`
    }
  );

  assert.ok(
    Math.abs(result.snapshotOnHand - result.ledgerOnHand) < 1e-6,
    `Snapshot/ledger mismatch: ledger=${result.ledgerOnHand} snapshot=${result.snapshotOnHand}`
  );
  return result;
}
