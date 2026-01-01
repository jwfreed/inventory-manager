import type { z } from 'zod';
import type { inventoryAdjustmentSchema } from '../../schemas/adjustments.schema';

export type InventoryAdjustmentInput = z.infer<typeof inventoryAdjustmentSchema>;

export type InventoryAdjustmentRow = {
  id: string;
  status: string;
  occurred_at: string;
  inventory_movement_id: string | null;
  corrected_from_adjustment_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  is_corrected?: boolean;
};

export type InventoryAdjustmentLineRow = {
  id: string;
  inventory_adjustment_id: string;
  line_number: number;
  item_id: string;
  item_sku?: string | null;
  item_name?: string | null;
  location_id: string;
  location_code?: string | null;
  location_name?: string | null;
  uom: string;
  quantity_delta: string | number;
  reason_code: string;
  notes: string | null;
  created_at: string;
};

export type InventoryAdjustmentSummaryRow = InventoryAdjustmentRow & {
  line_count?: number | string | null;
  totals_by_uom?: unknown;
};

export type NormalizedAdjustmentLine = {
  lineNumber: number;
  itemId: string;
  locationId: string;
  uom: string;
  quantityDelta: number;
  reasonCode: string;
  notes: string | null;
};

export type PostingContext = {
  actor?: { type: 'user' | 'system'; id?: string | null; role?: string | null };
  overrideRequested?: boolean;
  overrideReason?: string | null;
};

export type ActorContext = {
  type: 'user' | 'system';
  id?: string | null;
};
