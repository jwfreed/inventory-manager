// Vendor Invoice Types
export type VendorInvoiceStatus = 
  | 'draft' 
  | 'pending_approval' 
  | 'approved' 
  | 'paid' 
  | 'partially_paid' 
  | 'void'

export type VendorInvoice = {
  id: string
  tenantId: string
  invoiceNumber: string
  vendorId: string
  purchaseOrderId: string | null
  invoiceDate: string
  dueDate: string
  glDate: string | null
  status: VendorInvoiceStatus
  currency: string
  exchangeRate: number
  subtotal: number
  taxAmount: number
  freightAmount: number
  discountAmount: number
  totalAmount: number
  amountPaid: number
  amountDue: number
  paymentTermId: string | null
  vendorInvoiceNumber: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
  createdByUserId: string | null
  // Joined data
  vendorCode?: string
  vendorName?: string
  poNumber?: string
  paymentTermCode?: string
}

export type VendorInvoiceLine = {
  id: string
  tenantId: string
  vendorInvoiceId: string
  lineNumber: number
  purchaseOrderLineId: string | null
  receiptLineId: string | null
  itemId: string | null
  description: string
  quantity: number
  uom: string
  unitPrice: number
  lineAmount: number
  taxAmount: number
  notes: string | null
  // Joined data
  itemSku?: string
  itemName?: string
  poLineNumber?: number
  receiptNumber?: string
}

export type VendorInvoiceWithLines = VendorInvoice & {
  lines: VendorInvoiceLine[]
  paymentApplications?: PaymentApplication[]
}

export type CreateVendorInvoiceInput = {
  invoiceNumber?: string
  vendorId: string
  purchaseOrderId?: string
  invoiceDate: string
  dueDate: string
  glDate?: string
  currency?: string
  exchangeRate?: number
  subtotal: number
  taxAmount?: number
  freightAmount?: number
  discountAmount?: number
  paymentTermId?: string
  vendorInvoiceNumber?: string
  notes?: string
  lines: {
    lineNumber: number
    purchaseOrderLineId?: string
    receiptLineId?: string
    itemId?: string
    description: string
    quantity: number
    uom: string
    unitPrice: number
    taxAmount?: number
    notes?: string
  }[]
}

export type UpdateVendorInvoiceInput = {
  invoiceDate?: string
  dueDate?: string
  glDate?: string
  subtotal?: number
  taxAmount?: number
  freightAmount?: number
  discountAmount?: number
  paymentTermId?: string
  vendorInvoiceNumber?: string
  notes?: string
}

// Vendor Payment Types
export type VendorPaymentStatus = 'draft' | 'posted' | 'void' | 'cleared'

export type VendorPaymentMethod = 
  | 'check' 
  | 'ach' 
  | 'wire' 
  | 'credit_card' 
  | 'cash' 
  | 'other'

export type VendorPayment = {
  id: string
  tenantId: string
  paymentNumber: string
  vendorId: string
  paymentDate: string
  paymentMethod: VendorPaymentMethod
  referenceNumber: string | null
  paymentAmount: number
  currency: string
  exchangeRate: number
  status: VendorPaymentStatus
  notes: string | null
  postedAt: string | null
  postedByUserId: string | null
  createdAt: string
  updatedAt: string
  createdByUserId: string | null
  // Joined data
  vendorCode?: string
  vendorName?: string
  invoiceCount?: number
}

export type PaymentApplication = {
  id: string
  tenantId: string
  vendorPaymentId: string
  vendorInvoiceId: string
  appliedAmount: number
  discountTaken: number
  createdAt: string
  // Joined data
  invoiceNumber?: string
  invoiceDueDate?: string
  invoiceTotalAmount?: number
}

export type VendorPaymentWithApplications = VendorPayment & {
  applications: (PaymentApplication & {
    invoiceNumber: string
    invoiceDueDate: string
    invoiceTotalAmount: number
  })[]
}

export type CreateVendorPaymentInput = {
  paymentNumber?: string
  vendorId: string
  paymentDate: string
  paymentMethod: VendorPaymentMethod
  referenceNumber?: string
  paymentAmount: number
  currency?: string
  exchangeRate?: number
  notes?: string
  applications: {
    vendorInvoiceId: string
    appliedAmount: number
    discountTaken?: number
  }[]
}

export type UpdateVendorPaymentInput = {
  paymentDate?: string
  paymentMethod?: VendorPaymentMethod
  referenceNumber?: string
  notes?: string
}

export type UnpaidInvoice = {
  id: string
  invoiceNumber: string
  invoiceDate: string
  dueDate: string
  totalAmount: number
  amountPaid: number
  amountDue: number
  status: VendorInvoiceStatus
}

// AP Dashboard Types
export type ApAgingBucket = {
  period: 'current' | '1-30' | '31-60' | '61-90' | '90+'
  count: number
  amount: number
}

export type ApDashboardMetrics = {
  totalOutstanding: number
  currentDue: number
  pastDue: number
  invoicesDue7Days: number
  invoicesDue30Days: number
  agingBuckets: ApAgingBucket[]
}
