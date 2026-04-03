import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import {
  persistInventoryMovement
} from '../../domains/inventory';
import {
  assertProjectionDeltaContract,
  assertQuantityEquality
} from '../inventory/mutationInvariants';
import { roundQuantity, toNumber } from '../../lib/numbers';
import {
  buildInventoryBalanceProjectionOp
} from '../../modules/platform/application/inventoryMutationSupport';
import type {
  InventoryCommandEvent,
  InventoryCommandProjectionOp
} from '../../modules/platform/application/runInventoryCommand';
import {
  applyPlannedCostLayerConsumption,
  createCostLayer,
  planCostLayerConsumption
} from '../../services/costLayers.service';
import * as eventFactory from '../../services/inventoryEventFactory';
import * as lotTraceability from '../../services/lotTraceabilityEngine';
import * as movementPlanner from '../../services/inventoryMovementPlanner';
import * as projectionEngine from '../../services/inventoryProjectionEngine';
import {
  consumeWorkOrderReservations
} from '../../services/inventoryReservation.service';
import { validateSufficientStock } from '../../services/stockValidation.service';
import * as wipEngine from '../../services/wipAccountingEngine';
import { nextStatusFromProgress } from '../../services/workOrderLifecycle.service';
import type { NegativeOverrideContext } from '../../services/workOrderExecution.types';
import type { WorkOrderBatchPlan } from './batchPlan';
import type { WorkOrderBatchPolicy } from './batchPolicy';

export type WorkOrderBatchTraceabilityRequest = {
  outputItemId: string;
  outputQty: number;
  outputUom: string;
  outputLotId?: string | null;
  outputLotCode?: string | null;
  productionBatchId?: string | null;
  inputLots?: ReadonlyArray<lotTraceability.WorkOrderInputLotLink>;
  workOrderNumber: string;
  occurredAt: Date;
};

export type ExecuteWorkOrderBatchParams = {
  tenantId: string;
  workOrderId: string;
  policy: WorkOrderBatchPolicy;
  plan: WorkOrderBatchPlan;
  occurredAt: Date;
  notes: string | null;
  context: NegativeOverrideContext;
  batchIdempotencyKey: string | null;
  requestHash: string;
  traceability?: WorkOrderBatchTraceabilityRequest | null;
  client: PoolClient;
};

function buildProducedCostAllocations(params: {
  sortedProduces: ReadonlyArray<movementPlanner.PlannedWorkOrderMovementLine>;
  totalPlannedIssueCost: number;
  produceLineBySourceId: ReadonlyMap<
    string,
    {
      outputItemId: string;
      toLocationId: string;
      quantity: number;
      uom: string;
      packSize: number | null;
      reasonCode: string | null;
      notes: string | null;
    }
  >;
  producedCanonicalTotal: number;
}) {
  const allocations: Array<{
    preparedProduce: movementPlanner.PlannedWorkOrderMovementLine;
    sourceLine: {
      outputItemId: string;
      toLocationId: string;
      quantity: number;
      uom: string;
      packSize: number | null;
      reasonCode: string | null;
      notes: string | null;
    };
    allocatedCost: number;
    unitCost: number | null;
  }> = [];

  let remainingCost = roundQuantity(params.totalPlannedIssueCost);
  params.sortedProduces.forEach((preparedProduce, index) => {
    const sourceLine = params.produceLineBySourceId.get(preparedProduce.sourceLineId);
    if (!sourceLine) {
      throw new Error('WO_BATCH_PRODUCE_LINE_NOT_FOUND');
    }
    const canonicalQty = preparedProduce.canonicalFields.quantityDeltaCanonical;
    const allocatedCost = index === params.sortedProduces.length - 1
      ? remainingCost
      : roundQuantity(
        params.totalPlannedIssueCost * (canonicalQty / params.producedCanonicalTotal)
      );
    remainingCost = roundQuantity(remainingCost - allocatedCost);
    allocations.push({
      preparedProduce,
      sourceLine,
      allocatedCost,
      unitCost: canonicalQty !== 0 ? allocatedCost / canonicalQty : null
    });
  });

  assertQuantityEquality({
    expectedQuantity: params.totalPlannedIssueCost,
    actualQuantity: allocations.reduce((sum, line) => roundQuantity(sum + line.allocatedCost), 0),
    errorCode: 'WO_BATCH_OUTPUT_COST_IMBALANCE'
  });

  return allocations;
}

