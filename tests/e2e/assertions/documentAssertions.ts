import { expect } from '@playwright/test';
import type { E2EApiClient } from '../fixtures/apiClient';

type DocType =
  | 'purchaseOrder'
  | 'receipt'
  | 'putaway'
  | 'reservation'
  | 'shipment'
  | 'salesOrder'
  | 'movement';

type StatusExpectation = string | string[];

function assertExpectedStatus(actual: string | null | undefined, expected: StatusExpectation) {
  const normalized = actual ?? '';
  if (Array.isArray(expected)) {
    expect(expected).toContain(normalized);
    return;
  }
  expect(normalized).toBe(expected);
}

export async function expectDocumentStatus(args: {
  api: E2EApiClient;
  type: DocType;
  id: string;
  expected: StatusExpectation;
  warehouseId?: string;
}) {
  let response: Record<string, unknown>;

  switch (args.type) {
    case 'purchaseOrder':
      response = await args.api.get<Record<string, unknown>>(`/purchase-orders/${args.id}`);
      assertExpectedStatus(response.status as string, args.expected);
      return response;

    case 'receipt':
      response = await args.api.get<Record<string, unknown>>(`/purchase-order-receipts/${args.id}`);
      assertExpectedStatus(response.status as string, args.expected);
      return response;

    case 'putaway':
      response = await args.api.get<Record<string, unknown>>(`/putaways/${args.id}`);
      assertExpectedStatus(response.status as string, args.expected);
      return response;

    case 'reservation': {
      if (!args.warehouseId) {
        throw new Error('warehouseId is required for reservation status assertions.');
      }
      response = await args.api.get<Record<string, unknown>>(`/reservations/${args.id}`, {
        params: { warehouseId: args.warehouseId }
      });
      assertExpectedStatus(response.status as string, args.expected);
      return response;
    }

    case 'shipment':
      response = await args.api.get<Record<string, unknown>>(`/shipments/${args.id}`);
      assertExpectedStatus((response.status as string | null | undefined) ?? 'posted', args.expected);
      return response;

    case 'salesOrder':
      response = await args.api.get<Record<string, unknown>>(`/sales-orders/${args.id}`);
      assertExpectedStatus(response.status as string, args.expected);
      return response;

    case 'movement':
      response = await args.api.get<Record<string, unknown>>(`/inventory-movements/${args.id}`);
      assertExpectedStatus(response.status as string, args.expected);
      return response;

    default:
      throw new Error(`Unsupported document type: ${(args as { type: string }).type}`);
  }
}
