export type NegativeOverrideContext = {
  actor?: { type: 'user' | 'system'; id?: string | null; role?: string | null };
  overrideRequested?: boolean;
  overrideReason?: string | null;
};

export type WorkOrderRow = {
  id: string;
  work_order_number: string;
  number: string | null;
  status: string;
  kind: string;
  bom_id: string | null;
  bom_version_id: string | null;
  routing_id: string | null;
  produce_to_location_id_snapshot: string | null;
  output_item_id: string;
  output_uom: string;
  quantity_planned: string | number;
  quantity_completed: string | number | null;
  quantity_scrapped: string | number | null;
  default_consume_location_id: string | null;
  default_produce_location_id: string | null;
  completed_at: string | null;
  updated_at: string;
};

export type WorkOrderMaterialIssueRow = {
  id: string;
  work_order_id: string;
  status: string;
  occurred_at: string;
  inventory_movement_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type WorkOrderMaterialIssueLineRow = {
  id: string;
  work_order_material_issue_id: string;
  line_number: number;
  component_item_id: string;
  uom: string;
  quantity_issued: string | number;
  from_location_id: string;
  reason_code: string | null;
  notes: string | null;
  created_at: string;
};

export type WorkOrderExecutionRow = {
  id: string;
  work_order_id: string;
  occurred_at: string;
  status: string;
  consumption_movement_id: string | null;
  production_movement_id: string | null;
  production_batch_id: string | null;
  output_lot_id: string | null;
  wip_total_cost: string | number | null;
  wip_unit_cost: string | number | null;
  wip_quantity_canonical: string | number | null;
  wip_cost_method: string | null;
  wip_costed_at: string | null;
  notes: string | null;
  created_at: string;
};

export type WorkOrderExecutionLineRow = {
  id: string;
  work_order_execution_id: string;
  line_type: string;
  item_id: string;
  uom: string;
  quantity: string | number;
  pack_size: string | number | null;
  from_location_id: string | null;
  to_location_id: string | null;
  reason_code: string | null;
  notes: string | null;
  created_at: string;
};

export type LockedExecutionRow = {
  id: string;
  work_order_id: string;
  status: string;
  occurred_at: string;
  consumption_movement_id: string | null;
  production_movement_id: string | null;
};

export type MovementLineScopeRow = {
  item_id: string;
  location_id: string;
  warehouse_id: string | null;
  qty_canonical: string | number;
  balance_uom: string;
  unit_cost: string | number | null;
  extended_cost: string | number | null;
};

export type ExistingVoidMovementsRow = {
  id: string;
  source_type: string;
  status: string;
};

export type NormalizedBatchConsumeLine = {
  componentItemId: string;
  fromLocationId: string;
  uom: string;
  quantity: number;
  reasonCode: string | null;
  notes: string | null;
};

export type NormalizedBatchProduceLine = {
  outputItemId: string;
  toLocationId: string;
  uom: string;
  quantity: number;
  packSize: number | null;
  reasonCode: string | null;
  notes: string | null;
};

export type ManufacturingMutationState =
  | 'planned_issue'
  | 'posted_issue'
  | 'planned_completion'
  | 'reported_production'
  | 'posted_completion'
  | 'reversal';

export type WipValuationType =
  | 'issue'
  | 'completion'
  | 'report'
  | 'reversal_to_wip'
  | 'reversal_from_wip';

export type ExecutionPlan<
  TMovementPlan = unknown,
  TReplayPlan = unknown,
  TCostPlan = unknown,
  TWipPlan = unknown,
  TProjectionPlan = unknown,
  TEventPlan = unknown,
  TTraceabilityPlan = unknown
> = {
  movementPlan: TMovementPlan;
  replayPlan: TReplayPlan;
  costPlan: TCostPlan;
  wipPlan: TWipPlan;
  projectionPlan: TProjectionPlan;
  eventPlan: TEventPlan;
  traceabilityPlan: TTraceabilityPlan;
};
