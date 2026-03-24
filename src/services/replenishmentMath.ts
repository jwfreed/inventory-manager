import { roundQuantity, toNumber } from '../lib/numbers';

export type NormalizedPolicyType = 'q_rop' | 'min_max';

export type ReplenishmentPolicyLike = {
  policyType?: string | null;
  leadTimeDays?: number | null;
  demandRatePerDay?: number | null;
  safetyStockMethod?: string | null;
  safetyStockQty?: number | null;
  ppisPeriods?: number | null;
  reviewPeriodDays?: number | null;
  reorderPointQty?: number | null;
  orderUpToLevelQty?: number | null;
  orderQuantityQty?: number | null;
  minOrderQty?: number | null;
  maxOrderQty?: number | null;
};

export type ReplenishmentInventoryPositionInput = {
  usableOnHand: number;
  onOrder: number;
  inTransit: number;
  reservedCommitment: number;
  backorderedQty: number;
};

export type EffectiveReorderPoint = {
  value: number | null;
  source: 'explicit' | 'derived' | 'missing';
};

export function normalizePolicyType(policyType: string | null | undefined): NormalizedPolicyType {
  const normalized = String(policyType ?? '').trim().toLowerCase();
  return normalized === 'q_rop' ? 'q_rop' : 'min_max';
}

export function sumReservedCommitment(reservedQty: number, allocatedQty: number): number {
  // invariant: allocated is separate from reserved in this repo's lifecycle.
  // double counting must never occur.
  return roundQuantity(Math.max(0, toNumber(reservedQty)) + Math.max(0, toNumber(allocatedQty)));
}

export function computeCycleCoverageQty(policy: ReplenishmentPolicyLike): number {
  if (String(policy.safetyStockMethod ?? '').toLowerCase() !== 'ppis') {
    return 0;
  }
  const demandRatePerDay = Math.max(0, toNumber(policy.demandRatePerDay));
  const ppisPeriods = Math.max(0, toNumber(policy.ppisPeriods));
  return roundQuantity(demandRatePerDay * ppisPeriods);
}

export function computeEffectiveSafetyStockQty(policy: ReplenishmentPolicyLike): number {
  const method = String(policy.safetyStockMethod ?? 'none').toLowerCase();
  if (method === 'fixed') {
    return roundQuantity(Math.max(0, toNumber(policy.safetyStockQty)));
  }
  // invariant: ppis represents cycle coverage, not safety stock.
  // do not mix buffer types.
  return 0;
}

export function computeEffectiveReorderPoint(policy: ReplenishmentPolicyLike): EffectiveReorderPoint {
  if (policy.reorderPointQty !== null && policy.reorderPointQty !== undefined) {
    return {
      value: roundQuantity(Math.max(0, toNumber(policy.reorderPointQty))),
      source: 'explicit'
    };
  }

  const hasLeadTime = policy.leadTimeDays !== null && policy.leadTimeDays !== undefined;
  const hasDemandRate = policy.demandRatePerDay !== null && policy.demandRatePerDay !== undefined;
  if (!hasLeadTime || !hasDemandRate) {
    return { value: null, source: 'missing' };
  }

  const demandRatePerDay = Math.max(0, toNumber(policy.demandRatePerDay));
  const leadTimeDays = Math.max(0, toNumber(policy.leadTimeDays));
  const effectiveSafetyStockQty = computeEffectiveSafetyStockQty(policy);
  return {
    value: roundQuantity(demandRatePerDay * leadTimeDays + effectiveSafetyStockQty),
    source: 'derived'
  };
}

