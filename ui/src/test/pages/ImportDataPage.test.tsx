import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ImportDataPage from '../../features/admin/pages/ImportDataPage'
import {
  applyImportJob,
  getImportJob,
  uploadImportCsv,
  validateImportJob,
} from '../../features/admin/api/imports'

vi.mock('../../features/admin/api/imports', () => ({
  applyImportJob: vi.fn(),
  getImportJob: vi.fn(),
  uploadImportCsv: vi.fn(),
  validateImportJob: vi.fn(),
}))

const uploadResponse = {
  jobId: '00000000-0000-0000-0000-000000000001',
  headers: ['sku', 'locationCode', 'uom', 'quantity', 'lotNumber', 'serialNumber'],
  sampleRows: [
    {
      sku: 'LOT-1',
      locationCode: 'SELLABLE',
      uom: 'each',
      quantity: '5',
      lotNumber: '',
      serialNumber: '',
    },
  ],
  suggestedMapping: {
    sku: 'sku',
    locationCode: 'locationCode',
    uom: 'uom',
    quantity: 'quantity',
    lotNumber: 'lotNumber',
    serialNumber: 'serialNumber',
  },
  totalRows: 1,
}

const jobResponse = {
  data: {
    id: uploadResponse.jobId,
    tenantId: 'tenant-1',
    type: 'on_hand',
    status: 'validated',
    fileName: 'on-hand.csv',
    totalRows: 1,
    validRows: 0,
    errorRows: 1,
    mapping: uploadResponse.suggestedMapping,
    countedAt: '2026-01-01T00:00:00.000Z',
    errorSummary: null,
    createdBy: 'user-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
  },
}

function selectOnHandImport() {
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'on_hand' } })
}

async function uploadCsv(container: HTMLElement) {
  const fileInput = container.querySelector('input[type="file"]')
  if (!fileInput) throw new Error('file input missing')
  const file = new File(['sku,locationCode,uom,quantity\nLOT-1,SELLABLE,each,5'], 'on-hand.csv', {
    type: 'text/csv',
  })
  Object.defineProperty(file, 'text', {
    value: async () => 'sku,locationCode,uom,quantity\nLOT-1,SELLABLE,each,5',
  })
  fireEvent.change(fileInput, { target: { files: [file] } })
  fireEvent.click(screen.getByRole('button', { name: /Upload CSV/i }))
  await screen.findByText(/Map columns/i)
}

describe('ImportDataPage traceability gating', () => {
  beforeEach(() => {
    vi.mocked(uploadImportCsv).mockResolvedValue(uploadResponse)
    vi.mocked(getImportJob).mockResolvedValue(jobResponse)
  })

  it('blocks apply when validation reports tracked rows without trace data', async () => {
    vi.mocked(validateImportJob).mockResolvedValue({
      data: {
        totalRows: 1,
        validRows: 0,
        errorRows: 1,
        invalidTrackedRowsCount: 1,
        errorsBySku: [
          {
            sku: 'LOT-1',
            rowNumbers: [2],
            messages: ['Tracked item requires lot/serial data for on-hand import'],
            fieldErrors: [
              {
                rowNumber: 2,
                field: 'lotNumber',
                message: 'Tracked item requires lot/serial data for on-hand import',
              },
            ],
          },
        ],
        fieldErrors: [
          {
            rowNumber: 2,
            sku: 'LOT-1',
            field: 'lotNumber',
            message: 'Tracked item requires lot/serial data for on-hand import',
          },
        ],
        errorSamples: [
          {
            rowNumber: 2,
            status: 'error',
            raw: {},
            errorCode: 'Tracked item requires lot/serial data for on-hand import',
            errorDetail: 'Tracked item requires lot/serial data for on-hand import',
          },
        ],
      },
    })

    const { container } = render(<ImportDataPage />)
    selectOnHandImport()
    await uploadCsv(container)
    fireEvent.click(screen.getByRole('button', { name: /Validate/i }))

    expect(await screen.findByText(/Tracked import blocked/i)).toBeInTheDocument()
    expect(screen.getByText(/Affected SKUs: LOT-1/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Apply Import/i })).not.toBeInTheDocument()
    expect(applyImportJob).not.toHaveBeenCalled()
  })

  it('requires confirmation before applying a valid import', async () => {
    vi.mocked(validateImportJob).mockResolvedValue({
      data: {
        totalRows: 1,
        validRows: 1,
        errorRows: 0,
        invalidTrackedRowsCount: 0,
        errorsBySku: [],
        fieldErrors: [],
        errorSamples: [],
      },
    })
    vi.mocked(applyImportJob).mockResolvedValue({
      data: {
        ...jobResponse.data,
        status: 'completed',
        validRows: 1,
        errorRows: 0,
      },
    })
    vi.mocked(getImportJob).mockResolvedValue({
      data: {
        ...jobResponse.data,
        status: 'completed',
        validRows: 1,
        errorRows: 0,
      },
    })

    const { container } = render(<ImportDataPage />)
    selectOnHandImport()
    await uploadCsv(container)
    fireEvent.click(screen.getByRole('button', { name: /Validate/i }))
    await screen.findByText(/Ready to apply/i)

    fireEvent.click(screen.getByRole('button', { name: /Apply Import/i }))
    expect(applyImportJob).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Confirm Apply/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Confirm Apply/i }))

    await waitFor(() => expect(applyImportJob).toHaveBeenCalledWith(uploadResponse.jobId))
  })
})
