import { expect } from '@playwright/test';
import type { E2EApiClient } from '../fixtures/apiClient';

type ItemRecord = { id: string; sku: string };
type LocationRecord = { id: string; warehouseId?: string | null; role?: string | null; code: string };
type SnapshotRow = {
  itemId: string;
  locationId: string;
  uom: string;
  onHand: number;
  reserved: number;
  available: number;
  inTransit: number;
};

type ReservationRow = {
  id: string;
  status: string;
  itemId: string;
  locationId: string;
  warehouseId: string;
  quantityReserved: number;
  quantityFulfilled: number;
};

export type InventoryBucketExpectation = {
  api: E2EApiClient;
  sku: string;
  warehouseId: string;
  locationId?: string;
  locationRole?: 'SELLABLE' | 'QA' | 'HOLD' | 'REJECT' | 'SCRAP';
  uom?: string;
  onHand?: number;
  available?: number;
  inTransit?: number;
  reservedTotal?: number;
};

export type AllocatedExpectation = {
  api: E2EApiClient;
  sku: string;
  warehouseId: string;
  locationId: string;
  expectedAllocated: number;
};

export type ReservationCommitmentExpectation = {
  api: E2EApiClient;
  sku: string;
  warehouseId: string;
  locationId: string;
  expectedReservedOpen?: number;
  expectedAllocatedOpen?: number;
};

const ASSERTION_POLL_TIMEOUT_MS = 15_000;
const ASSERTION_POLL_INTERVALS_MS = [300, 600];

function normalize(value: number): number {
  return Number(value.toFixed(6));
}

type SnapshotPollResult = {
  ready: boolean;
  onHand: number;
  available: number;
  reserved: number;
  inTransit: number;
  uom: string;
};

function snapshotNotReady(uom?: string): SnapshotPollResult {
  return {
    ready: false,
    onHand: Number.NaN,
    available: Number.NaN,
    reserved: Number.NaN,
    inTransit: Number.NaN,
    uom: uom ?? ''
  };
}

function snapshotReady(row: SnapshotRow): SnapshotPollResult {
  return {
    ready: true,
    onHand: normalize(Number(row.onHand)),
    available: normalize(Number(row.available)),
    reserved: normalize(Number(row.reserved)),
    inTransit: normalize(Number(row.inTransit)),
    uom: row.uom
  };
}

async function findItemBySku(api: E2EApiClient, sku: string): Promise<ItemRecord> {
  const response = await api.get<{ data: ItemRecord[] }>('/items', {
    params: { search: sku, limit: 50, offset: 0 }
  });

  const item = response.data?.find((entry) => entry.sku === sku);
  if (!item) {
    throw new Error(`Item not found for SKU ${sku}.`);
  }
  return item;
}

async function resolveLocationId(args: {
  api: E2EApiClient;
  warehouseId: string;
  locationId?: string;
  locationRole?: string;
}): Promise<string> {
  if (args.locationId) {
    return args.locationId;
  }

  if (!args.locationRole) {
    throw new Error('Either locationId or locationRole must be provided for inventory assertions.');
  }

  const response = await args.api.get<{ data: LocationRecord[] }>('/locations', {
    params: { active: true, limit: 500, offset: 0 }
  });
  const match = response.data?.find(
    (location) => location.warehouseId === args.warehouseId && location.role === args.locationRole
  );

  if (!match) {
    throw new Error(
      `No ${args.locationRole} location found in warehouse ${args.warehouseId}.`
    );
  }

  return match.id;
}

async function getSnapshotRow(args: {
  api: E2EApiClient;
  itemId: string;
  warehouseId: string;
  locationId: string;
  uom?: string;
}): Promise<SnapshotRow> {
  const response = await args.api.get<{ data: SnapshotRow[] }>('/inventory-snapshot', {
    params: {
      warehouseId: args.warehouseId,
      itemId: args.itemId,
      locationId: args.locationId,
      ...(args.uom ? { uom: args.uom } : {})
    }
  });

  const rows = response.data ?? [];
  if (rows.length === 0) {
    throw new Error(
      `Inventory snapshot returned no rows for item=${args.itemId} location=${args.locationId}.`
    );
  }

  if (!args.uom) {
    return rows[0];
  }

  const byUom = rows.find((row) => row.uom === args.uom);
  if (!byUom) {
    throw new Error(
      `Inventory snapshot did not include requested uom=${args.uom}. Rows=${JSON.stringify(rows)}`
    );
  }
  return byUom;
}

async function listReservations(api: E2EApiClient, warehouseId: string): Promise<ReservationRow[]> {
  const response = await api.get<{ data: ReservationRow[] }>('/reservations', {
    params: { warehouseId, limit: 500, offset: 0 }
  });
  return response.data ?? [];
}

function openQuantity(reservation: ReservationRow): number {
  const reserved = normalize(Number(reservation.quantityReserved ?? 0));
  const fulfilled = normalize(Number(reservation.quantityFulfilled ?? 0));
  return normalize(Math.max(0, reserved - fulfilled));
}

async function computeReservationCommitments(args: {
  api: E2EApiClient;
  warehouseId: string;
  itemId: string;
  locationId: string;
}) {
  const reservations = await listReservations(args.api, args.warehouseId).then((rows) =>
    rows.filter((row) => row.itemId === args.itemId && row.locationId === args.locationId)
  );

  const reservedOpen = reservations
    .filter((reservation) => reservation.status === 'RESERVED')
    .reduce((total, reservation) => total + openQuantity(reservation), 0);

  const allocatedOpen = reservations
    .filter((reservation) => reservation.status === 'ALLOCATED')
    .reduce((total, reservation) => total + openQuantity(reservation), 0);

  return {
    reservedOpen: normalize(reservedOpen),
    allocatedOpen: normalize(allocatedOpen)
  };
}

