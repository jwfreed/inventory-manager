import type { z } from 'zod';
import type { workOrderCreateSchema, workOrderListQuerySchema } from '../../schemas/workOrders.schema';

export type WorkOrderCreateInput = z.infer<typeof workOrderCreateSchema>;
export type WorkOrderListQuery = z.infer<typeof workOrderListQuerySchema>;

export type WorkOrderRow = {
  id: string;
  work_order_number: string;
  number: string | null;
  status: string;
  kind: string;
  bom_id: string | null;
  bom_version_id: string | null;
  related_work_order_id: string | null;
  output_item_id: string;
  output_uom: string;
  quantity_planned: string | number;
  quantity_completed: string | number | null;
  default_consume_location_id: string | null;
  default_produce_location_id: string | null;
  scheduled_start_at: string | null;
  scheduled_due_at: string | null;
  released_at: string | null;
  completed_at: string | null;
  notes: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
};
