import type { PoolClient } from 'pg';
import { buildMovementDeterministicHash, sortDeterministicMovementLines } from '../modules/platform/application/inventoryMutationSupport';
import type { PersistInventoryMovementInput, PersistInventoryMovementLineInput } from '../domains/inventory';
import type { PreparedTransferMutation } from './transfers.service';
import { getCanonicalMovementFields, type CanonicalMovementFields } from './uomCanonical.service';

type RawMovementLineDescriptor = Readonly<{
  sourceLineId: string;
  warehouseId: string;
  itemId: string;
  locationId: string;
  quantity: number;
  uom: string;
  defaultReasonCode: string;
  explicitReasonCode?: string | null;
  lineNotes?: string | null;
  unitCost?: number | null;
  extendedCost?: number | null;
}>;

type PlannedWorkOrderMovementLine = Readonly<{
  sourceLineId: string;
  warehouseId: string;
  itemId: string;
  locationId: string;
  canonicalFields: Readonly<CanonicalMovementFields>;
  reasonCode: string;
  lineNotes: string | null;
  unitCost?: number | null;
  extendedCost?: number | null;
}>;

type PlannedMovementHeader = Readonly<{
  id: string;
  tenantId: string;
  movementType: string;
  status: 'posted';
  externalRef: string;
  sourceType: string;
  sourceId: string;
  idempotencyKey?: string | null;
  occurredAt: Date | string;
  postedAt: Date | string;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  lotId?: string | null;
  productionBatchId?: string | null;
}>;

export type PlannedWorkOrderMovement = Readonly<{
  sortedLines: ReadonlyArray<PlannedWorkOrderMovementLine>;
  persistInput: Readonly<PersistInventoryMovementInput>;
  expectedLineCount: number;
  expectedDeterministicHash: string;
}>;

export type PlannedBatchMovement = Readonly<{
  issue: PlannedWorkOrderMovement;
  completion: PlannedWorkOrderMovement;
}>;

export type PlannedVoidMovement = Readonly<{
  output: PlannedWorkOrderMovement;
  components: PlannedWorkOrderMovement;
}>;

function resolveReasonCode(line: RawMovementLineDescriptor) {
  const explicitReasonCode = line.explicitReasonCode?.trim();
  return explicitReasonCode && explicitReasonCode.length > 0
    ? explicitReasonCode
    : line.defaultReasonCode;
}

async function canonicalizeMovementLines(
  tenantId: string,
  lines: ReadonlyArray<RawMovementLineDescriptor>,
  client: PoolClient
): Promise<ReadonlyArray<PlannedWorkOrderMovementLine>> {
  const canonicalized = await Promise.all(lines.map(async (line) => ({
    sourceLineId: line.sourceLineId,
    warehouseId: line.warehouseId,
    itemId: line.itemId,
    locationId: line.locationId,
    canonicalFields: Object.freeze(
      await getCanonicalMovementFields(tenantId, line.itemId, line.quantity, line.uom, client)
    ),
    reasonCode: resolveReasonCode(line),
    lineNotes: line.lineNotes ?? null,
    unitCost: line.unitCost ?? null,
    extendedCost: line.extendedCost ?? null
  })));

  return sortDeterministicMovementLines(canonicalized, (line) => ({
    tenantId,
    warehouseId: line.warehouseId,
    locationId: line.locationId,
    itemId: line.itemId,
    canonicalUom: line.canonicalFields.canonicalUom,
    sourceLineId: line.sourceLineId
  }));
}

export async function planMovementLines(params: {
  tenantId: string;
  lines: ReadonlyArray<RawMovementLineDescriptor>;
  client: PoolClient;
}): Promise<ReadonlyArray<PlannedWorkOrderMovementLine>> {
  return deepFreeze(
    await canonicalizeMovementLines(
      params.tenantId,
      params.lines,
      params.client
    )
  );
}

