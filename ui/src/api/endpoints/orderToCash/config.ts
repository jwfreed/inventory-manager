// Phase 4 Order-to-Cash runtime APIs are not implemented in this repository (DB-first only).
// Keep these as `null` until backend endpoints are added; UI will short-circuit to EmptyState
// instead of issuing 404 probes.
export const ORDER_TO_CASH_ENDPOINTS = {
  salesOrders: null as string | null,
  reservations: null as string | null,
  shipments: null as string | null,
  returns: null as string | null,
}
