export interface Ncr {
  id: string;
  tenant_id: string;
  qc_event_id: string;
  ncr_number: string;
  status: 'open' | 'closed';
  disposition_type: 'return_to_vendor' | 'scrap' | 'rework' | 'use_as_is' | null;
  disposition_notes: string | null;
  created_at: string;
  updated_at: string;
  
  // Joined fields from QC Event
  event_type: string;
  quantity: number;
  uom: string;
  reason_code: string | null;
  purchase_order_receipt_line_id: string | null;
  work_order_id: string | null;
  work_order_execution_line_id: string | null;
  
  // Index signature for Table component compatibility
  [key: string]: unknown;
}

export interface NcrUpdateInput {
  dispositionType: 'return_to_vendor' | 'scrap' | 'rework' | 'use_as_is';
  dispositionNotes?: string;
}
