export const WORK_ORDER_PRODUCTION_CONSUME_LOCATION_ROLES = Object.freeze([
  'RM_STORE',
  'WIP',
  'PACKAGING',
  'FG_STAGE'
] as const);

export const WORK_ORDER_DISASSEMBLY_CONSUME_LOCATION_ROLES = Object.freeze([
  'WIP',
  'FG_STAGE'
] as const);

const WORK_ORDER_PRODUCTION_CONSUME_LOCATION_ROLE_SET = new Set<string>(
  WORK_ORDER_PRODUCTION_CONSUME_LOCATION_ROLES
);
const WORK_ORDER_DISASSEMBLY_CONSUME_LOCATION_ROLE_SET = new Set<string>(
  WORK_ORDER_DISASSEMBLY_CONSUME_LOCATION_ROLES
);

export function isSellableFulfillmentLocationRole(role: string | null | undefined) {
  return role === 'SELLABLE' || role === 'FG_SELLABLE';
}

export function isValidProductionWorkOrderConsumeLocationRole(role: string | null | undefined) {
  return typeof role === 'string' && WORK_ORDER_PRODUCTION_CONSUME_LOCATION_ROLE_SET.has(role);
}

export function isValidDisassemblyWorkOrderConsumeLocationRole(role: string | null | undefined) {
  return typeof role === 'string' && WORK_ORDER_DISASSEMBLY_CONSUME_LOCATION_ROLE_SET.has(role);
}

export function isProductionWorkOrderConsumeLocationAllowed(location: {
  role: string | null | undefined;
  isSellable: boolean;
}) {
  return isValidProductionWorkOrderConsumeLocationRole(location.role)
    || isSellableFulfillmentLocationRole(location.role)
    || location.isSellable === true;
}

export function isDisassemblyWorkOrderConsumeLocationAllowed(location: {
  role: string | null | undefined;
  isSellable: boolean;
}) {
  return isValidDisassemblyWorkOrderConsumeLocationRole(location.role)
    || isSellableFulfillmentLocationRole(location.role)
    || location.isSellable === true;
}

export function isWorkOrderConsumeLocationAllowedForKind(
  kind: string | null | undefined,
  location: {
    role: string | null | undefined;
    isSellable: boolean;
  }
) {
  return kind === 'disassembly'
    ? isDisassemblyWorkOrderConsumeLocationAllowed(location)
    : isProductionWorkOrderConsumeLocationAllowed(location);
}

export const WORK_ORDER_CONSUME_LOCATION_ROLES = WORK_ORDER_PRODUCTION_CONSUME_LOCATION_ROLES;
export const isValidWorkOrderConsumeLocationRole = isValidProductionWorkOrderConsumeLocationRole;
export const isWorkOrderConsumeLocationAllowed = isProductionWorkOrderConsumeLocationAllowed;