function mapPersistMovementLine(
  line: PlannedWorkOrderMovementLine,
  eventTimestamp: Date | string
): PersistInventoryMovementLineInput {
  return {
    warehouseId: line.warehouseId,
    sourceLineId: line.sourceLineId,
    eventTimestamp,
    itemId: line.itemId,
    locationId: line.locationId,
    quantityDelta: line.canonicalFields.quantityDeltaCanonical,
    uom: line.canonicalFields.canonicalUom,
    quantityDeltaEntered: line.canonicalFields.quantityDeltaEntered,
    uomEntered: line.canonicalFields.uomEntered,
    quantityDeltaCanonical: line.canonicalFields.quantityDeltaCanonical,
    canonicalUom: line.canonicalFields.canonicalUom,
    uomDimension: line.canonicalFields.uomDimension,
    unitCost: line.unitCost ?? null,
    extendedCost: line.extendedCost ?? null,
    reasonCode: line.reasonCode,
    lineNotes: line.lineNotes,
    createdAt: undefined
  };
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

export function buildPlannedMovementFromLines(params: {
  header: PlannedMovementHeader;
  lines: ReadonlyArray<PlannedWorkOrderMovementLine>;
}): PlannedWorkOrderMovement {
  const sortedLines = deepFreeze([...params.lines]);
  const expectedDeterministicHash = buildMovementDeterministicHash({
    tenantId: params.header.tenantId,
    movementType: params.header.movementType,
    occurredAt: params.header.occurredAt,
    sourceType: params.header.sourceType,
    sourceId: params.header.sourceId,
    lines: sortedLines.map((line) => ({
      itemId: line.itemId,
      locationId: line.locationId,
      quantityDelta: line.canonicalFields.quantityDeltaCanonical,
      canonicalUom: line.canonicalFields.canonicalUom,
      unitCost: line.unitCost ?? null,
      reasonCode: line.reasonCode
    }))
  });

  return deepFreeze({
    sortedLines,
    expectedLineCount: sortedLines.length,
    expectedDeterministicHash,
    persistInput: {
      id: params.header.id,
      tenantId: params.header.tenantId,
      movementType: params.header.movementType,
      status: params.header.status,
      externalRef: params.header.externalRef,
      sourceType: params.header.sourceType,
      sourceId: params.header.sourceId,
      idempotencyKey: params.header.idempotencyKey ?? null,
      occurredAt: params.header.occurredAt,
      postedAt: params.header.postedAt,
      notes: params.header.notes ?? null,
      metadata: params.header.metadata ?? null,
      createdAt: params.header.createdAt,
      updatedAt: params.header.updatedAt,
      lotId: params.header.lotId ?? null,
      productionBatchId: params.header.productionBatchId ?? null,
      lines: sortedLines.map((line) => mapPersistMovementLine(line, params.header.occurredAt))
    }
  });
}

async function buildPlannedMovement(params: {
  client: PoolClient;
  header: PlannedMovementHeader;
  lines: ReadonlyArray<RawMovementLineDescriptor>;
}): Promise<PlannedWorkOrderMovement> {
  return buildPlannedMovementFromLines({
    header: params.header,
    lines: await planMovementLines({
      tenantId: params.header.tenantId,
      lines: params.lines,
      client: params.client
    })
  });
}

export async function buildIssueMovement(params: {
  client: PoolClient;
  header: PlannedMovementHeader;
  lines: ReadonlyArray<RawMovementLineDescriptor>;
}) {
  return buildPlannedMovement(params);
}

export async function buildCompletionMovement(params: {
  client: PoolClient;
  header: PlannedMovementHeader;
  lines: ReadonlyArray<RawMovementLineDescriptor>;
}) {
  return buildPlannedMovement(params);
}

export async function buildBatchMovement(params: {
  client: PoolClient;
  issueHeader: PlannedMovementHeader;
  issueLines: ReadonlyArray<RawMovementLineDescriptor>;
  completionHeader: PlannedMovementHeader;
  completionLines: ReadonlyArray<RawMovementLineDescriptor>;
}): Promise<PlannedBatchMovement> {
  return deepFreeze({
    issue: await buildPlannedMovement({
      client: params.client,
      header: params.issueHeader,
      lines: params.issueLines
    }),
    completion: await buildPlannedMovement({
      client: params.client,
      header: params.completionHeader,
      lines: params.completionLines
    })
  });
}

export async function buildVoidMovement(params: {
  client: PoolClient;
  outputHeader: PlannedMovementHeader;
  outputLines: ReadonlyArray<RawMovementLineDescriptor>;
  componentHeader: PlannedMovementHeader;
  componentLines: ReadonlyArray<RawMovementLineDescriptor>;
}): Promise<PlannedVoidMovement> {
  return deepFreeze({
    output: await buildPlannedMovement({
      client: params.client,
      header: params.outputHeader,
      lines: params.outputLines
    }),
    components: await buildPlannedMovement({
      client: params.client,
      header: params.componentHeader,
      lines: params.componentLines
    })
  });
}

export function buildScrapMovement(params: {
  preparedTransfer: PreparedTransferMutation;
}) {
  return deepFreeze({
    sourceState: 'QA' as const,
    targetState: 'SCRAP' as const,
    preparedTransfer: params.preparedTransfer
  });
}

export type { PlannedWorkOrderMovementLine, PlannedMovementHeader, RawMovementLineDescriptor };
