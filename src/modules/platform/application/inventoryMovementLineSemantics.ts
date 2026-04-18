export const INVENTORY_MOVEMENT_LINE_ACTIONS = [
  'INCREASE_ON_HAND',
  'DECREASE_ON_HAND',
  'ALLOCATE',
  'RELEASE',
  'MOVE_LOCATION'
] as const;

export const INVENTORY_STATES = [
  'received',
  'qc_hold',
  'available',
  'allocated',
  'picked',
  'shipped',
  'adjusted'
] as const;

export const INVENTORY_STATE_TRANSITIONS = [
  'received->qc_hold',
  'received->available',
  'qc_hold->available',
  'available->allocated',
  'allocated->available',
  'allocated->picked',
  'picked->shipped',
  'available->shipped',
  'available->adjusted',
  'adjusted->available'
] as const;

export type InventoryMovementLineAction =
  (typeof INVENTORY_MOVEMENT_LINE_ACTIONS)[number];

export type InventoryState = (typeof INVENTORY_STATES)[number];
export type InventoryStateTransition = (typeof INVENTORY_STATE_TRANSITIONS)[number];

const VALID_INVENTORY_STATE_TRANSITIONS = new Set<string>(INVENTORY_STATE_TRANSITIONS);

export function classifyInventoryMovementLineAction(params: {
  movementType: string;
  quantityDelta: number;
  reasonCode?: string | null;
}): InventoryMovementLineAction {
  const movementType = params.movementType.trim().toLowerCase();
  const reasonCode = params.reasonCode?.trim().toLowerCase() ?? '';

  if (movementType === 'transfer') {
    return 'MOVE_LOCATION';
  }
  if (reasonCode === 'allocate' || movementType === 'allocate') {
    return 'ALLOCATE';
  }
  if (reasonCode === 'release' || movementType === 'release') {
    return 'RELEASE';
  }
  if (params.quantityDelta > 0) {
    return 'INCREASE_ON_HAND';
  }
  if (params.quantityDelta < 0) {
    return 'DECREASE_ON_HAND';
  }
  throw new Error('INVENTORY_MOVEMENT_LINE_ACTION_INVALID');
}

export function assertInventoryStateTransition(
  fromState: InventoryState,
  toState: InventoryState
): InventoryStateTransition {
  const transition = `${fromState}->${toState}`;
  if (!VALID_INVENTORY_STATE_TRANSITIONS.has(transition)) {
    throw new Error('INVENTORY_STATE_TRANSITION_INVALID');
  }
  return transition as InventoryStateTransition;
}

export function deriveInventoryBalanceStateTransition(params: {
  deltaOnHand?: number;
  deltaReserved?: number;
  deltaAllocated?: number;
  reasonCode?: string | null;
}): InventoryStateTransition {
  const deltaOnHand = params.deltaOnHand ?? 0;
  const deltaReserved = params.deltaReserved ?? 0;
  const deltaAllocated = params.deltaAllocated ?? 0;
  const reasonCode = params.reasonCode?.trim().toLowerCase() ?? '';

  if (deltaReserved > 0 && deltaAllocated === 0) {
    return assertInventoryStateTransition('available', 'allocated');
  }
  if (deltaReserved < 0 && deltaAllocated > 0) {
    return assertInventoryStateTransition('allocated', 'picked');
  }
  if (deltaReserved < 0 && deltaAllocated === 0) {
    return assertInventoryStateTransition('allocated', 'available');
  }
  if (deltaOnHand < 0 && deltaAllocated < 0) {
    return assertInventoryStateTransition('picked', 'shipped');
  }
  if (deltaOnHand > 0 && reasonCode.includes('adjust')) {
    return assertInventoryStateTransition('adjusted', 'available');
  }
  if (deltaOnHand > 0) {
    return assertInventoryStateTransition('received', 'available');
  }
  if (deltaOnHand < 0 && reasonCode.includes('adjust')) {
    return assertInventoryStateTransition('available', 'adjusted');
  }
  if (deltaOnHand < 0) {
    return assertInventoryStateTransition('available', 'shipped');
  }
  if (deltaAllocated < 0) {
    return assertInventoryStateTransition('allocated', 'available');
  }

  throw new Error('INVENTORY_STATE_TRANSITION_INVALID');
}

export function assertSourceLineQuantityConservation(params: {
  sourceLineId: string;
  increases: ReadonlyArray<number>;
  decreases: ReadonlyArray<number>;
  netQuantity: number;
  epsilon?: number;
}) {
  const epsilon = params.epsilon ?? 1e-6;
  const increaseTotal = params.increases.reduce((sum, quantity) => sum + quantity, 0);
  const decreaseTotal = params.decreases.reduce((sum, quantity) => sum + quantity, 0);
  const actualNet = increaseTotal - decreaseTotal;
  if (Math.abs(actualNet - params.netQuantity) <= epsilon) {
    return;
  }
  throw new Error('INVENTORY_SOURCE_LINE_CONSERVATION_VIOLATION');
}

export function assertAllocationWithinAvailable(params: {
  allocationQuantity: number;
  availableQuantity: number;
  epsilon?: number;
}) {
  const epsilon = params.epsilon ?? 1e-6;
  if (params.availableQuantity < -epsilon || params.allocationQuantity - params.availableQuantity > epsilon) {
    throw new Error('INVENTORY_ALLOCATION_EXCEEDS_AVAILABLE');
  }
}
