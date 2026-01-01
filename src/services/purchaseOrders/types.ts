import type { z } from 'zod';
import type { purchaseOrderSchema, purchaseOrderLineSchema, purchaseOrderUpdateSchema } from '../../schemas/purchaseOrders.schema';

export type PurchaseOrderInput = z.infer<typeof purchaseOrderSchema>;
export type PurchaseOrderLineInput = z.infer<typeof purchaseOrderLineSchema>;
export type PurchaseOrderUpdateInput = z.infer<typeof purchaseOrderUpdateSchema>;

export type PurchaseOrderStatus =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'partially_received'
  | 'received'
  | 'closed'
  | 'canceled';
