import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const {
  buildMovementDeterministicHash
} = require('../../src/modules/platform/application/inventoryMovementDeterminism.ts');

function toIsoTimestamp(value = new Date()) {
  return new Date(value).toISOString();
}

function optionalValue(value, fallback) {
  return value === undefined ? fallback : value;
}

function normalizeFixtureLine(line, occurredAt) {
  const id = line.id ?? randomUUID();
  return {
    id,
    sourceLineId: optionalValue(line.sourceLineId, `syn:${id}`),
    itemId: line.itemId,
    locationId: line.locationId,
    quantityDelta: line.quantityDelta,
    uom: line.uom,
    quantityDeltaEntered: optionalValue(line.quantityDeltaEntered, line.quantityDelta),
    uomEntered: optionalValue(line.uomEntered, line.uom),
    quantityDeltaCanonical: optionalValue(line.quantityDeltaCanonical, line.quantityDelta),
    canonicalUom: optionalValue(line.canonicalUom, line.uom),
    uomDimension: optionalValue(line.uomDimension, null),
    unitCost: optionalValue(line.unitCost, null),
    extendedCost: optionalValue(line.extendedCost, null),
    reasonCode: optionalValue(line.reasonCode, null),
    lineNotes: optionalValue(line.lineNotes, null),
    createdAt: toIsoTimestamp(optionalValue(line.createdAt, occurredAt))
  };
}

export function buildMovementFixtureHash({
  tenantId,
  movementType,
  occurredAt,
  sourceType = null,
  sourceId = null,
  lines = []
}) {
  return buildMovementDeterministicHash({
    tenantId,
    movementType,
    occurredAt: toIsoTimestamp(occurredAt),
    sourceType,
    sourceId,
    lines: lines.map((line) => ({
      itemId: line.itemId,
      locationId: line.locationId,
      quantityDelta: line.quantityDelta,
      uom: line.uom,
      canonicalUom: line.canonicalUom ?? undefined,
      unitCost: line.unitCost ?? undefined,
      reasonCode: line.reasonCode ?? undefined
    }))
  });
}

export async function insertPostedMovementFixture(pool, params) {
  const movementId = params.id ?? randomUUID();
  const occurredAt = toIsoTimestamp(params.occurredAt);
  const postedAt = toIsoTimestamp(optionalValue(params.postedAt, occurredAt));
  const createdAt = toIsoTimestamp(optionalValue(params.createdAt, occurredAt));
  const lines = (params.lines ?? []).map((line) => normalizeFixtureLine(line, occurredAt));
  const movementDeterministicHash = Object.prototype.hasOwnProperty.call(params, 'movementDeterministicHash')
    ? params.movementDeterministicHash
    : buildMovementFixtureHash({
      tenantId: params.tenantId,
      movementType: params.movementType,
      occurredAt,
      sourceType: optionalValue(params.sourceType, null),
      sourceId: optionalValue(params.sourceId, null),
      lines
    });

  await pool.query(
    `INSERT INTO inventory_movements (
        id,
        tenant_id,
        movement_type,
        status,
        external_ref,
        source_type,
        source_id,
        idempotency_key,
        occurred_at,
        posted_at,
        notes,
        metadata,
        reversal_of_movement_id,
        reversed_by_movement_id,
        reversal_reason,
        movement_deterministic_hash,
        created_at,
        updated_at
     ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10, NULL, NULL, NULL, NULL, $11, $12, $12
     )`,
    [
      movementId,
      params.tenantId,
      params.movementType,
      optionalValue(params.status, 'posted'),
      optionalValue(params.externalRef, `fixture:${movementId}`),
      optionalValue(params.sourceType, null),
      optionalValue(params.sourceId, null),
      occurredAt,
      postedAt,
      optionalValue(params.notes, 'fixture'),
      movementDeterministicHash,
      createdAt
    ]
  );

  for (const line of lines) {
    await pool.query(
      `INSERT INTO inventory_movement_lines (
          id,
          tenant_id,
          movement_id,
          source_line_id,
          item_id,
          location_id,
          quantity_delta,
          uom,
          quantity_delta_entered,
          uom_entered,
          quantity_delta_canonical,
          canonical_uom,
          uom_dimension,
          unit_cost,
          extended_cost,
          reason_code,
          line_notes,
          created_at
       ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
       )`,
      [
        line.id,
        params.tenantId,
        movementId,
        line.sourceLineId,
        line.itemId,
        line.locationId,
        line.quantityDelta,
        line.uom,
        line.quantityDeltaEntered,
        line.uomEntered,
        line.quantityDeltaCanonical,
        line.canonicalUom,
        line.uomDimension,
        line.unitCost,
        line.extendedCost,
        line.reasonCode,
        line.lineNotes,
        line.createdAt
      ]
    );
  }

  return {
    movementId,
    movementDeterministicHash,
    lineIds: lines.map((line) => line.id)
  };
}
