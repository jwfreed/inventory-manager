export type Vendor = {
  id: string
  code: string
  name: string
  email?: string | null
  phone?: string | null
  contactName?: string | null
  addressLine1?: string | null
  addressLine2?: string | null
  city?: string | null
  state?: string | null
  postalCode?: string | null
  country?: string | null
  notes?: string | null
  active?: boolean
  createdAt?: string
  updatedAt?: string
}
