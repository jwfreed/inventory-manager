import { Button, Card, Input, Select } from '@shared/ui'
import { useState } from 'react'

type FilterPreset = {
  id: string
  name: string
  filters: ReceivingFilters
}

export type ReceivingFilters = {
  searchTerm: string
  qcStatus: 'all' | 'pending' | 'accepted' | 'hold' | 'rejected'
  dateRange: 'all' | 'today' | 'week' | 'month' | 'custom'
  dateFrom?: string
  dateTo?: string
  supplier?: string
  location?: string
  hasPriority: boolean
  hasDiscrepancies: boolean
}

const DEFAULT_FILTERS: ReceivingFilters = {
  searchTerm: '',
  qcStatus: 'all',
  dateRange: 'all',
  hasPriority: false,
  hasDiscrepancies: false,
}

const FILTER_PRESETS: FilterPreset[] = [
  {
    id: 'urgent',
    name: 'Urgent Items',
    filters: {
      ...DEFAULT_FILTERS,
      qcStatus: 'pending',
      hasPriority: true,
    },
  },
  {
    id: 'discrepancies',
    name: 'Discrepancies',
    filters: {
      ...DEFAULT_FILTERS,
      hasDiscrepancies: true,
    },
  },
  {
    id: 'on-hold',
    name: 'On Hold',
    filters: {
      ...DEFAULT_FILTERS,
      qcStatus: 'hold',
    },
  },
  {
    id: 'today',
    name: "Today's Receipts",
    filters: {
      ...DEFAULT_FILTERS,
      dateRange: 'today',
    },
  },
]

type Props = {
  filters: ReceivingFilters
  onFiltersChange: (filters: ReceivingFilters) => void
  showQcFilters?: boolean
  className?: string
}

