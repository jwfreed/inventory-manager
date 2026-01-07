import { useState, useRef } from 'react'
import { toPng, toSvg } from 'html-to-image'
import { Button } from '@shared/ui'

type ExportFormat = 'png' | 'svg'

interface ChartExportButtonProps {
  chartRef: React.RefObject<HTMLDivElement | null>
  chartName: string
  disabled?: boolean
}

export function ChartExportButton({ chartRef, chartName, disabled }: ChartExportButtonProps) {
  const [isExporting, setIsExporting] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const handleExport = async (format: ExportFormat) => {
    if (!chartRef.current || isExporting) return

    setIsExporting(true)
    setShowDropdown(false)

    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)
      const filename = `${chartName}-${timestamp}.${format}`

      let dataUrl: string
      if (format === 'png') {
        dataUrl = await toPng(chartRef.current, {
          quality: 0.95,
          pixelRatio: 2,
          backgroundColor: '#ffffff',
        })
      } else {
        dataUrl = await toSvg(chartRef.current, {
          backgroundColor: '#ffffff',
        })
      }

      // Download the image
      const link = document.createElement('a')
      link.download = filename
      link.href = dataUrl
      link.click()
    } catch (error) {
      console.error('Failed to export chart:', error)
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => setShowDropdown(!showDropdown)}
        disabled={disabled || isExporting}
      >
        {isExporting ? 'Exporting...' : 'Export Chart'}
      </Button>

      {showDropdown && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setShowDropdown(false)}
          />
          
          {/* Dropdown Menu */}
          <div className="absolute right-0 mt-2 w-40 bg-white border border-slate-200 rounded-lg shadow-lg z-20">
            <button
              type="button"
              onClick={() => handleExport('png')}
              className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 rounded-t-lg transition-colors"
            >
              Export as PNG
            </button>
            <button
              type="button"
              onClick={() => handleExport('svg')}
              className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 rounded-b-lg transition-colors"
            >
              Export as SVG
            </button>
          </div>
        </>
      )}
    </div>
  )
}