export function validateReplenishmentPolicy(policy: ReplenishmentPolicyLike): string[] {
  const errors: string[] = [];
  const normalizedPolicyType = normalizePolicyType(policy.policyType);
  const explicitReorderPoint = policy.reorderPointQty !== null && policy.reorderPointQty !== undefined;
  const hasDerivedInputs =
    policy.leadTimeDays !== null &&
    policy.leadTimeDays !== undefined &&
    policy.demandRatePerDay !== null &&
    policy.demandRatePerDay !== undefined;
  const effectiveReorderPoint = computeEffectiveReorderPoint(policy);

  if (!explicitReorderPoint && !hasDerivedInputs) {
    errors.push('Reorder point is required explicitly or via lead time and demand rate.');
  }

  if (String(policy.safetyStockMethod ?? 'none').toLowerCase() === 'fixed' && policy.safetyStockQty == null) {
    errors.push('Fixed safety stock requires safetyStockQty.');
  }

  if (String(policy.safetyStockMethod ?? 'none').toLowerCase() === 'ppis') {
    if (policy.ppisPeriods == null) {
      errors.push('PPIS cycle coverage requires ppisPeriods.');
    }
    if (policy.demandRatePerDay == null) {
      errors.push('PPIS cycle coverage requires demandRatePerDay.');
    }
  }

  if (normalizedPolicyType === 'q_rop') {
    if (policy.orderQuantityQty == null || toNumber(policy.orderQuantityQty) <= 0) {
      errors.push('Q/ROP requires a positive fixed order quantity.');
    }
  }

  if (normalizedPolicyType === 'min_max') {
    if (policy.orderUpToLevelQty == null) {
      errors.push('Min-Max requires orderUpToLevelQty.');
    }
    if (
      policy.orderUpToLevelQty != null &&
      effectiveReorderPoint.value != null &&
      toNumber(policy.orderUpToLevelQty) < effectiveReorderPoint.value
    ) {
      errors.push('Min-Max order-up-to level must be greater than or equal to the reorder point.');
    }
  }

  if (
    policy.maxOrderQty != null &&
    policy.minOrderQty != null &&
    toNumber(policy.maxOrderQty) < toNumber(policy.minOrderQty)
  ) {
    errors.push('Max order quantity must be greater than or equal to min order quantity.');
  }

  if (policy.leadTimeDays != null && toNumber(policy.leadTimeDays) < 0) {
    errors.push('Lead time days must be nonnegative.');
  }
  if (policy.demandRatePerDay != null && toNumber(policy.demandRatePerDay) < 0) {
    errors.push('Demand rate per day must be nonnegative.');
  }
  if (policy.safetyStockQty != null && toNumber(policy.safetyStockQty) < 0) {
    errors.push('Safety stock quantity must be nonnegative.');
  }
  if (policy.reorderPointQty != null && toNumber(policy.reorderPointQty) < 0) {
    errors.push('Reorder point must be nonnegative.');
  }

  return errors;
}

function applyMinMax(qty: number, minOrderQty: number | null, maxOrderQty: number | null): number {
  let result = roundQuantity(Math.max(0, qty));
  if (result <= 0) return 0;
  if (minOrderQty !== null && result < minOrderQty) {
    result = minOrderQty;
  }
  if (maxOrderQty !== null && result > maxOrderQty) {
    result = maxOrderQty;
  }
  return roundQuantity(Math.max(0, result));
}

export function computeInventoryPosition(input: ReplenishmentInventoryPositionInput): number {
  // invariant: negative inventoryPosition is allowed
  // and represents unmet demand; must not be hidden.
  // extreme negative inventoryPosition indicates data inconsistency.
  // recommendation math remains read-only in this patch; execution paths must
  // add bounded-decision controls before acting on it.
  return roundQuantity(
    toNumber(input.usableOnHand) +
      toNumber(input.onOrder) +
      toNumber(input.inTransit) -
      (toNumber(input.reservedCommitment) + toNumber(input.backorderedQty))
  );
}

export function computeRecommendedOrderQty(params: {
  policy: ReplenishmentPolicyLike;
  normalizedPolicyType: NormalizedPolicyType;
  inventoryPosition: number;
  reorderPoint: number;
}): number {
  const minOrderQty =
    params.policy.minOrderQty !== null && params.policy.minOrderQty !== undefined
      ? Math.max(0, toNumber(params.policy.minOrderQty))
      : null;
  const maxOrderQty =
    params.policy.maxOrderQty !== null && params.policy.maxOrderQty !== undefined
      ? Math.max(0, toNumber(params.policy.maxOrderQty))
      : null;

  if (params.normalizedPolicyType === 'q_rop') {
    return applyMinMax(
      Math.max(0, toNumber(params.policy.orderQuantityQty)),
      minOrderQty,
      maxOrderQty
    );
  }

  return applyMinMax(
    Math.max(0, toNumber(params.policy.orderUpToLevelQty) - toNumber(params.inventoryPosition)),
    minOrderQty,
    maxOrderQty
  );
}
