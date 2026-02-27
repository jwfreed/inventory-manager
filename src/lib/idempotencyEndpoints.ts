export const IDEMPOTENCY_ENDPOINTS = Object.freeze({
  PURCHASE_ORDER_RECEIPTS_CREATE: '/purchase-order-receipts',
  PURCHASE_ORDER_RECEIPTS_VOID: '/purchase-order-receipts/:id/void',
  INVENTORY_TRANSFERS_CREATE: '/inventory-transfers',
  RESERVATIONS_CREATE: '/reservations',
  WORK_ORDER_REPORT_PRODUCTION: '/work-orders/:id/report-production',
  WORK_ORDER_RECORD_BATCH: '/work-orders/:id/record-batch',
  WORK_ORDER_VOID_REPORT_PRODUCTION: '/work-orders/:id/void-report-production',
  WORK_ORDER_REPORT_SCRAP: '/work-orders/:id/report-scrap'
} as const);

export type IdempotencyEndpoint = (typeof IDEMPOTENCY_ENDPOINTS)[keyof typeof IDEMPOTENCY_ENDPOINTS];
