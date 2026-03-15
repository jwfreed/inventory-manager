import type { ApiError } from '../../../api/types'

const SHIPMENT_ERROR_MESSAGES: Record<string, string> = {
  WAREHOUSE_SCOPE_REQUIRED:
    'The sales order and ship-from location must both resolve to one warehouse scope before a shipment can be created or posted.',
  WAREHOUSE_SCOPE_MISMATCH:
    'The selected ship-from location is outside the sales order warehouse. Choose a location in the same warehouse and retry.',
  SHIPMENT_NO_LINES:
    'Add at least one shipment line with a quantity greater than zero before posting.',
  SHIPMENT_INVALID_QUANTITY:
    'Shipment quantities must be greater than zero.',
  SHIPMENT_LOCATION_REQUIRED:
    'Assign a ship-from location before posting the shipment.',
  INSUFFICIENT_STOCK:
    'Insufficient available stock remains to post this shipment. Replenish stock or reduce shipment quantities before retrying.',
  REPLAY_CORRUPTION_DETECTED:
    'Shipment replay integrity failed closed. Review the linked movement ledger before retrying this post.',
  NEGATIVE_OVERRIDE_NOT_ALLOWED:
    'Negative override is not available from the shipment screen. Resolve the shortage before posting.',
}

function extractShipmentErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null
  const apiErr = err as ApiError
  if (apiErr.details && typeof apiErr.details === 'object') {
    const details = apiErr.details as {
      code?: unknown
      error?: { code?: unknown }
    }
    if (typeof details.error?.code === 'string') return details.error.code
    if (typeof details.code === 'string') return details.code
  }
  if (typeof apiErr.message === 'string' && /^[A-Z0-9_]+$/.test(apiErr.message)) {
    return apiErr.message
  }
  return null
}

export function formatShipmentError(err: unknown, fallback: string) {
  const code = extractShipmentErrorCode(err)
  if (code && SHIPMENT_ERROR_MESSAGES[code]) {
    return SHIPMENT_ERROR_MESSAGES[code]
  }
  if (typeof err === 'string') return err
  if (err instanceof Error && err.message) return err.message
  const apiErr = err as ApiError
  if (typeof apiErr?.message === 'string') return apiErr.message
  return fallback
}