export async function executeWorkOrderBatchPosting(
  params: ExecuteWorkOrderBatchParams
): Promise<{
  responseBody: {
    workOrderId: string;
    executionId: string;
    issueMovementId: string;
    receiveMovementId: string;
    quantityCompleted: number;
    workOrderStatus: string;
    idempotencyKey: string | null;
    replayed: false;
  };
  responseStatus: number;
  events: InventoryCommandEvent[];
  projectionOps: InventoryCommandProjectionOp[];
}> {
  if (params.plan.producedCanonicalTotal <= 0) {
    throw new Error('WO_WIP_COST_INVALID_OUTPUT_QTY');
  }

  const executionId = uuidv4();
  const issueId = uuidv4();
  const issueMovementId = uuidv4();
  const receiveMovementId = uuidv4();
  const now = new Date();
  const workOrderNumber = params.policy.workOrder.number ?? params.policy.workOrder.work_order_number;

  let preparedTraceability: lotTraceability.PreparedWorkOrderTraceability | null = null;
  if (params.traceability) {
    preparedTraceability = await lotTraceability.prepareTraceability(params.client, {
      tenantId: params.tenantId,
      executionId,
      outputItemId: params.traceability.outputItemId,
      outputLotId: params.traceability.outputLotId ?? null,
      outputLotCode: params.traceability.outputLotCode ?? null,
      productionBatchId: params.traceability.productionBatchId ?? null,
      inputLots: params.traceability.inputLots ? [...params.traceability.inputLots] : [],
      workOrderNumber: params.traceability.workOrderNumber,
      occurredAt: params.traceability.occurredAt
    });
  }

  const validation = await validateSufficientStock(
    params.tenantId,
    params.occurredAt,
    params.plan.validationLines.map((line) => ({ ...line })),
    {
      actorId: params.context.actor?.id ?? null,
      actorRole: params.context.actor?.role ?? null,
      overrideRequested: params.context.overrideRequested,
      overrideReason: params.context.overrideReason ?? null,
      overrideReference: `work_order_batch_issue:${issueId}`
    },
    { client: params.client }
  );

  const plannedIssueMovementLines: Array<{
    preparedConsume: movementPlanner.PlannedWorkOrderMovementLine;
    sourceLine: {
      componentItemId: string;
      fromLocationId: string;
      quantity: number;
      uom: string;
      reasonCode: string | null;
      notes: string | null;
    };
    issueCost: number;
    consumptionPlan: Awaited<ReturnType<typeof planCostLayerConsumption>>;
  }> = [];
  for (const preparedConsume of params.plan.sortedConsumes) {
    const sourceLine = params.plan.consumeLineBySourceId.get(preparedConsume.sourceLineId);
    if (!sourceLine) {
      throw new Error('WO_BATCH_CONSUME_LINE_NOT_FOUND');
    }
    const canonicalQty = Math.abs(preparedConsume.canonicalFields.quantityDeltaCanonical);
    let consumptionPlan: Awaited<ReturnType<typeof planCostLayerConsumption>>;
    try {
      consumptionPlan = await planCostLayerConsumption({
        tenant_id: params.tenantId,
        item_id: sourceLine.componentItemId,
        location_id: sourceLine.fromLocationId,
        quantity: canonicalQty,
        consumption_type: 'production_input',
        consumption_document_id: issueId,
        movement_id: issueMovementId,
        client: params.client
      });
    } catch {
      throw new Error('WO_WIP_COST_LAYERS_MISSING');
    }
    plannedIssueMovementLines.push({
      preparedConsume,
      sourceLine,
      issueCost: consumptionPlan.total_cost,
      consumptionPlan
    });
  }

  const totalPlannedIssueCost = plannedIssueMovementLines.reduce(
    (sum, line) => roundQuantity(sum + line.issueCost),
    0
  );
  const plannedReceiveMovementLines = buildProducedCostAllocations({
    sortedProduces: params.plan.sortedProduces,
    totalPlannedIssueCost,
    produceLineBySourceId: params.plan.produceLineBySourceId,
    producedCanonicalTotal: params.plan.producedCanonicalTotal
  });

  const issueMovementPlan = movementPlanner.buildPlannedMovementFromLines({
    header: {
      id: issueMovementId,
      tenantId: params.tenantId,
      movementType: 'issue',
      status: 'posted',
      externalRef: params.policy.isDisassembly
        ? `work_order_disassembly_issue:${issueId}:${params.workOrderId}`
        : `work_order_batch_issue:${issueId}:${params.workOrderId}`,
      sourceType: 'work_order_batch_post_issue',
      sourceId: executionId,
      idempotencyKey: params.batchIdempotencyKey
        ? `${params.batchIdempotencyKey}:issue`
        : `wo-batch-issue-post:${executionId}`,
      occurredAt: params.occurredAt,
      postedAt: now,
      notes: params.notes,
      metadata: {
        workOrderId: params.workOrderId,
        workOrderNumber,
        ...(validation.overrideMetadata ?? {})
      },
      createdAt: now,
      updatedAt: now
    },
    lines: plannedIssueMovementLines.map(({ preparedConsume, issueCost }) => {
      const canonicalQty = Math.abs(preparedConsume.canonicalFields.quantityDeltaCanonical);
      return Object.freeze({
        ...preparedConsume,
        unitCost: canonicalQty !== 0 ? issueCost / canonicalQty : null,
        extendedCost: -issueCost
      });
    })
  });

  const receiveMovementPlan = movementPlanner.buildPlannedMovementFromLines({
    header: {
      id: receiveMovementId,
      tenantId: params.tenantId,
      movementType: 'receive',
      status: 'posted',
      externalRef: params.policy.isDisassembly
        ? `work_order_disassembly_completion:${executionId}:${params.workOrderId}`
        : `work_order_batch_completion:${executionId}:${params.workOrderId}`,
      sourceType: 'work_order_batch_post_completion',
      sourceId: executionId,
      idempotencyKey: params.batchIdempotencyKey
        ? `${params.batchIdempotencyKey}:completion`
        : `wo-batch-completion-post:${executionId}`,
      occurredAt: params.occurredAt,
      postedAt: now,
      notes: params.notes,
      metadata: {
        workOrderId: params.workOrderId,
        workOrderNumber,
        ...(preparedTraceability
          ? {
            lotId: preparedTraceability.outputLotId,
            productionBatchId: preparedTraceability.productionBatchId
          }
          : {})
      },
      createdAt: now,
      updatedAt: now,
      lotId: preparedTraceability?.outputLotId ?? null,
      productionBatchId: preparedTraceability?.productionBatchId ?? null
    },
    lines: plannedReceiveMovementLines.map(({ preparedProduce, allocatedCost, unitCost }) => Object.freeze({
      ...preparedProduce,
      unitCost,
      extendedCost: allocatedCost
    }))
  });

  const issueMovement = await persistInventoryMovement(
    params.client,
    issueMovementPlan.persistInput
  );
  const receiveMovement = await persistInventoryMovement(
    params.client,
    receiveMovementPlan.persistInput
  );
  if (!issueMovement.created || !receiveMovement.created) {
    throw new Error('WO_POSTING_IDEMPOTENCY_INCOMPLETE');
  }

  await params.client.query(
    `INSERT INTO work_order_material_issues (
        id, tenant_id, work_order_id, status, occurred_at, inventory_movement_id, notes, idempotency_key, created_at, updated_at
     ) VALUES ($1, $2, $3, 'posted', $4, $5, $6, $7, $8, $8)`,
    [
      issueId,
      params.tenantId,
      params.workOrderId,
      params.occurredAt,
      issueMovementId,
      params.notes,
      params.batchIdempotencyKey ? `${params.batchIdempotencyKey}:issue-doc` : null,
      now
    ]
  );
  for (let index = 0; index < params.policy.consumeLinesOrdered.length; index += 1) {
    const line = params.policy.consumeLinesOrdered[index]!;
    await params.client.query(
      `INSERT INTO work_order_material_issue_lines (
          id, tenant_id, work_order_material_issue_id, line_number, component_item_id, uom, quantity_issued, from_location_id, reason_code, notes, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        uuidv4(),
        params.tenantId,
        issueId,
        index + 1,
        line.componentItemId,
        line.uom,
        line.quantity,
        line.fromLocationId,
        line.reasonCode,
        line.notes ?? null,
        now
      ]
    );
  }

  const projectionDeltas = [
    ...params.plan.sortedConsumes.map((line) => ({
      itemId: line.itemId,
      locationId: line.locationId,
      uom: line.canonicalFields.canonicalUom,
      deltaOnHand: line.canonicalFields.quantityDeltaCanonical
    })),
    ...params.plan.sortedProduces.map((line) => ({
      itemId: line.itemId,
      locationId: line.locationId,
      uom: line.canonicalFields.canonicalUom,
      deltaOnHand: line.canonicalFields.quantityDeltaCanonical
    }))
  ];
  const inventoryBalanceProjectionDeltas: typeof projectionDeltas = [];

  let totalConsumedCost = 0;
  const projectionOps: InventoryCommandProjectionOp[] = [];
  for (const { preparedConsume, sourceLine, issueCost, consumptionPlan } of plannedIssueMovementLines) {
    const canonicalQty = Math.abs(preparedConsume.canonicalFields.quantityDeltaCanonical);
    await applyPlannedCostLayerConsumption({
      tenant_id: params.tenantId,
      item_id: sourceLine.componentItemId,
      location_id: sourceLine.fromLocationId,
      quantity: canonicalQty,
      consumption_type: 'production_input',
      consumption_document_id: issueId,
      movement_id: issueMovementId,
      client: params.client,
      plan: consumptionPlan
    });
    totalConsumedCost = roundQuantity(totalConsumedCost + issueCost);
    projectionOps.push(
      buildInventoryBalanceProjectionOp({
        tenantId: params.tenantId,
        itemId: sourceLine.componentItemId,
        locationId: sourceLine.fromLocationId,
        uom: preparedConsume.canonicalFields.canonicalUom,
        deltaOnHand: preparedConsume.canonicalFields.quantityDeltaCanonical
      })
    );
    inventoryBalanceProjectionDeltas.push({
      itemId: sourceLine.componentItemId,
      locationId: sourceLine.fromLocationId,
      uom: preparedConsume.canonicalFields.canonicalUom,
      deltaOnHand: preparedConsume.canonicalFields.quantityDeltaCanonical
    });
  }

  await params.client.query(
    `INSERT INTO work_order_executions (
        id, tenant_id, work_order_id, occurred_at, status, consumption_movement_id, production_movement_id,
        output_lot_id, production_batch_id, notes, idempotency_key, idempotency_request_hash,
        idempotency_request_summary, created_at
     ) VALUES ($1, $2, $3, $4, 'posted', $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)`,
    [
      executionId,
      params.tenantId,
      params.workOrderId,
      params.occurredAt,
      issueMovementId,
      receiveMovementId,
      preparedTraceability?.outputLotId ?? null,
      preparedTraceability?.productionBatchId ?? null,
      params.notes,
      params.batchIdempotencyKey,
      params.batchIdempotencyKey ? params.requestHash : null,
      params.batchIdempotencyKey
        ? JSON.stringify({
          workOrderId: params.workOrderId,
          consumeLineCount: params.policy.consumeLinesOrdered.length,
          produceLineCount: params.policy.produceLinesOrdered.length,
          executionIds: [executionId]
        })
        : null,
      now
    ]
  );
  for (let index = 0; index < params.policy.produceLinesOrdered.length; index += 1) {
    const line = params.policy.produceLinesOrdered[index]!;
    await params.client.query(
      `INSERT INTO work_order_execution_lines (
          id, tenant_id, work_order_execution_id, line_type, item_id, uom, quantity, pack_size, from_location_id, to_location_id, reason_code, notes, created_at
       ) VALUES ($1, $2, $3, 'produce', $4, $5, $6, $7, NULL, $8, $9, $10, $11)`,
      [
        uuidv4(),
        params.tenantId,
        executionId,
        line.outputItemId,
        line.uom,
        line.quantity,
        line.packSize ?? null,
        line.toLocationId,
        line.reasonCode,
        line.notes ?? null,
        now
      ]
    );
  }

  const pendingWipAllocation = await wipEngine.lockOpenWip(params.client, {
    tenantId: params.tenantId,
    scope: { kind: 'movement', movementId: issueMovementId }
  });
  const totalIssueCost = await wipEngine.allocateWipCost(params.client, {
    tenantId: params.tenantId,
    executionId,
    allocatedAt: now,
    pending: pendingWipAllocation
  });
  assertQuantityEquality({
    expectedQuantity: totalConsumedCost,
    actualQuantity: totalIssueCost,
    errorCode: 'WO_WIP_COST_DRIFT'
  });
  const wipUnitCostCanonical = totalIssueCost / params.plan.producedCanonicalTotal;

  for (const { preparedProduce, sourceLine, unitCost } of plannedReceiveMovementLines) {
    await createCostLayer({
      tenant_id: params.tenantId,
      item_id: sourceLine.outputItemId,
      location_id: sourceLine.toLocationId,
      uom: preparedProduce.canonicalFields.canonicalUom,
      quantity: preparedProduce.canonicalFields.quantityDeltaCanonical,
      unit_cost: unitCost ?? 0,
      source_type: 'production',
      source_document_id: issueId,
      movement_id: receiveMovementId,
      notes: `Backflush production from work order ${params.workOrderId}`,
      client: params.client
    });
    projectionOps.push(
      buildInventoryBalanceProjectionOp({
        tenantId: params.tenantId,
        itemId: sourceLine.outputItemId,
        locationId: sourceLine.toLocationId,
        uom: preparedProduce.canonicalFields.canonicalUom,
        deltaOnHand: preparedProduce.canonicalFields.quantityDeltaCanonical
      })
    );
    inventoryBalanceProjectionDeltas.push({
      itemId: sourceLine.outputItemId,
      locationId: sourceLine.toLocationId,
      uom: preparedProduce.canonicalFields.canonicalUom,
      deltaOnHand: preparedProduce.canonicalFields.quantityDeltaCanonical
    });
  }

  await wipEngine.createWipValuationRecord(params.client, {
    tenantId: params.tenantId,
    workOrderId: params.workOrderId,
    executionId,
    movementId: issueMovementId,
    valuationType: 'issue',
    valueDelta: totalConsumedCost,
    notes: `Work-order batch issue WIP valuation for execution ${executionId}`
  });
  const outputUomSet = new Set(
    params.plan.sortedProduces.map((line) => line.canonicalFields.canonicalUom)
  );
  const outputCanonicalUom =
    outputUomSet.size === 1 ? params.plan.sortedProduces[0]?.canonicalFields.canonicalUom ?? null : null;
  await wipEngine.createWipValuationRecord(params.client, {
    tenantId: params.tenantId,
    workOrderId: params.workOrderId,
    executionId,
    movementId: receiveMovementId,
    valuationType: 'report',
    valueDelta: -totalIssueCost,
    quantityCanonical: outputCanonicalUom ? params.plan.producedCanonicalTotal : null,
    canonicalUom: outputCanonicalUom,
    notes: `Work-order production report WIP capitalization for execution ${executionId}`
  });
  await wipEngine.verifyWipIntegrity(params.client, params.tenantId, params.workOrderId);

  await consumeWorkOrderReservations(
    params.tenantId,
    params.workOrderId,
    params.policy.consumeLinesOrdered.map((line) => ({
      componentItemId: line.componentItemId,
      locationId: line.fromLocationId,
      uom: line.uom,
      quantity: line.quantity
    })),
    params.client
  );

  const consumedTotal = params.policy.consumeLinesOrdered.reduce(
    (sum, line) => roundQuantity(sum + line.quantity),
    0
  );
  const currentCompleted = toNumber(params.policy.workOrder.quantity_completed ?? 0);
  const progressQty = params.policy.isDisassembly ? consumedTotal : params.plan.producedTotal;
  const newCompleted = roundQuantity(currentCompleted + progressQty);
  const planned = toNumber(params.policy.workOrder.quantity_planned);
  const completedAt = newCompleted >= planned ? now : null;
  const newStatus = nextStatusFromProgress({
    currentStatus: params.policy.workOrder.status,
    plannedQuantity: planned,
    completedQuantity: newCompleted,
    scrappedQuantity: toNumber(params.policy.workOrder.quantity_scrapped ?? 0)
  });

  assertProjectionDeltaContract({
    movementDeltas: projectionDeltas,
    projectionDeltas: inventoryBalanceProjectionDeltas,
    errorCode: 'WO_BATCH_PROJECTION_CONTRACT_INVALID'
  });

  projectionOps.push(
    ...projectionEngine.buildBatchProjectionOps({
      tenantId: params.tenantId,
      executionId,
      workOrderId: params.workOrderId,
      issueMovementId,
      now,
      workOrder: params.policy.workOrder,
      totalIssueCost,
      wipUnitCostCanonical,
      producedCanonicalTotal: params.plan.producedCanonicalTotal,
      newCompleted,
      newStatus,
      completedAt,
      validationOverrideMetadata: validation.overrideMetadata ?? null,
      context: params.context,
      consumeLinesOrdered: [...params.policy.consumeLinesOrdered]
    })
  );

  return {
    responseBody: {
      workOrderId: params.workOrderId,
      executionId,
      issueMovementId,
      receiveMovementId,
      quantityCompleted: newCompleted,
      workOrderStatus: newStatus,
      idempotencyKey: params.batchIdempotencyKey,
      replayed: false
    },
    responseStatus: 201,
    events: [
      eventFactory.buildInventoryMovementPostedEvent(issueMovementId, params.batchIdempotencyKey),
      eventFactory.buildInventoryMovementPostedEvent(receiveMovementId, params.batchIdempotencyKey),
      eventFactory.buildWorkOrderProductionReportedEvent({
        executionId,
        workOrderId: params.workOrderId,
        issueMovementId,
        receiveMovementId,
        producerIdempotencyKey: params.batchIdempotencyKey
      })
    ],
    projectionOps
  };
}
