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

function normalize(value: number): number {
  return Number(value.toFixed(6));
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

export async function expectInventoryBuckets(input: InventoryBucketExpectation) {
  const item = await findItemBySku(input.api, input.sku);
  const locationId = await resolveLocationId({
    api: input.api,
    warehouseId: input.warehouseId,
    locationId: input.locationId,
    locationRole: input.locationRole
  });

  const row = await getSnapshotRow({
    api: input.api,
    itemId: item.id,
    warehouseId: input.warehouseId,
    locationId,
    uom: input.uom
  });

  if (input.onHand !== undefined) {
    expect(normalize(row.onHand)).toBe(normalize(input.onHand));
  }
  if (input.available !== undefined) {
    expect(normalize(row.available)).toBe(normalize(input.available));
  }
  if (input.inTransit !== undefined) {
    expect(normalize(row.inTransit)).toBe(normalize(input.inTransit));
  }
  if (input.reservedTotal !== undefined) {
    expect(normalize(row.reserved)).toBe(normalize(input.reservedTotal));
  }

  return row;
}

export async function expectAllocatedCommitment(input: AllocatedExpectation) {
  const item = await findItemBySku(input.api, input.sku);
  const reservations = await listReservations(input.api, input.warehouseId);

  // Allocated semantics are derived from reservation documents, not snapshot.reserved.
  const allocatedOpen = reservations
    .filter((reservation) => reservation.status === 'ALLOCATED')
    .filter((reservation) => reservation.itemId === item.id)
    .filter((reservation) => reservation.locationId === input.locationId)
    .reduce((total, reservation) => {
      const openQty = Number(reservation.quantityReserved) - Number(reservation.quantityFulfilled || 0);
      return total + Math.max(0, openQty);
    }, 0);

  expect(normalize(allocatedOpen)).toBe(normalize(input.expectedAllocated));
  return allocatedOpen;
}

export async function expectReservationCommitments(input: ReservationCommitmentExpectation) {
  const item = await findItemBySku(input.api, input.sku);
  const reservations = await listReservations(input.api, input.warehouseId).then((rows) =>
    rows.filter((row) => row.itemId === item.id && row.locationId === input.locationId)
  );

  const reservedOpen = reservations
    .filter((reservation) => reservation.status === 'RESERVED')
    .reduce((total, reservation) => {
      const openQty = Number(reservation.quantityReserved) - Number(reservation.quantityFulfilled || 0);
      return total + Math.max(0, openQty);
    }, 0);

  const allocatedOpen = reservations
    .filter((reservation) => reservation.status === 'ALLOCATED')
    .reduce((total, reservation) => {
      const openQty = Number(reservation.quantityReserved) - Number(reservation.quantityFulfilled || 0);
      return total + Math.max(0, openQty);
    }, 0);

  if (input.expectedReservedOpen !== undefined) {
    expect(normalize(reservedOpen)).toBe(normalize(input.expectedReservedOpen));
  }
  if (input.expectedAllocatedOpen !== undefined) {
    expect(normalize(allocatedOpen)).toBe(normalize(input.expectedAllocatedOpen));
  }

  return { reservedOpen, allocatedOpen };
}
