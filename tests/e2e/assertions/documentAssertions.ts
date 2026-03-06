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

type StatusExpectation = string;

const STATUS_POLL_TIMEOUT_MS = 15_000;
const STATUS_POLL_INTERVALS_MS = [300, 600];
const RESPONSE_SNIPPET_MAX = 500;

function compactSnippet(payload: unknown): string {
  const raw = JSON.stringify(payload);
  if (!raw) return '<empty>';
  if (raw.length <= RESPONSE_SNIPPET_MAX) return raw;
  return `${raw.slice(0, RESPONSE_SNIPPET_MAX)}...`;
}

function extractStatus(args: { type: DocType; id: string; response: Record<string, unknown> }): string {
  const { response, type, id } = args;
  if (typeof response.status !== 'string' || response.status.trim().length === 0) {
    throw new Error(
      [
        `Document ${type}:${id} returned an empty status value.`,
        `Response snippet=${compactSnippet(response)}`
      ].join(' ')
    );
  }
  return response.status.trim();
}

async function fetchDocument(args: {
  api: E2EApiClient;
  type: DocType;
  id: string;
  warehouseId?: string;
}): Promise<Record<string, unknown>> {
  switch (args.type) {
    case 'purchaseOrder':
      return await args.api.get<Record<string, unknown>>(`/purchase-orders/${args.id}`);

    case 'receipt':
      return await args.api.get<Record<string, unknown>>(`/purchase-order-receipts/${args.id}`);

    case 'putaway':
      return await args.api.get<Record<string, unknown>>(`/putaways/${args.id}`);

    case 'reservation': {
      if (!args.warehouseId) {
        throw new Error('warehouseId is required for reservation status assertions.');
      }
      return await args.api.get<Record<string, unknown>>(`/reservations/${args.id}`, {
        params: { warehouseId: args.warehouseId }
      });
    }

    case 'shipment':
      return await args.api.get<Record<string, unknown>>(`/shipments/${args.id}`);

    case 'salesOrder':
      return await args.api.get<Record<string, unknown>>(`/sales-orders/${args.id}`);

    case 'movement':
      return await args.api.get<Record<string, unknown>>(`/inventory-movements/${args.id}`);

    default:
      throw new Error(`Unsupported document type: ${(args as { type: string }).type}`);
  }
}

export async function expectDocumentStatus(args: {
  api: E2EApiClient;
  type: DocType;
  id: string;
  expected: StatusExpectation;
  warehouseId?: string;
}) {
  let lastResponse: Record<string, unknown> | null = null;
  let lastObservedStatus: string | null = null;

  try {
    await expect
      .poll(
        async () => {
          const response = await fetchDocument(args);
          lastResponse = response;
          const status = extractStatus({ type: args.type, id: args.id, response });
          lastObservedStatus = status;
          return status;
        },
        {
          timeout: STATUS_POLL_TIMEOUT_MS,
          intervals: STATUS_POLL_INTERVALS_MS,
          message: `Status did not converge for ${args.type}:${args.id}`
        }
      )
      .toBe(args.expected);
  } catch (error) {
    throw new Error(
      [
        `Document status assertion failed for ${args.type}:${args.id}.`,
        `Expected=${args.expected}.`,
        `LastObserved=${lastObservedStatus ?? '<none>'}.`,
        `ResponseSnippet=${compactSnippet(lastResponse)}.`,
        `OriginalError=${error instanceof Error ? error.message : String(error)}`
      ].join(' ')
    );
  }

  return lastResponse ?? (await fetchDocument(args));
}
