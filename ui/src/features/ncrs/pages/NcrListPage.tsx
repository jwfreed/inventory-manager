import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { listNcrs } from '../api/ncrs'
import type { Ncr } from '../types'
import { Table } from '../../../components/Table'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { LoadingSpinner } from '../../../components/Loading'
import { ErrorState } from '../../../components/ErrorState'

export default function NcrListPage() {
  const [ncrs, setNcrs] = useState<Ncr[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'open' | 'closed'>('open')

  const loadNcrs = useCallback(async () => {
    setLoading(true)
    try {
      const res = await listNcrs(filter)
      setNcrs(res.data)
      setError(null)
    } catch {
      setError('Failed to load NCRs')
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    loadNcrs()
  }, [loadNcrs])

  if (loading && ncrs.length === 0) return <LoadingSpinner />
  if (error) return <ErrorState error={{ status: 500, message: error }} onRetry={loadNcrs} />

  const columns = [
    { 
      header: 'NCR #', 
      accessor: 'ncr_number' as keyof Ncr,
      render: (val: unknown) => <span className="font-medium">{val as string}</span>
    },
    { 
      header: 'Status', 
      accessor: 'status' as keyof Ncr, 
      render: (val: unknown) => (
        <Badge variant={val === 'open' ? 'warning' : 'success'}>
          {(val as string).toUpperCase()}
        </Badge>
      ) 
    },
    { 
      header: 'Item / Qty', 
      accessor: 'quantity' as keyof Ncr, 
      render: (val: unknown, row: Ncr) => `${val} ${row.uom}` 
    },
    { 
      header: 'Reason', 
      accessor: 'reason_code' as keyof Ncr, 
      render: (val: unknown) => (val as string) || '-' 
    },
    { 
      header: 'Created At', 
      accessor: 'created_at' as keyof Ncr, 
      render: (val: unknown) => new Date(val as string).toLocaleDateString() 
    },
    { 
      header: 'Action', 
      accessor: 'id' as keyof Ncr, 
      render: (id: unknown) => (
        <Link to={`/ncrs/${id as string}`}>
          <Button size="sm" variant="secondary">View</Button>
        </Link>
      ) 
    }
  ]

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Non-Conformance Reports (NCR)</h1>
        <div className="flex space-x-2">
          <Button 
            variant={filter === 'open' ? 'primary' : 'secondary'} 
            onClick={() => setFilter('open')}
          >
            Open
          </Button>
          <Button 
            variant={filter === 'closed' ? 'primary' : 'secondary'} 
            onClick={() => setFilter('closed')}
          >
            Closed
          </Button>
        </div>
      </div>

      <Table<Ncr> 
        columns={columns} 
        data={ncrs} 
      />
    </div>
  )
}
