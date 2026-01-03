import { apiGet, apiPost, apiPut } from '@api/http'
import type {
  VendorInvoice,
  VendorInvoiceWithLines,
  CreateVendorInvoiceInput,
  UpdateVendorInvoiceInput,
  VendorPayment,
  VendorPaymentWithApplications,
  CreateVendorPaymentInput,
  UpdateVendorPaymentInput,
  UnpaidInvoice,
  ApDashboardMetrics,
} from '../types'

// Vendor Invoices
export async function listVendorInvoices(params?: {
  status?: string
  vendorId?: string
  startDate?: string
  endDate?: string
  limit?: number
  offset?: number
}): Promise<{ data: VendorInvoice[] }> {
  const searchParams = new URLSearchParams()
  if (params?.status) searchParams.append('status', params.status)
  if (params?.vendorId) searchParams.append('vendorId', params.vendorId)
  if (params?.startDate) searchParams.append('startDate', params.startDate)
  if (params?.endDate) searchParams.append('endDate', params.endDate)
  if (params?.limit) searchParams.append('limit', String(params.limit))
  if (params?.offset) searchParams.append('offset', String(params.offset))

  return apiGet<{ data: VendorInvoice[] }>(
    `/vendor-invoices?${searchParams.toString()}`
  )
}

export async function getVendorInvoice(
  id: string
): Promise<VendorInvoiceWithLines> {
  return apiGet<VendorInvoiceWithLines>(`/vendor-invoices/${id}`)
}

export async function createVendorInvoice(
  data: CreateVendorInvoiceInput
): Promise<VendorInvoice> {
  return apiPost<VendorInvoice>('/vendor-invoices', data)
}

export async function updateVendorInvoice(
  id: string,
  data: UpdateVendorInvoiceInput
): Promise<VendorInvoice> {
  return apiPut<VendorInvoice>(`/vendor-invoices/${id}`, data)
}

export async function approveVendorInvoice(id: string): Promise<VendorInvoice> {
  return apiPost<VendorInvoice>(`/vendor-invoices/${id}/approve`, {})
}

export async function voidVendorInvoice(id: string): Promise<VendorInvoice> {
  return apiPost<VendorInvoice>(`/vendor-invoices/${id}/void`, {})
}

// Vendor Payments
export async function listVendorPayments(params?: {
  status?: string
  vendorId?: string
  startDate?: string
  endDate?: string
  limit?: number
  offset?: number
}): Promise<{ data: VendorPayment[] }> {
  const searchParams = new URLSearchParams()
  if (params?.status) searchParams.append('status', params.status)
  if (params?.vendorId) searchParams.append('vendorId', params.vendorId)
  if (params?.startDate) searchParams.append('startDate', params.startDate)
  if (params?.endDate) searchParams.append('endDate', params.endDate)
  if (params?.limit) searchParams.append('limit', String(params.limit))
  if (params?.offset) searchParams.append('offset', String(params.offset))

  return apiGet<{ data: VendorPayment[] }>(
    `/vendor-payments?${searchParams.toString()}`
  )
}

export async function getVendorPayment(
  id: string
): Promise<VendorPaymentWithApplications> {
  return apiGet<VendorPaymentWithApplications>(`/vendor-payments/${id}`)
}

export async function createVendorPayment(
  data: CreateVendorPaymentInput
): Promise<VendorPayment> {
  return apiPost<VendorPayment>('/vendor-payments', data)
}

export async function updateVendorPayment(
  id: string,
  data: UpdateVendorPaymentInput
): Promise<VendorPayment> {
  return apiPut<VendorPayment>(`/vendor-payments/${id}`, data)
}

export async function postVendorPayment(id: string): Promise<VendorPayment> {
  return apiPost<VendorPayment>(`/vendor-payments/${id}/post`, {})
}

export async function voidVendorPayment(id: string): Promise<VendorPayment> {
  return apiPost<VendorPayment>(`/vendor-payments/${id}/void`, {})
}

export async function getUnpaidInvoicesForVendor(
  vendorId: string
): Promise<{ data: UnpaidInvoice[] }> {
  return apiGet<{ data: UnpaidInvoice[] }>(
    `/vendor-payments/vendors/${vendorId}/unpaid-invoices`
  )
}

// AP Dashboard
export async function getApDashboardMetrics(): Promise<ApDashboardMetrics> {
  // For now, return mock data - backend endpoint would be needed
  return {
    totalOutstanding: 0,
    currentDue: 0,
    pastDue: 0,
    invoicesDue7Days: 0,
    invoicesDue30Days: 0,
    agingBuckets: [
      { period: 'current', count: 0, amount: 0 },
      { period: '1-30', count: 0, amount: 0 },
      { period: '31-60', count: 0, amount: 0 },
      { period: '61-90', count: 0, amount: 0 },
      { period: '90+', count: 0, amount: 0 },
    ],
  }
}
