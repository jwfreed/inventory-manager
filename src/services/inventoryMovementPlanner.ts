import type { CanonicalMovementFields } from './uomCanonical.service';
import { buildMovementDeterministicHash, sortDeterministicMovementLines } from '../modules/platform/application/inventoryMutationSupport';
import type { PersistInventoryMovementInput, PersistInventoryMovementLineInput } from '../domains/inventory';
import type { PreparedTransferMutation } from './transfers.service';

type PlannedWorkOrderMovementLine = {
  sourceLineId: string;
  warehouseId: string;
  itemId: string;
  locationId: string;
  canonicalFields: CanonicalMovementFields;
  reasonCode: string;
  lineNotes: string | null;
  unitCost?: number | null;
  extendedCost?: number | null;
};

type PlannedMovementHeader = {
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
};

export type PlannedWorkOrderMovement = {
  sortedLines: PlannedWorkOrderMovementLine[];
  persistInput: PersistInventoryMovementInput;
  expectedLineCount: number;
  expectedDeterministicHash: string;
};

export type PlannedBatchMovement = {
  issue: PlannedWorkOrderMovement;
  completion: PlannedWorkOrderMovement;
};

export type PlannedVoidMovement = {
  output: PlannedWorkOrderMovement;
  components: PlannedWorkOrderMovement;
};

function mapPersistMovementLine(line: PlannedWorkOrderMovementLine): PersistInventoryMovementLineInput {
  return {
    warehouseId: line.warehouseId,
    sourceLineId: line.sourceLineId,
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

function buildPlannedMovement(
  header: PlannedMovementHeader,
  lines: PlannedWorkOrderMovementLine[]
): PlannedWorkOrderMovement {
  const sortedLines = sortDeterministicMovementLines(lines, (line) => ({
    tenantId: header.tenantId,
    warehouseId: line.warehouseId,
    locationId: line.locationId,
    itemId: line.itemId,
    canonicalUom: line.canonicalFields.canonicalUom,
    sourceLineId: line.sourceLineId
  }));
  const expectedDeterministicHash = buildMovementDeterministicHash({
    tenantId: header.tenantId,
    movementType: header.movementType,
    occurredAt: header.occurredAt,
    sourceType: header.sourceType,
    sourceId: header.sourceId,
    lines: sortedLines.map((line) => ({
      itemId: line.itemId,
      locationId: line.locationId,
      quantityDelta: line.canonicalFields.quantityDeltaCanonical,
      canonicalUom: line.canonicalFields.canonicalUom,
      unitCost: line.unitCost ?? null,
      reasonCode: line.reasonCode
    }))
  });

  return {
    sortedLines,
    expectedLineCount: sortedLines.length,
    expectedDeterministicHash,
    persistInput: {
      id: header.id,
      tenantId: header.tenantId,
      movementType: header.movementType,
      status: header.status,
      externalRef: header.externalRef,
      sourceType: header.sourceType,
      sourceId: header.sourceId,
      idempotencyKey: header.idempotencyKey ?? null,
      occurredAt: header.occurredAt,
      postedAt: header.postedAt,
      notes: header.notes ?? null,
      metadata: header.metadata ?? null,
      createdAt: header.createdAt,
      updatedAt: header.updatedAt,
      lotId: header.lotId ?? null,
      productionBatchId: header.productionBatchId ?? null,
      lines: sortedLines.map(mapPersistMovementLine)
    }
  };
}

export function buildIssueMovement(params: {
  header: PlannedMovementHeader;
  lines: PlannedWorkOrderMovementLine[];
}) {
  return buildPlannedMovement(params.header, params.lines);
}

export function buildCompletionMovement(params: {
  header: PlannedMovementHeader;
  lines: PlannedWorkOrderMovementLine[];
}) {
  return buildPlannedMovement(params.header, params.lines);
}

export function buildBatchMovement(params: {
  issueHeader: PlannedMovementHeader;
  issueLines: PlannedWorkOrderMovementLine[];
  completionHeader: PlannedMovementHeader;
  completionLines: PlannedWorkOrderMovementLine[];
}): PlannedBatchMovement {
  return {
    issue: buildPlannedMovement(params.issueHeader, params.issueLines),
    completion: buildPlannedMovement(params.completionHeader, params.completionLines)
  };
}

export function buildVoidMovement(params: {
  outputHeader: PlannedMovementHeader;
  outputLines: PlannedWorkOrderMovementLine[];
  componentHeader: PlannedMovementHeader;
  componentLines: PlannedWorkOrderMovementLine[];
}): PlannedVoidMovement {
  return {
    output: buildPlannedMovement(params.outputHeader, params.outputLines),
    components: buildPlannedMovement(params.componentHeader, params.componentLines)
  };
}

export function buildScrapMovement(params: {
  preparedTransfer: PreparedTransferMutation;
}) {
  return {
    sourceState: 'QA' as const,
    targetState: 'SCRAP' as const,
    preparedTransfer: params.preparedTransfer
  };
}

export type { PlannedWorkOrderMovementLine, PlannedMovementHeader };
