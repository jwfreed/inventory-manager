import { useMemo, useState } from 'react'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { uploadImportCsv, validateImportJob, applyImportJob, getImportJob } from '../api/imports'
import type { ImportJobSummary, ImportType, ImportUploadResponse, ImportValidationResult } from '../../../api/types'

const IMPORT_FIELDS: Record<ImportType, { required: string[]; optional: string[] }> = {
  items: {
    required: ['sku', 'name', 'uomDimension', 'canonicalUom', 'stockingUom'],
    optional: [
      'description',
      'type',
      'lifecycleStatus',
      'defaultUom',
      'defaultLocationCode',
      'requiresLot',
      'requiresSerial',
      'requiresQc',
      'standardCost',
      'standardCostCurrency',
      'listPrice',
      'priceCurrency',
      'isPhantom',
    ],
  },
  locations: {
    required: ['code', 'name', 'type'],
    optional: ['active', 'parentLocationCode', 'zone', 'maxWeight', 'maxVolume'],
  },
  on_hand: {
    required: ['sku', 'locationCode', 'uom', 'quantity'],
    optional: [],
  },
}

const IMPORT_LABELS: Record<ImportType, string> = {
  items: 'Items',
  locations: 'Locations',
  on_hand: 'On-hand Snapshot',
}

