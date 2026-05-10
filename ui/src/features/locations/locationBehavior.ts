import type { Location } from '../../api/types'

export type PersistedLocationRole =
  | 'SELLABLE'
  | 'QA'
  | 'HOLD'
  | 'REJECT'
  | 'SCRAP'
  | 'RM_STORE'
  | 'WIP'
  | 'PACKAGING'
  | 'FG_STAGE'
  | 'FG_SELLABLE'

export type LocationBehaviorRole =
  | 'receiving'
  | 'raw_material_store'
  | 'packaging_store'
  | 'production_wip'
  | 'finished_goods'
  | 'shipping'
  | 'general_sellable'
  | 'quality_hold'
  | 'reject_scrap'
  | 'warehouse_root'

export type LocationCapabilities = {
  canReceiveInventory: boolean
  canStoreRawMaterials: boolean
  canStorePackaging: boolean
  canConsumeForProduction: boolean
  canHoldFinishedGoods: boolean
  canReserveForSales: boolean
  canShipFrom: boolean
}

export type LocationBehavior = {
  behaviorRole: LocationBehaviorRole
  roleLabel: string
  persistedRoleLabel: string
  capabilities: LocationCapabilities
  isTechnicallySellable: boolean
  hasProductionReservationLimitation: boolean
  technicalStateLabel: string
  technicalStateDescription: string
}

export const LOCATION_BEHAVIOR_ROLE_OPTIONS: Array<{
  value: LocationBehaviorRole
  label: string
  description: string
}> = [
  {
    value: 'receiving',
    label: 'Receiving',
    description: 'Inbound receipt or intake location.',
  },
  {
    value: 'raw_material_store',
    label: 'Raw material store',
    description: 'Component inventory for production consumption.',
  },
  {
    value: 'packaging_store',
    label: 'Packaging store',
    description: 'Packaging component inventory.',
  },
  {
    value: 'production_wip',
    label: 'Production / WIP',
    description: 'Work-in-process or production staging.',
  },
  {
    value: 'finished_goods',
    label: 'Finished goods',
    description: 'Finished inventory staging or storage.',
  },
  {
    value: 'shipping',
    label: 'Shipping',
    description: 'Outbound shipping or dispatch location.',
  },
  {
    value: 'general_sellable',
    label: 'General storage / sellable',
    description: 'General reservable inventory location.',
  },
  {
    value: 'quality_hold',
    label: 'Quality inspection / hold',
    description: 'Quality, quarantine, or hold workflow location.',
  },
  {
    value: 'reject_scrap',
    label: 'Rejected / scrap',
    description: 'Rejected or scrapped inventory location.',
  },
]

const PERSISTED_ROLE_LABELS: Record<string, string> = {
  SELLABLE: 'Reservable inventory',
  QA: 'Quality inspection',
  HOLD: 'Hold / receiving',
  REJECT: 'Rejected inventory',
  SCRAP: 'Scrap',
  RM_STORE: 'Raw material store',
  WIP: 'Production / WIP',
  PACKAGING: 'Packaging store',
  FG_STAGE: 'Finished goods staging',
  FG_SELLABLE: 'Finished goods reservable',
}

const BEHAVIOR_ROLE_LABELS: Record<LocationBehaviorRole, string> = {
  receiving: 'Receiving',
  raw_material_store: 'Raw material store',
  packaging_store: 'Packaging store',
  production_wip: 'Production / WIP',
  finished_goods: 'Finished goods',
  shipping: 'Shipping',
  general_sellable: 'General storage / sellable',
  quality_hold: 'Quality inspection / hold',
  reject_scrap: 'Rejected / scrap',
  warehouse_root: 'Warehouse root',
}

function hasAnyToken(location: Location, tokens: string[]) {
  const text = `${location.code ?? ''} ${location.name ?? ''} ${location.path ?? ''}`.toLowerCase()
  return tokens.some((token) => text.includes(token))
}

function isRawMaterialStore(location: Location) {
  return hasAnyToken(location, ['rm_store', 'raw material', 'raw-material'])
}

function isReceivingLocation(location: Location) {
  return hasAnyToken(location, ['recv', 'receiving', 'receipt'])
}

function isShippingLocation(location: Location) {
  return hasAnyToken(location, ['ship', 'dispatch'])
}

function isFinishedGoodsLocation(location: Location) {
  return hasAnyToken(location, ['fg_', 'finished goods', 'finished-good'])
}

export function isSellablePersistedRole(role: string | null | undefined) {
  return role === 'SELLABLE' || role === 'FG_SELLABLE'
}

export function inferLocationBehaviorRole(location: Location): LocationBehaviorRole {
  if (location.type === 'warehouse') return 'warehouse_root'
  if (isRawMaterialStore(location)) return 'raw_material_store'
  if (isShippingLocation(location)) return 'shipping'
  if (isReceivingLocation(location)) return 'receiving'
  if (isFinishedGoodsLocation(location) && location.role === 'FG_SELLABLE') return 'finished_goods'

  switch (location.role) {
    case 'RM_STORE':
      return 'raw_material_store'
    case 'PACKAGING':
      return 'packaging_store'
    case 'WIP':
      return 'production_wip'
    case 'FG_STAGE':
    case 'FG_SELLABLE':
      return 'finished_goods'
    case 'QA':
    case 'HOLD':
      return 'quality_hold'
    case 'REJECT':
    case 'SCRAP':
      return 'reject_scrap'
    case 'SELLABLE':
    default:
      return location.isSellable ? 'general_sellable' : 'quality_hold'
  }
}

