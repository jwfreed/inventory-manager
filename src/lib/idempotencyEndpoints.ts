export const IDEMPOTENCY_ENDPOINTS = Object.freeze({
  PURCHASE_ORDER_RECEIPTS_CREATE: 'receipts.post',
  PURCHASE_ORDER_RECEIPTS_VOID: 'receipts.void',
  INVENTORY_COUNTS_POST: 'inventory_counts.post',
  INVENTORY_ADJUSTMENTS_POST: 'inventory_adjustments.post',
  LICENSE_PLATES_MOVE: 'license_plates.move',
  INVENTORY_TRANSFERS_CREATE: 'transfers.post',
  INVENTORY_TRANSFERS_VOID: 'transfers.void',
  QC_EVENTS_CREATE: 'qc_events.post',
  QC_WAREHOUSE_ACCEPT: 'qc.accept_warehouse_disposition',
  QC_WAREHOUSE_REJECT: 'qc.reject_warehouse_disposition',
  RESERVATIONS_CREATE: 'otc.create_reservations',
  RESERVATIONS_ALLOCATE: 'otc.allocate_reservation',
  RESERVATIONS_CANCEL: 'otc.cancel_reservation',
  RESERVATIONS_FULFILL: 'otc.fulfill_reservation',
  SHIPMENTS_POST: 'otc.post_shipment',
  RETURN_RECEIPTS_POST: 'returns.post_return_receipt',
  RETURN_DISPOSITIONS_POST: 'returns.post_return_disposition',
  WORK_ORDER_REPORT_PRODUCTION: 'wo.report_production',
  WORK_ORDER_RECORD_BATCH: 'wo.record_batch',
  WORK_ORDER_VOID_REPORT_PRODUCTION: 'wo.void_report_production',
  WORK_ORDER_REPORT_SCRAP: 'wo.report_scrap'
} as const);

export type IdempotencyEndpoint = (typeof IDEMPOTENCY_ENDPOINTS)[keyof typeof IDEMPOTENCY_ENDPOINTS];
