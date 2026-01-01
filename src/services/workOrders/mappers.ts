import type { WorkOrderRow } from './types';

export function mapWorkOrder(row: WorkOrderRow) {
  return {
    id: row.id,
    number: row.number ?? row.work_order_number,
    status: row.status,
    kind: row.kind,
    bomId: row.bom_id,
    bomVersionId: row.bom_version_id,
    relatedWorkOrderId: row.related_work_order_id,
    outputItemId: row.output_item_id,
    outputUom: row.output_uom,
    quantityPlanned: parseFloat(String(row.quantity_planned)),
    quantityCompleted: row.quantity_completed ? parseFloat(String(row.quantity_completed)) : 0,
    defaultConsumeLocationId: row.default_consume_location_id,
    defaultProduceLocationId: row.default_produce_location_id,
    scheduledStartAt: row.scheduled_start_at,
    scheduledDueAt: row.scheduled_due_at,
    releasedAt: row.released_at,
    completedAt: row.completed_at,
    notes: row.notes,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