export function defaultCapabilitiesForBehaviorRole(
  behaviorRole: LocationBehaviorRole,
  isTechnicallySellable = false,
): LocationCapabilities {
  return {
    canReceiveInventory: behaviorRole === 'receiving' || behaviorRole === 'quality_hold',
    canStoreRawMaterials: behaviorRole === 'raw_material_store',
    canStorePackaging: behaviorRole === 'packaging_store',
    canConsumeForProduction: behaviorRole === 'raw_material_store' || behaviorRole === 'production_wip',
    canHoldFinishedGoods:
      behaviorRole === 'finished_goods' || behaviorRole === 'shipping' || behaviorRole === 'general_sellable',
    canReserveForSales: isTechnicallySellable || behaviorRole === 'shipping' || behaviorRole === 'general_sellable',
    canShipFrom: behaviorRole === 'shipping',
  }
}

export function deriveLocationBehavior(location: Location): LocationBehavior {
  const behaviorRole = inferLocationBehaviorRole(location)
  const isTechnicallySellable = Boolean(location.isSellable)
  const capabilities = defaultCapabilitiesForBehaviorRole(behaviorRole, isTechnicallySellable)
  if (isTechnicallySellable) {
    capabilities.canReserveForSales = true
  }

  const hasProductionReservationLimitation =
    isTechnicallySellable &&
    (behaviorRole === 'raw_material_store' || capabilities.canConsumeForProduction) &&
    !capabilities.canHoldFinishedGoods &&
    !capabilities.canShipFrom

  return {
    behaviorRole,
    roleLabel: BEHAVIOR_ROLE_LABELS[behaviorRole],
    persistedRoleLabel: location.role ? PERSISTED_ROLE_LABELS[location.role] ?? location.role : 'None',
    capabilities,
    isTechnicallySellable,
    hasProductionReservationLimitation,
    technicalStateLabel: isTechnicallySellable ? 'Reservable inventory enabled' : 'Reservable inventory disabled',
    technicalStateDescription: isTechnicallySellable
      ? 'This location can be used by reservation-backed workflows.'
      : 'This location is not available to reservation-backed workflows.',
  }
}

export function buildLocationBehaviorPayload(
  behaviorRole: LocationBehaviorRole,
  capabilities: LocationCapabilities,
  currentPersistedRole?: string | null,
): { role: PersistedLocationRole | null; isSellable: boolean; error?: string } {
  if (behaviorRole === 'warehouse_root') {
    return { role: null, isSellable: false }
  }

  if (
    capabilities.canReserveForSales &&
    (behaviorRole === 'receiving' ||
      behaviorRole === 'quality_hold' ||
      behaviorRole === 'packaging_store' ||
      behaviorRole === 'production_wip' ||
      behaviorRole === 'reject_scrap')
  ) {
    return {
      role: null,
      isSellable: false,
      error: 'This capability combination is not supported by the current backend roles. Choose Raw material store, Finished goods, Shipping, or General storage / sellable for reservable inventory.',
    }
  }

  switch (behaviorRole) {
    case 'receiving':
      return { role: 'HOLD', isSellable: false }
    case 'raw_material_store':
      return capabilities.canReserveForSales
        ? { role: 'SELLABLE', isSellable: true }
        : { role: 'RM_STORE', isSellable: false }
    case 'packaging_store':
      return { role: 'PACKAGING', isSellable: false }
    case 'production_wip':
      return { role: 'WIP', isSellable: false }
    case 'finished_goods':
      return capabilities.canReserveForSales
        ? { role: 'FG_SELLABLE', isSellable: true }
        : { role: 'FG_STAGE', isSellable: false }
    case 'shipping':
      return { role: 'FG_SELLABLE', isSellable: true }
    case 'general_sellable':
      return { role: 'SELLABLE', isSellable: true }
    case 'quality_hold':
      return { role: currentPersistedRole === 'HOLD' ? 'HOLD' : 'QA', isSellable: false }
    case 'reject_scrap':
      return { role: currentPersistedRole === 'REJECT' ? 'REJECT' : 'SCRAP', isSellable: false }
    default:
      return { role: 'SELLABLE', isSellable: true }
  }
}

export const CAPABILITY_LABELS: Array<{ key: keyof LocationCapabilities; label: string }> = [
  { key: 'canReceiveInventory', label: 'Can receive inventory' },
  { key: 'canStoreRawMaterials', label: 'Can store raw materials' },
  { key: 'canStorePackaging', label: 'Can store packaging' },
  { key: 'canConsumeForProduction', label: 'Can consume for production' },
  { key: 'canHoldFinishedGoods', label: 'Can hold finished goods' },
  { key: 'canReserveForSales', label: 'Reservable inventory' },
  { key: 'canShipFrom', label: 'Can ship from' },
]

// Roles where the user can independently toggle the reservable-inventory state.
// For all other roles, isSellable is fixed (either always true or always false).
export const RESERVABLE_EDITABLE_ROLES: ReadonlySet<LocationBehaviorRole> = new Set<LocationBehaviorRole>([
  'raw_material_store',
  'finished_goods',
])

export function isReservableEditable(role: LocationBehaviorRole): boolean {
  return RESERVABLE_EDITABLE_ROLES.has(role)
}
