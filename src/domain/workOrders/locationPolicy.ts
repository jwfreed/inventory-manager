export const WORK_ORDER_CONSUME_LOCATION_ROLES = Object.freeze([
  'RM_STORE',
  'WIP',
  'PACKAGING',
  'FG_STAGE'
] as const);

const WORK_ORDER_CONSUME_LOCATION_ROLE_SET = new Set<string>(WORK_ORDER_CONSUME_LOCATION_ROLES);

export function isSellableFulfillmentLocationRole(role: string | null | undefined) {
  return role === 'SELLABLE' || role === 'FG_SELLABLE';
}

export function isValidWorkOrderConsumeLocationRole(role: string | null | undefined) {
  return typeof role === 'string' && WORK_ORDER_CONSUME_LOCATION_ROLE_SET.has(role);
}

export function isWorkOrderConsumeLocationAllowed(location: {
  role: string | null | undefined;
  isSellable: boolean;
}) {
  return isValidWorkOrderConsumeLocationRole(location.role)
    || isSellableFulfillmentLocationRole(location.role)
    || location.isSellable === true;
}