function toDateTimeLocal(value: string) {
  try {
    const date = new Date(value)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
      date.getHours(),
    )}:${pad(date.getMinutes())}`
  } catch {
    return ''
  }
}

function toIsoString(value: string) {
  if (!value) return undefined
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return undefined
  return parsed.toISOString()
}

export default function ImportDataPage() {
  const [importType, setImportType] = useState<ImportType>('items')
  const [file, setFile] = useState<File | null>(null)
  const [uploadResult, setUploadResult] = useState<ImportUploadResponse | null>(null)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [validation, setValidation] = useState<ImportValidationResult | null>(null)
  const [job, setJob] = useState<ImportJobSummary | null>(null)
  const [countedAt, setCountedAt] = useState<string>(toDateTimeLocal(new Date().toISOString()))
  const [status, setStatus] = useState<'idle' | 'uploading' | 'validating' | 'applying'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [showOptional, setShowOptional] = useState(false)

  const fields = IMPORT_FIELDS[importType]
  const headers = uploadResult?.headers ?? []

  const missingRequired = fields.required.filter((field) => !mapping[field])
  const mappingComplete = missingRequired.length === 0

  const sampleRows = useMemo(() => uploadResult?.sampleRows ?? [], [uploadResult])

  const reset = () => {
    setUploadResult(null)
    setMapping({})
    setValidation(null)
    setJob(null)
    setError(null)
    setShowOptional(false)
  }

  const onUpload = async () => {
    if (!file) return
    setStatus('uploading')
    setError(null)
    try {
      const text = await file.text()
      const result = await uploadImportCsv({
        type: importType,
        fileName: file.name,
        csvText: text,
      })
      setUploadResult(result)
      setMapping(result.suggestedMapping ?? {})
    } catch (err: any) {
      setError(err?.message ?? 'Failed to upload CSV.')
    } finally {
      setStatus('idle')
    }
  }

  const onValidate = async () => {
    if (!uploadResult) return
    setStatus('validating')
    setError(null)
    try {
      const countedIso = importType === 'on_hand' ? toIsoString(countedAt) : undefined
      const result = await validateImportJob({
        jobId: uploadResult.jobId,
        mapping,
        countedAt: countedIso,
      })
      setValidation(result.data)
      const jobRes = await getImportJob(uploadResult.jobId)
      setJob(jobRes.data)
    } catch (err: any) {
      setError(err?.message ?? 'Validation failed.')
    } finally {
      setStatus('idle')
    }
  }

  const onApply = async () => {
    if (!uploadResult) return
    setStatus('applying')
    setError(null)
    try {
      const result = await applyImportJob(uploadResult.jobId)
      setJob(result.data)
      const poll = async () => {
        const latest = await getImportJob(uploadResult.jobId)
        setJob(latest.data)
        if (['completed', 'failed'].includes(latest.data.status)) {
          setStatus('idle')
          return
        }
        setTimeout(poll, 1500)
      }
      setTimeout(poll, 1500)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to apply import.')
      setStatus('idle')
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-slate-100">Data Import</h1>
        <p className="text-sm text-slate-400">Admin-only CSV imports for onboarding.</p>
      </div>

      {error && (
        <Alert variant="error">
          <p>{error}</p>
        </Alert>
      )}

      <Card className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-slate-200">Import type</label>
            <select
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              value={importType}
              onChange={(event) => {
                setImportType(event.target.value as ImportType)
                reset()
              }}
            >
              {Object.entries(IMPORT_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-200">CSV file</label>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="mt-1 w-full text-sm"
            />
          </div>
        </div>
        {importType === 'on_hand' && (
          <div>
            <label className="block text-sm font-medium text-slate-200">Counted at</label>
            <input
              type="datetime-local"
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              value={countedAt}
              onChange={(event) => setCountedAt(event.target.value)}
            />
          </div>
        )}
        <div className="flex items-center justify-between">
          <div className="text-sm text-slate-400">
            Max 10 MB, 50k rows. Lots/serials not supported in v1.
          </div>
          <Button onClick={onUpload} disabled={!file || status !== 'idle'}>
            {status === 'uploading' ? 'Uploading…' : 'Upload CSV'}
          </Button>
        </div>
      </Card>

      {uploadResult && (
        <Card className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-slate-100">Map columns</h3>
              <p className="text-sm text-slate-400">
                {mappingComplete
                  ? `All required fields mapped (${fields.required.length}/${fields.required.length}).`
                  : `Required fields mapped (${fields.required.length - missingRequired.length}/${fields.required.length}).`}
              </p>
            </div>
            <Button
              variant="secondary"
              onClick={() => setShowOptional((prev) => !prev)}
            >
              {showOptional ? 'Hide optional fields' : 'Show optional fields'}
            </Button>
          </div>

          {!mappingComplete && (
            <Alert
              variant="warning"
              title="Missing required mappings"
              message={`Map: ${missingRequired.join(', ')}`}
            />
          )}

          <div className="grid gap-4 md:grid-cols-2">
            {fields.required.map((field) => (
              <div key={field}>
                <label className="block text-sm font-medium text-slate-200">
                  {field}
                  {fields.required.includes(field) && (
                    <span className="ml-1 text-rose-400">*</span>
                  )}
                </label>
                <select
                  className="mt-1 w-full rounded border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-slate-400 focus:outline-none"
                  value={mapping[field] ?? ''}
                  onChange={(event) =>
                    setMapping((prev) => ({
                      ...prev,
                      [field]: event.target.value,
                    }))
                  }
                >
                  <option value="">--</option>
                  {headers.map((header) => (
                    <option key={header} value={header}>
                      {header}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          {showOptional && fields.optional.length > 0 && (
            <div className="grid gap-4 md:grid-cols-2">
              {fields.optional.map((field) => (
                <div key={field}>
                  <label className="block text-sm font-medium text-slate-400">{field}</label>
                  <select
                    className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-300 focus:border-slate-500 focus:outline-none"
                    value={mapping[field] ?? ''}
                    onChange={(event) =>
                      setMapping((prev) => ({
                        ...prev,
                        [field]: event.target.value,
                      }))
                    }
                  >
                    <option value="">--</option>
                    {headers.map((header) => (
                      <option key={header} value={header}>
                        {header}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between">
            <div className="text-sm text-slate-400">
              {uploadResult.totalRows} rows detected. {fields.required.length} required fields.
            </div>
            <Button onClick={onValidate} disabled={!mappingComplete || status !== 'idle'}>
              {status === 'validating' ? 'Validating…' : 'Validate'}
            </Button>
          </div>
        </Card>
      )}

      {validation && (
        <Card className="space-y-4">
          <h3 className="text-lg font-semibold text-slate-100">Validation results</h3>
          <div className="flex flex-wrap gap-4 text-sm text-slate-300">
            <div>Total rows: {validation.totalRows}</div>
            <div>Valid rows: {validation.validRows}</div>
            <div>Errors: {validation.errorRows}</div>
          </div>
          {validation.errorRows > 0 && (
            <div className="space-y-2">
              <p className="text-sm text-rose-400">Fix the errors below before applying.</p>
              <div className="max-h-64 overflow-auto border border-slate-800">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-slate-900 text-slate-300">
                    <tr>
                      <th className="px-3 py-2">Row</th>
                      <th className="px-3 py-2">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {validation.errorSamples.map((row) => (
                      <tr key={row.rowNumber} className="border-t border-slate-800">
                        <td className="px-3 py-2">{row.rowNumber}</td>
                        <td className="px-3 py-2">{row.errorCode}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {validation.errorRows === 0 && (
            <div className="flex items-center justify-between">
              <div className="text-sm text-slate-400">Ready to apply.</div>
              <Button onClick={onApply} disabled={status !== 'idle'}>
                {status === 'applying' ? 'Applying…' : 'Apply Import'}
              </Button>
            </div>
          )}
        </Card>
      )}

      {job && (
        <Card className="space-y-2">
          <h3 className="text-lg font-semibold text-slate-100">Import status</h3>
          <div className="text-sm text-slate-300">Status: {job.status}</div>
          <div className="text-sm text-slate-300">
            Rows: {job.validRows} applied, {job.errorRows} errors
          </div>
          {job.errorSummary && <div className="text-sm text-rose-400">{job.errorSummary}</div>}
        </Card>
      )}

      {sampleRows.length > 0 && (
        <Card className="space-y-2">
          <h3 className="text-lg font-semibold text-slate-100">Sample rows</h3>
          <div className="max-h-64 overflow-auto border border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-slate-900 text-slate-300">
                <tr>
                  {headers.map((header) => (
                    <th key={header} className="px-3 py-2">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sampleRows.map((row, idx) => (
                  <tr key={idx} className="border-t border-slate-800">
                    {headers.map((header) => (
                      <td key={header} className="px-3 py-2">
                        {row[header]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
