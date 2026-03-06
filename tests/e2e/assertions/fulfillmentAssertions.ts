import { expect } from '@playwright/test';
import type { E2EApiClient } from '../fixtures/apiClient';

type ShipmentLine = {
  id: string;
  salesOrderLineId: string;
  uom: string;
  quantityShipped: number;
};

type ShipmentDocument = {
  id: string;
  status?: string | null;
  inventoryMovementId?: string | null;
  lines?: ShipmentLine[];
};

type ReservationDocument = {
  id: string;
  status?: string | null;
  quantityReserved: number;
  quantityFulfilled?: number | null;
};

type MovementLine = {
  id: string;
  itemId: string;
  locationId: string;
  quantityDelta: number;
};

const POLL_TIMEOUT_MS = 15_000;
const POLL_INTERVALS_MS = [300, 600];

function normalize(value: number): number {
  return Number(value.toFixed(6));
}

function openQuantity(quantityReserved: number, quantityFulfilled: number): number {
  return normalize(Math.max(0, normalize(quantityReserved) - normalize(quantityFulfilled)));
}

export async function expectShipmentLineMath(args: {
  api: E2EApiClient;
  shipmentId: string;
  allocatedOpenAtShip: number;
  expectedTotalShipped?: number;
}) {
  const shipment = await args.api.get<ShipmentDocument>(`/shipments/${args.shipmentId}`);
  const lines = shipment.lines ?? [];
  if (lines.length === 0) {
    throw new Error(`Shipment ${args.shipmentId} returned no lines.`);
  }

  const totalShipped = normalize(
    lines.reduce((sum, line) => sum + Number(line.quantityShipped ?? 0), 0)
  );
  const allocatedOpenAtShip = normalize(args.allocatedOpenAtShip);

  expect(
    totalShipped,
    [
      `Shipment quantity exceeded allocated-open commitment.`,
      `shipmentId=${args.shipmentId}`,
      `totalShipped=${totalShipped}`,
      `allocatedOpenAtShip=${allocatedOpenAtShip}`
    ].join(' ')
  ).toBeLessThanOrEqual(allocatedOpenAtShip);

  if (args.expectedTotalShipped !== undefined) {
    expect(
      totalShipped,
      `Shipment shipped total mismatch for shipmentId=${args.shipmentId}`
    ).toBe(normalize(args.expectedTotalShipped));
  }

  return {
    shipmentStatus: shipment.status ?? null,
    inventoryMovementId: shipment.inventoryMovementId ?? null,
    totalShipped,
    lines
  };
}

export async function expectReservationFulfillment(args: {
  api: E2EApiClient;
  reservationId: string;
  warehouseId: string;
  expectedStatus: string;
  expectedQuantityReserved: number;
  expectedQuantityFulfilled: number;
  expectedOpenQuantity: number;
}) {
  let lastObserved:
    | {
        status: string;
        quantityReserved: number;
        quantityFulfilled: number;
        openQuantity: number;
      }
    | null = null;

  try {
    await expect
      .poll(
        async () => {
          const reservation = await args.api.get<ReservationDocument>(`/reservations/${args.reservationId}`, {
            params: { warehouseId: args.warehouseId }
          });

          const status =
            typeof reservation.status === 'string' && reservation.status.trim().length > 0
              ? reservation.status.trim()
              : '<empty>';
          const quantityReserved = normalize(Number(reservation.quantityReserved ?? 0));
          const quantityFulfilled = normalize(Number(reservation.quantityFulfilled ?? 0));
          if (quantityFulfilled - quantityReserved > 1e-6) {
            throw new Error(
              [
                `Reservation quantities are invalid for reservation=${args.reservationId}.`,
                `warehouseId=${args.warehouseId}`,
                `quantityFulfilled=${quantityFulfilled}`,
                `quantityReserved=${quantityReserved}`
              ].join(' ')
            );
          }
          const open = openQuantity(quantityReserved, quantityFulfilled);

          lastObserved = {
            status,
            quantityReserved,
            quantityFulfilled,
            openQuantity: open
          };

          return lastObserved;
        },
        {
          timeout: POLL_TIMEOUT_MS,
          intervals: POLL_INTERVALS_MS,
          message: `Reservation fulfillment did not converge for reservation=${args.reservationId} warehouse=${args.warehouseId}`
        }
      )
      .toMatchObject({
        status: args.expectedStatus,
        quantityReserved: normalize(args.expectedQuantityReserved),
        quantityFulfilled: normalize(args.expectedQuantityFulfilled),
        openQuantity: normalize(args.expectedOpenQuantity)
      });
  } catch (error) {
    throw new Error(
      [
        `Reservation fulfillment assertion failed for reservation=${args.reservationId}.`,
        `warehouseId=${args.warehouseId}.`,
        `Expected status=${args.expectedStatus}, reserved=${normalize(args.expectedQuantityReserved)},`,
        `fulfilled=${normalize(args.expectedQuantityFulfilled)}, open=${normalize(args.expectedOpenQuantity)}.`,
        `LastObserved=${JSON.stringify(lastObserved)}.`,
        `OriginalError=${error instanceof Error ? error.message : String(error)}`
      ].join(' ')
    );
  }

  if (!lastObserved) {
    throw new Error(`Reservation fulfillment produced no observation for reservation=${args.reservationId}.`);
  }

  return lastObserved;
}

