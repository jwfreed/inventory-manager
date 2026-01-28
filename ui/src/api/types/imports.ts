export type ImportType = 'items' | 'locations' | 'on_hand'

export type ImportJobSummary = {
  id: string
  tenantId: string
  type: ImportType
  status: string
  fileName: string | null
  totalRows: number
  validRows: number
  errorRows: number
  mapping: Record<string, string> | null
  countedAt: string | null
  errorSummary: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
}

export type ImportUploadResponse = {
  jobId: string
  headers: string[]
  sampleRows: Record<string, string>[]
  suggestedMapping: Record<string, string>
  totalRows: number
}

export type ImportValidationResult = {
  totalRows: number
  validRows: number
  errorRows: number
  errorSamples: {
    rowNumber: number
    status: string
    raw: Record<string, string>
    errorCode?: string | null
    errorDetail?: string | null
  }[]
}
