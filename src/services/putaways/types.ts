import type { z } from 'zod';
import type { putawaySchema } from '../../schemas/putaways.schema';

export type PutawayInput = z.infer<typeof putawaySchema>;

export type PutawayLineRow = {
  id: string;
  putaway_id: string;
  purchase_order_receipt_line_id: string;
  line_number: number;
  item_id: string;
  uom: string;
  quantity_planned: string | number | null;
  quantity_moved: string | number | null;
  from_location_id: string;
  to_location_id: string;
  inventory_movement_id: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type PutawayRow = {
  id: string;
  status: string;
  source_type: string;
  purchase_order_receipt_id: string | null;
  inventory_movement_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};
