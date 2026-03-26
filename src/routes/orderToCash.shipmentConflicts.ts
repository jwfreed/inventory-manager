import type { Response } from 'express';
import {
  jsonConflict,
  mapAtpConcurrencyExhausted,
  mapAtpInsufficientAvailable,
  mapTxRetryExhausted
} from './shared/inventoryMutationConflicts';

export function handlePostShipmentConflict(error: any, res: Response): boolean {
  if (error?.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS') {
    jsonConflict(
      res,
      'IDEMPOTENCY_REQUEST_IN_PROGRESS',
      'Shipment post already in progress.'
    );
    return true;
  }
  if (error?.code === 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD') {
    jsonConflict(
      res,
      'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD',
      'Idempotency key reused with a different shipment payload.'
    );
    return true;
  }
  if (error?.code === 'IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS') {
    jsonConflict(
      res,
      'IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS',
      'Idempotency key was already used for a different endpoint.'
    );
    return true;
  }
  if (mapAtpConcurrencyExhausted(error, res)) {
    return true;
  }
  if (mapTxRetryExhausted(error, res)) {
    return true;
  }
  if (mapAtpInsufficientAvailable(error, res)) {
    return true;
  }
  if (error?.code === 'INSUFFICIENT_AVAILABLE_WITH_ALLOWANCE') {
    jsonConflict(
      res,
      'ATP_INSUFFICIENT_AVAILABLE',
      'Insufficient sellable inventory for shipment.',
      error?.details
    );
    return true;
  }
  if (error?.code === 'INSUFFICIENT_STOCK' || error?.message === 'INSUFFICIENT_STOCK') {
    jsonConflict(
      res,
      'ATP_INSUFFICIENT_AVAILABLE',
      'Insufficient sellable inventory for shipment.',
      error?.details
    );
    return true;
  }
  if (error?.code === 'NEGATIVE_OVERRIDE_REQUIRES_REASON') {
    jsonConflict(
      res,
      'NEGATIVE_OVERRIDE_REQUIRES_REASON',
      error?.details?.message ?? 'Negative override requires a reason.',
      error?.details
    );
    return true;
  }
  if (error?.message === 'SHIPMENT_CANCELED') {
    jsonConflict(
      res,
      'SHIPMENT_CANCELED',
      'Canceled shipments cannot be posted.'
    );
    return true;
  }
  if (error?.message === 'RESERVATION_INVALID_STATE') {
    jsonConflict(
      res,
      'RESERVATION_INVALID_STATE',
      'Reservation state changed while posting shipment. Please retry.'
    );
    return true;
  }
  if (error?.message === 'NON_SELLABLE_LOCATION') {
    jsonConflict(
      res,
      'NON_SELLABLE_LOCATION',
      'Shipment source location must be sellable.'
    );
    return true;
  }
  if (error?.message === 'CROSS_WAREHOUSE_LEAKAGE_BLOCKED') {
    jsonConflict(
      res,
      'CROSS_WAREHOUSE_LEAKAGE_BLOCKED',
      'Shipment warehouse scope does not match the sales order warehouse.'
    );
    return true;
  }
  if (error?.message === 'WAREHOUSE_SCOPE_MISMATCH') {
    jsonConflict(
      res,
      'WAREHOUSE_SCOPE_MISMATCH',
      'Shipment warehouse scope mismatch.'
    );
    return true;
  }
  return false;
}
