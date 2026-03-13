import type { ManufacturingMutationState } from './workOrderExecution.types';

export const INVENTORY_STATES = [
  'AVAILABLE',
  'RESERVED',
  'ALLOCATED',
  'ISSUED',
  'WIP',
  'QA',
  'SCRAP'
] as const;

export type InventoryState = (typeof INVENTORY_STATES)[number];

const INVENTORY_STATE_TRANSITIONS: Record<InventoryState, InventoryState[]> = {
  AVAILABLE: ['RESERVED', 'ALLOCATED', 'ISSUED', 'WIP', 'QA'],
  RESERVED: ['AVAILABLE', 'ALLOCATED', 'ISSUED', 'WIP'],
  ALLOCATED: ['AVAILABLE', 'ISSUED', 'WIP'],
  ISSUED: ['WIP'],
  WIP: ['QA', 'AVAILABLE', 'SCRAP'],
  QA: ['SCRAP', 'AVAILABLE'],
  SCRAP: []
};

export function assertInventoryStateTransition(params: {
  flow: string;
  currentState: InventoryState;
  targetState: InventoryState;
  workOrderId?: string | null;
  executionOrDocumentId?: string | null;
}) {
  if (INVENTORY_STATE_TRANSITIONS[params.currentState].includes(params.targetState)) {
    return;
  }
  const error = new Error('INVENTORY_STATE_TRANSITION_INVALID') as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  error.code = 'INVENTORY_STATE_TRANSITION_INVALID';
  error.details = {
    flow: params.flow,
    currentState: params.currentState,
    targetState: params.targetState,
    workOrderId: params.workOrderId ?? null,
    executionOrDocumentId: params.executionOrDocumentId ?? null
  };
  throw error;
}

export function assertManufacturingTransition(params: {
  flow: string;
  currentState: ManufacturingMutationState;
  allowedFrom: ManufacturingMutationState[];
  targetState: ManufacturingMutationState;
  workOrderId: string;
  executionOrDocumentId: string;
}) {
  if (params.allowedFrom.includes(params.currentState)) {
    return;
  }
  const error = new Error('WO_INVALID_STATE') as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  error.code = 'WO_INVALID_STATE';
  error.details = {
    flow: params.flow,
    workOrderId: params.workOrderId,
    executionOrDocumentId: params.executionOrDocumentId,
    currentState: params.currentState,
    allowedFrom: params.allowedFrom,
    targetState: params.targetState
  };
  throw error;
}
