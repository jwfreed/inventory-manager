import { apiGet, apiPost, apiPostRaw } from '../../../api/http'
import type {
  ImportJobSummary,
  ImportUploadResponse,
  ImportType,
  ImportValidationResult,
} from '../../../api/types'

export async function uploadImportCsv(params: {
  type: ImportType
  fileName: string
  csvText: string
}): Promise<ImportUploadResponse> {
  const query = new URLSearchParams({
    type: params.type,
    fileName: params.fileName,
  })
  return apiPostRaw<ImportUploadResponse>(`/admin/imports/upload?${query.toString()}`, params.csvText, {
    contentType: 'text/csv',
  })
}

export async function validateImportJob(params: {
  jobId: string
  mapping: Record<string, string>
  countedAt?: string
}): Promise<{ data: ImportValidationResult }> {
  return apiPost(`/admin/imports/${params.jobId}/validate`, {
    mapping: params.mapping,
    countedAt: params.countedAt,
  })
}

export async function applyImportJob(jobId: string): Promise<{ data: ImportJobSummary }>
{
  return apiPost(`/admin/imports/${jobId}/apply`, {})
}

export async function getImportJob(jobId: string): Promise<{ data: ImportJobSummary }> {
  return apiGet(`/admin/imports/${jobId}`)
}