export function SearchFiltersBar({ filters, onFiltersChange, showQcFilters = false, className }: Props) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [customPresetName, setCustomPresetName] = useState('')
  const [savedPresets, setSavedPresets] = useState<FilterPreset[]>([])

  const hasActiveFilters = 
    filters.searchTerm !== '' ||
    filters.qcStatus !== 'all' ||
    filters.dateRange !== 'all' ||
    filters.hasPriority ||
    filters.hasDiscrepancies ||
    filters.supplier !== undefined ||
    filters.location !== undefined

  const handleReset = () => {
    onFiltersChange(DEFAULT_FILTERS)
  }

  const handlePresetSelect = (preset: FilterPreset) => {
    onFiltersChange(preset.filters)
  }

  const handleSavePreset = () => {
    if (!customPresetName.trim()) return
    
    const newPreset: FilterPreset = {
      id: `custom-${Date.now()}`,
      name: customPresetName,
      filters: { ...filters },
    }
    
    setSavedPresets([...savedPresets, newPreset])
    setCustomPresetName('')
  }

  const handleDeletePreset = (presetId: string) => {
    setSavedPresets(savedPresets.filter(p => p.id !== presetId))
  }

  return (
    <Card className={className}>
      <div className="space-y-4">
        {/* Search Bar and Quick Filters */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
          <div className="flex-1">
            <Input
              placeholder="Search receipts, POs, or items..."
              value={filters.searchTerm}
              onChange={(e) => onFiltersChange({ ...filters, searchTerm: e.target.value })}
            />
          </div>
          
          <Button
            variant={isExpanded ? 'secondary' : 'secondary'}
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex-shrink-0"
          >
            <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
            <span className="hidden sm:inline">{isExpanded ? 'Hide Filters' : 'Show Filters'}</span>
            <span className="sm:hidden">{isExpanded ? 'Hide' : 'Filters'}</span>
          </Button>

          {hasActiveFilters && (
            <Button variant="secondary" onClick={handleReset} className="flex-shrink-0">
              <span className="hidden sm:inline">Clear All</span>
              <span className="sm:hidden">Clear</span>
            </Button>
          )}
        </div>

        {/* Filter Presets */}
        {!isExpanded && (
          <div className="flex flex-wrap gap-2">
            {FILTER_PRESETS.map((preset) => (
              <button
                key={preset.id}
                onClick={() => handlePresetSelect(preset)}
                className="px-3 py-1 text-sm rounded-md border border-slate-200 hover:bg-slate-50 transition-colors"
              >
                {preset.name}
              </button>
            ))}
            {savedPresets.map((preset) => (
              <div key={preset.id} className="relative group">
                <button
                  onClick={() => handlePresetSelect(preset)}
                  className="px-3 py-1 text-sm rounded-md border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 transition-colors"
                >
                  {preset.name}
                </button>
                <button
                  onClick={() => handleDeletePreset(preset.id)}
                  className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-xs"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Expanded Filters */}
        {isExpanded && (
          <div className="space-y-4 pt-4 border-t border-slate-200">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {/* QC Status Filter */}
              {showQcFilters && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    QC Status
                  </label>
                  <Select
                    value={filters.qcStatus}
                    onChange={(e) => onFiltersChange({ ...filters, qcStatus: e.target.value as ReceivingFilters['qcStatus'] })}
                  >
                    <option value="all">All Statuses</option>
                    <option value="pending">Pending</option>
                    <option value="accepted">Accepted</option>
                    <option value="hold">On Hold</option>
                    <option value="rejected">Rejected</option>
                  </Select>
                </div>
              )}

              {/* Date Range Filter */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Date Range
                </label>
                <Select
                  value={filters.dateRange}
                  onChange={(e) => onFiltersChange({ ...filters, dateRange: e.target.value as ReceivingFilters['dateRange'] })}
                >
                  <option value="all">All Time</option>
                  <option value="today">Today</option>
                  <option value="week">This Week</option>
                  <option value="month">This Month</option>
                  <option value="custom">Custom Range</option>
                </Select>
              </div>

              {/* Supplier Filter */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Supplier
                </label>
                <Input
                  placeholder="Filter by supplier..."
                  value={filters.supplier ?? ''}
                  onChange={(e) => onFiltersChange({ ...filters, supplier: e.target.value || undefined })}
                />
              </div>

              {/* Location Filter */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Location
                </label>
                <Input
                  placeholder="Filter by location..."
                  value={filters.location ?? ''}
                  onChange={(e) => onFiltersChange({ ...filters, location: e.target.value || undefined })}
                />
              </div>
            </div>

            {/* Custom Date Range */}
            {filters.dateRange === 'custom' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    From Date
                  </label>
                  <input
                    type="date"
                    value={filters.dateFrom ?? ''}
                    onChange={(e) => onFiltersChange({ ...filters, dateFrom: e.target.value || undefined })}
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    To Date
                  </label>
                  <input
                    type="date"
                    value={filters.dateTo ?? ''}
                    onChange={(e) => onFiltersChange({ ...filters, dateTo: e.target.value || undefined })}
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
              </div>
            )}

            {/* Toggle Filters */}
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.hasPriority}
                  onChange={(e) => onFiltersChange({ ...filters, hasPriority: e.target.checked })}
                  className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                <span className="text-sm text-slate-700">Priority Only</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.hasDiscrepancies}
                  onChange={(e) => onFiltersChange({ ...filters, hasDiscrepancies: e.target.checked })}
                  className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                <span className="text-sm text-slate-700">Has Discrepancies</span>
              </label>
            </div>

            {/* Save Preset */}
            <div className="pt-4 border-t border-slate-200">
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Save Current Filters
                  </label>
                  <Input
                    placeholder="Enter preset name..."
                    value={customPresetName}
                    onChange={(e) => setCustomPresetName(e.target.value)}
                  />
                </div>
                <Button
                  onClick={handleSavePreset}
                  disabled={!customPresetName.trim()}
                >
                  Save Preset
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Active Filters Summary */}
        {hasActiveFilters && !isExpanded && (
          <div className="text-xs text-slate-500">
            {filters.searchTerm && <span>Search: "{filters.searchTerm}" • </span>}
            {filters.qcStatus !== 'all' && <span>Status: {filters.qcStatus} • </span>}
            {filters.dateRange !== 'all' && <span>Date: {filters.dateRange} • </span>}
            {filters.hasPriority && <span>Priority • </span>}
            {filters.hasDiscrepancies && <span>Discrepancies • </span>}
            {filters.supplier && <span>Supplier: {filters.supplier} • </span>}
            {filters.location && <span>Location: {filters.location}</span>}
          </div>
        )}
      </div>
    </Card>
  )
}
