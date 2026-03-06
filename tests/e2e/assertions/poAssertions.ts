import { expect } from '@playwright/test';
import type { E2EApiClient } from '../fixtures/apiClient';

type PurchaseOrderLine = {
  id: string;
  quantityOrdered: number;
  quantityReceived: number;
  status: string;
};

type PurchaseOrderDocument = {
  id: string;
  status: string;
  lines: PurchaseOrderLine[];
};

const PO_MATH_POLL_TIMEOUT_MS = 15_000;
const PO_MATH_POLL_INTERVALS_MS = [300, 600];

function normalize(value: number): number {
  return Number(value.toFixed(6));
}

export async function expectPurchaseOrderLineMath(args: {
  api: E2EApiClient;
  purchaseOrderId: string;
  lineId: string;
  expectedOrdered: number;
  expectedReceivedTotal: number;
}) {
  const expectedRemaining = normalize(args.expectedOrdered - args.expectedReceivedTotal);
  const expectedPoStatus = expectedRemaining > 0 ? 'partially_received' : 'received';
  const expectedLineStatus = expectedRemaining > 0 ? 'open' : 'complete';

  let lastObserved:
    | {
        purchaseOrderStatus: string;
        lineStatus: string;
        ordered: number;
        received: number;
        remaining: number;
      }
    | null = null;

  try {
    await expect
      .poll(
        async () => {
          const purchaseOrder = await args.api.get<PurchaseOrderDocument>(`/purchase-orders/${args.purchaseOrderId}`);
          const line = purchaseOrder.lines?.find((entry) => entry.id === args.lineId);
          if (!line) {
            throw new Error(
              `PO line ${args.lineId} not found in purchase order ${args.purchaseOrderId}.`
            );
          }

          const ordered = Number(line.quantityOrdered);
          const received = Number(line.quantityReceived);
          const remaining = normalize(ordered - received);

          lastObserved = {
            purchaseOrderStatus: purchaseOrder.status,
            lineStatus: line.status,
            ordered: normalize(ordered),
            received: normalize(received),
            remaining
          };

          return {
            ordered: normalize(ordered),
            received: normalize(received),
            remaining,
            purchaseOrderStatus: purchaseOrder.status,
            lineStatus: line.status
          };
        },
        {
          timeout: PO_MATH_POLL_TIMEOUT_MS,
          intervals: PO_MATH_POLL_INTERVALS_MS,
          message: `PO line math did not converge for purchaseOrder=${args.purchaseOrderId} line=${args.lineId}`
        }
      )
      .toMatchObject({
        ordered: normalize(args.expectedOrdered),
        received: normalize(args.expectedReceivedTotal),
        remaining: expectedRemaining,
        purchaseOrderStatus: expectedPoStatus,
        lineStatus: expectedLineStatus
      });
  } catch (error) {
    throw new Error(
      [
        `PO line math assertion failed for purchaseOrder=${args.purchaseOrderId} line=${args.lineId}.`,
        `Expected ordered=${normalize(args.expectedOrdered)}, received=${normalize(args.expectedReceivedTotal)},`,
        `remaining=${expectedRemaining}, purchaseOrderStatus=${expectedPoStatus}, lineStatus=${expectedLineStatus}.`,
        `LastObserved=${JSON.stringify(lastObserved)}.`,
        `OriginalError=${error instanceof Error ? error.message : String(error)}`
      ].join(' ')
    );
  }

  if (!lastObserved) {
    throw new Error(
      [
        `PO line math assertion failed for purchaseOrder=${args.purchaseOrderId} line=${args.lineId}.`,
        'No observation captured during polling.'
      ].join(' ')
    );
  }

  return lastObserved;
}