export async function expectMovementLineNetDelta(args: {
  api: E2EApiClient;
  movementId: string;
  expectedNetDelta: number;
  expectedLineDeltas?: Array<{
    itemId: string;
    locationId: string;
    expectedDelta: number;
  }>;
}) {
  type PollShape = {
    netDelta: number;
    expectedLineDeltas: Array<{ key: string; observed: number }>;
    unexpectedLineDeltas: Array<{ key: string; observed: number }>;
  };

  let lastObserved: PollShape | null = null;
  let latestLines: MovementLine[] = [];

  try {
    await expect
      .poll(
        async () => {
          const response = await args.api.get<{ data: MovementLine[] }>(
            `/inventory-movements/${args.movementId}/lines`
          );
          const lines = response.data ?? [];
          latestLines = lines;

          const netDelta = normalize(
            lines.reduce((sum, line) => sum + Number(line.quantityDelta ?? 0), 0)
          );
          const lineTotalsByKey = lines.reduce((map, line) => {
            const key = `${line.itemId}:${line.locationId}`;
            map.set(key, normalize((map.get(key) ?? 0) + Number(line.quantityDelta ?? 0)));
            return map;
          }, new Map<string, number>());
          const expectedKeys = new Set(
            (args.expectedLineDeltas ?? []).map((expected) => `${expected.itemId}:${expected.locationId}`)
          );
          const expectedLineDeltas = (args.expectedLineDeltas ?? []).map((expected) => {
            const key = `${expected.itemId}:${expected.locationId}`;
            const observed = normalize(lineTotalsByKey.get(key) ?? 0);
            return {
              key,
              observed
            };
          });
          const unexpectedLineDeltas = args.expectedLineDeltas && args.expectedLineDeltas.length > 0
            ? Array.from(lineTotalsByKey.entries())
                .filter(([key, observed]) => !expectedKeys.has(key) && Math.abs(observed) > 1e-6)
                .sort((left, right) => left[0].localeCompare(right[0]))
                .map(([key, observed]) => ({
                  key,
                  observed: normalize(observed)
                }))
            : [];

          lastObserved = { netDelta, expectedLineDeltas, unexpectedLineDeltas };
          return lastObserved;
        },
        {
          timeout: POLL_TIMEOUT_MS,
          intervals: POLL_INTERVALS_MS,
          message: `Movement line deltas did not converge for movement=${args.movementId}`
        }
      )
      .toMatchObject({
        netDelta: normalize(args.expectedNetDelta),
        expectedLineDeltas: (args.expectedLineDeltas ?? []).map((expected) => ({
          key: `${expected.itemId}:${expected.locationId}`,
          observed: normalize(expected.expectedDelta)
        })),
        ...(args.expectedLineDeltas && args.expectedLineDeltas.length > 0
          ? { unexpectedLineDeltas: [] }
          : {})
      });
  } catch (error) {
    throw new Error(
      [
        `Movement line delta assertion failed for movement=${args.movementId}.`,
        `ExpectedNetDelta=${normalize(args.expectedNetDelta)}.`,
        `ExpectedLineDeltas=${JSON.stringify(args.expectedLineDeltas ?? [])}.`,
        `LastObserved=${JSON.stringify(lastObserved)}.`,
        `Lines=${JSON.stringify(latestLines)}.`,
        `OriginalError=${error instanceof Error ? error.message : String(error)}`
      ].join(' ')
    );
  }

  if (!lastObserved) {
    throw new Error(`Movement line assertion produced no observation for movement=${args.movementId}.`);
  }

  return {
    ...lastObserved,
    lines: latestLines
  };
}
