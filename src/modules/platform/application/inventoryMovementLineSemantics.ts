export const INVENTORY_MOVEMENT_LINE_ACTIONS = [
  'INCREASE_ON_HAND',
  'DECREASE_ON_HAND',
  'ALLOCATE',
  'RELEASE',
  'MOVE_LOCATION'
] as const;

export type InventoryMovementLineAction =
  (typeof INVENTORY_MOVEMENT_LINE_ACTIONS)[number];

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