export async function expectInventoryBuckets(input: InventoryBucketExpectation) {
  const item = await findItemBySku(input.api, input.sku);
  const locationId = await resolveLocationId({
    api: input.api,
    warehouseId: input.warehouseId,
    locationId: input.locationId,
    locationRole: input.locationRole
  });

  const expected: Partial<SnapshotPollResult> = { ready: true };
  if (input.onHand !== undefined) expected.onHand = normalize(input.onHand);
  if (input.available !== undefined) expected.available = normalize(input.available);
  if (input.inTransit !== undefined) expected.inTransit = normalize(input.inTransit);
  if (input.reservedTotal !== undefined) expected.reserved = normalize(input.reservedTotal);
  if (input.uom !== undefined) expected.uom = input.uom;

  let row: SnapshotRow | null = null;
  let lastObserved: SnapshotPollResult = snapshotNotReady(input.uom);
  try {
    await expect
      .poll(
        async () => {
          try {
            row = await getSnapshotRow({
              api: input.api,
              itemId: item.id,
              warehouseId: input.warehouseId,
              locationId,
              uom: input.uom
            });
            lastObserved = snapshotReady(row);
            return lastObserved;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const retriable =
              message.startsWith('Inventory snapshot returned no rows')
              || message.startsWith('Inventory snapshot did not include requested uom=');
            if (!retriable) {
              throw error;
            }
            row = null;
            lastObserved = snapshotNotReady(input.uom);
            return lastObserved;
          }
        },
        {
          timeout: ASSERTION_POLL_TIMEOUT_MS,
          intervals: ASSERTION_POLL_INTERVALS_MS,
          message: `Inventory buckets did not converge for sku=${input.sku}, warehouse=${input.warehouseId}, location=${locationId}`
        }
      )
      .toMatchObject(expected);
  } catch (error) {
    throw new Error(
      [
        `Inventory bucket assertion failed for sku=${input.sku}, warehouse=${input.warehouseId}, location=${locationId}.`,
        `Expected=${JSON.stringify(expected)}.`,
        `LastObserved=${JSON.stringify(lastObserved)}.`,
        `OriginalError=${error instanceof Error ? error.message : String(error)}`
      ].join(' ')
    );
  }

  if (!row) {
    throw new Error(
      `Inventory snapshot remained unavailable for sku=${input.sku}, warehouse=${input.warehouseId}, location=${locationId}.`
    );
  }

  return row;
}

export async function expectAllocatedCommitment(input: AllocatedExpectation) {
  const item = await findItemBySku(input.api, input.sku);
  let allocatedOpen = 0;

  try {
    await expect
      .poll(
        async () => {
          const commitments = await computeReservationCommitments({
            api: input.api,
            warehouseId: input.warehouseId,
            itemId: item.id,
            locationId: input.locationId
          });
          allocatedOpen = commitments.allocatedOpen;
          return normalize(allocatedOpen);
        },
        {
          timeout: ASSERTION_POLL_TIMEOUT_MS,
          intervals: ASSERTION_POLL_INTERVALS_MS,
          message: `Allocated commitment did not converge for sku=${input.sku}, warehouse=${input.warehouseId}, location=${input.locationId}`
        }
      )
      .toBe(normalize(input.expectedAllocated));
  } catch (error) {
    throw new Error(
      [
        `Allocated commitment assertion failed for sku=${input.sku}, warehouse=${input.warehouseId}, location=${input.locationId}.`,
        `ExpectedAllocated=${normalize(input.expectedAllocated)}.`,
        `LastObservedAllocated=${normalize(allocatedOpen)}.`,
        `OriginalError=${error instanceof Error ? error.message : String(error)}`
      ].join(' ')
    );
  }

  return allocatedOpen;
}

export async function expectReservationCommitments(input: ReservationCommitmentExpectation) {
  const item = await findItemBySku(input.api, input.sku);
  const expected: Partial<{ reservedOpen: number; allocatedOpen: number }> = {};
  if (input.expectedReservedOpen !== undefined) expected.reservedOpen = normalize(input.expectedReservedOpen);
  if (input.expectedAllocatedOpen !== undefined) expected.allocatedOpen = normalize(input.expectedAllocatedOpen);

  let commitments = { reservedOpen: 0, allocatedOpen: 0 };
  let lastObserved = { reservedOpen: 0, allocatedOpen: 0 };
  try {
    await expect
      .poll(
        async () => {
          commitments = await computeReservationCommitments({
            api: input.api,
            warehouseId: input.warehouseId,
            itemId: item.id,
            locationId: input.locationId
          });
          lastObserved = {
            reservedOpen: normalize(commitments.reservedOpen),
            allocatedOpen: normalize(commitments.allocatedOpen)
          };
          return lastObserved;
        },
        {
          timeout: ASSERTION_POLL_TIMEOUT_MS,
          intervals: ASSERTION_POLL_INTERVALS_MS,
          message: `Reservation commitments did not converge for sku=${input.sku}, warehouse=${input.warehouseId}, location=${input.locationId}`
        }
      )
      .toMatchObject(expected);
  } catch (error) {
    throw new Error(
      [
        `Reservation commitment assertion failed for sku=${input.sku}, warehouse=${input.warehouseId}, location=${input.locationId}.`,
        `Expected=${JSON.stringify(expected)}.`,
        `LastObserved=${JSON.stringify(lastObserved)}.`,
        `OriginalError=${error instanceof Error ? error.message : String(error)}`
      ].join(' ')
    );
  }

  return commitments;
}
