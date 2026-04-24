import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import {
  ReceivingProvider,
  buildQueuedQcEventPayload,
  resolveQueuedQcEventPayload,
  useReceivingContext,
} from '../../features/receiving/context/ReceivingContext'
import { createTestQueryClient } from '../testUtils'

vi.mock('@shared/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'user@example.com' } }),
}))
vi.mock('@shared', () => ({
  useDebouncedValue: (value: string) => value,
}))
vi.mock('@features/purchaseOrders/queries', () => ({
  purchaseOrdersQueryKeys: {
    all: ['purchase-orders'],
    detail: (id: string) => ['purchase-orders', id],
  },
  usePurchaseOrder: vi.fn(() => ({ data: null, isLoading: false, isError: false, error: null })),
  usePurchaseOrdersList: vi.fn(() => ({ data: { data: [] }, isLoading: false, isError: false, error: null })),
}))
vi.mock('@features/locations/queries', () => ({
  useLocationsList: vi.fn(() => ({ data: { data: [] }, isLoading: false, isError: false, error: null })),
}))
vi.mock('../../features/receiving/api/receipts', () => ({
  createReceipt: vi.fn(),
  voidReceiptApi: vi.fn(),
}))
vi.mock('../../features/receiving/api/putaways', () => ({
  createPutaway: vi.fn(),
  postPutaway: vi.fn(),
}))
vi.mock('../../features/receiving/api/qc', async () => {
  const actual = await vi.importActual<typeof import('../../features/receiving/api/qc')>(
    '../../features/receiving/api/qc',
  )
  return {
    ...actual,
    createQcEvent: vi.fn(),
    resolveHoldDisposition: vi.fn(),
  }
})
vi.mock('../../features/receiving/queries', () => ({
  receivingQueryKeys: {
    receipts: {
      detail: (id: string) => ['receipts', id],
      all: ['receipts'],
    },
    qcEvents: {
      forLine: (id: string) => ['qc-events', id],
    },
  },
  usePutaway: vi.fn(() => ({ data: null, isLoading: false, isError: false, error: null, refetch: vi.fn() })),
  useQcEventsForLine: vi.fn(() => ({ data: { data: [] }, isLoading: false, isError: false, error: null })),
  useReceipt: vi.fn(() => ({
    data: {
      id: 'receipt-1',
      status: 'posted',
      receivedToLocationId: 'qa-1',
      lines: [
        {
          id: 'line-1',
          purchaseOrderReceiptId: 'receipt-1',
          quantityReceived: 5,
          uom: 'each',
          qcSummary: {
            remainingUninspectedQuantity: 5,
            breakdown: { accept: 0, hold: 0, reject: 0 },
          },
        },
      ],
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  })),
  useReceiptsList: vi.fn(() => ({
    data: { data: [] },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  })),
}))
vi.mock('../../features/receiving/hooks/useOfflineQueue', () => ({
  useOfflineQueue: vi.fn(),
}))

import { createQcEvent } from '../../features/receiving/api/qc'
import { useOfflineQueue } from '../../features/receiving/hooks/useOfflineQueue'

const mockedCreateQcEvent = vi.mocked(createQcEvent)
const mockedUseOfflineQueue = vi.mocked(useOfflineQueue)
let queueOperationMock = vi.fn()

function QuickAcceptOnceProbe() {
  const ctx = useReceivingContext()
  return (
    <button
      type="button"
      onClick={() => {
        void ctx.onQuickAcceptQc()
      }}
    >
      quick accept once
    </button>
  )
}

function QuickAcceptProbe() {
  const ctx = useReceivingContext()
  return (
    <button
      type="button"
      onClick={() => {
        void ctx.onQuickAcceptQc()
        void ctx.onQuickAcceptQc()
      }}
    >
      quick accept twice
    </button>
  )
}

function RecordQcProbe() {
  const ctx = useReceivingContext()
  return (
    <button
      type="button"
      onClick={() => {
        void ctx.onCreateQcEvent()
        void ctx.onCreateQcEvent()
      }}
    >
      record qc twice
    </button>
  )
}

function ShortcutProbe() {
  const ctx = useReceivingContext()
  return (
    <button
      type="button"
      onClick={() => {
        void ctx.onSubmitQcShortcutEvent({
          purchaseOrderReceiptLineId: 'line-1',
          eventType: 'hold',
          quantity: 5,
          uom: 'each',
          reasonCode: 'damaged',
          actorType: 'user',
        })
        void ctx.onSubmitQcShortcutEvent({
          purchaseOrderReceiptLineId: 'line-1',
          eventType: 'hold',
          quantity: 5,
          uom: 'each',
          reasonCode: 'damaged',
          actorType: 'user',
        })
      }}
    >
      shortcut twice
    </button>
  )
}

function renderProvider(ui: ReactNode) {
  const queryClient = createTestQueryClient()
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/receiving/qc?receiptId=receipt-1&qcLineId=line-1']}>
        <ReceivingProvider>{ui}</ReceivingProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('receiving QC safety', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queueOperationMock = vi.fn().mockResolvedValue('queued-1')
    mockedUseOfflineQueue.mockImplementation(() => ({
      isOnline: true,
      pendingCount: 0,
      pendingOperations: [],
      isSyncing: false,
      queueOperation: queueOperationMock,
      syncPendingOperations: vi.fn(),
      clearQueue: vi.fn(),
    }))
  })

  it('blocks duplicate quick accept submission while pending', async () => {
    mockedCreateQcEvent.mockImplementation(
      () =>
        new Promise(() => {
          // Keep the mutation pending so the second call must be blocked synchronously.
        }),
    )

    renderProvider(<QuickAcceptProbe />)

    fireEvent.click(screen.getByRole('button', { name: 'quick accept twice' }))

    await waitFor(() => {
      expect(mockedCreateQcEvent).toHaveBeenCalledTimes(1)
    })
  })

  it('blocks duplicate record QC submission while pending', async () => {
    mockedCreateQcEvent.mockImplementation(
      () =>
        new Promise(() => {
          // Keep the mutation pending so the second record call must be blocked synchronously.
        }),
    )

    renderProvider(<RecordQcProbe />)

    fireEvent.click(screen.getByRole('button', { name: 'record qc twice' }))

    await waitFor(() => {
      expect(mockedCreateQcEvent).toHaveBeenCalledTimes(1)
    })
  })

  it('blocks duplicate shortcut submission while pending', async () => {
    mockedCreateQcEvent.mockImplementation(
      () =>
        new Promise(() => {
          // Keep the mutation pending so the second shortcut call must be blocked synchronously.
        }),
    )

    renderProvider(<ShortcutProbe />)

    fireEvent.click(screen.getByRole('button', { name: 'shortcut twice' }))

    await waitFor(() => {
      expect(mockedCreateQcEvent).toHaveBeenCalledTimes(1)
    })
  })

  it('blocks duplicate offline quick accept queueing while the operation is being enqueued', async () => {
    queueOperationMock = vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve('queued-1'), 10)
        }),
    )
    mockedUseOfflineQueue.mockImplementation(() => ({
      isOnline: false,
      pendingCount: 0,
      pendingOperations: [],
      isSyncing: false,
      queueOperation: queueOperationMock,
      syncPendingOperations: vi.fn(),
      clearQueue: vi.fn(),
    }))

    renderProvider(<QuickAcceptProbe />)

    fireEvent.click(screen.getByRole('button', { name: 'quick accept twice' }))

    await waitFor(() => {
      expect(queueOperationMock).toHaveBeenCalledTimes(1)
    })
  })

  it('reuses the same key for a retry before success, then clears it after success', async () => {
    mockedCreateQcEvent
      .mockRejectedValueOnce(new Error('temporary qc failure'))
      .mockResolvedValueOnce({
        id: 'qc-1',
        eventType: 'accept',
        quantity: 5,
        uom: 'each',
      } as any)
      .mockResolvedValueOnce({
        id: 'qc-2',
        eventType: 'accept',
        quantity: 5,
        uom: 'each',
      } as any)

    renderProvider(<QuickAcceptOnceProbe />)

    fireEvent.click(screen.getByRole('button', { name: 'quick accept once' }))
    await waitFor(() => {
      expect(mockedCreateQcEvent).toHaveBeenCalledTimes(1)
    })

    fireEvent.click(screen.getByRole('button', { name: 'quick accept once' }))
    await waitFor(() => {
      expect(mockedCreateQcEvent).toHaveBeenCalledTimes(2)
    })

    fireEvent.click(screen.getByRole('button', { name: 'quick accept once' }))
    await waitFor(() => {
      expect(mockedCreateQcEvent).toHaveBeenCalledTimes(3)
    })

    const firstRetryKey = mockedCreateQcEvent.mock.calls[0]?.[1]?.idempotencyKey
    const secondRetryKey = mockedCreateQcEvent.mock.calls[1]?.[1]?.idempotencyKey
    const postSuccessKey = mockedCreateQcEvent.mock.calls[2]?.[1]?.idempotencyKey

    expect(firstRetryKey).toBeTruthy()
    expect(secondRetryKey).toBe(firstRetryKey)
    expect(postSuccessKey).toBeTruthy()
    expect(postSuccessKey).not.toBe(firstRetryKey)
  })

  it('retains the original queued QC event key for replay', async () => {
    mockedUseOfflineQueue.mockImplementation(() => ({
      isOnline: false,
      pendingCount: 0,
      pendingOperations: [],
      isSyncing: false,
      queueOperation: queueOperationMock,
      syncPendingOperations: vi.fn(),
      clearQueue: vi.fn(),
    }))

    renderProvider(<QuickAcceptOnceProbe />)

    fireEvent.click(screen.getByRole('button', { name: 'quick accept once' }))

    await waitFor(() => {
      expect(queueOperationMock).toHaveBeenCalledTimes(1)
    })

    const queuedOperation = queueOperationMock.mock.calls[0]?.[0]
    const queuedPayload = queuedOperation?.payload as Record<string, unknown>
    const replayPayload = resolveQueuedQcEventPayload(queuedPayload)

    expect(typeof queuedPayload.idempotencyKey).toBe('string')
    expect(replayPayload.idempotencyKey).toBe(queuedPayload.idempotencyKey)
    expect(replayPayload.request).toEqual((queuedPayload as { request: unknown }).request)
  })

  it('upgrades legacy queued QC payloads by generating one replay key and reusing it thereafter', () => {
    const legacyRequest = {
      purchaseOrderReceiptLineId: 'line-1',
      eventType: 'accept' as const,
      quantity: 5,
      uom: 'each',
      actorType: 'user' as const,
    }

    const legacyReplay = resolveQueuedQcEventPayload(legacyRequest)
    expect(legacyReplay.persistedPayload).not.toBeNull()
    expect(legacyReplay.persistedPayload?.idempotencyKey).toBe(legacyReplay.idempotencyKey)

    const nextReplay = resolveQueuedQcEventPayload(legacyReplay.persistedPayload ?? buildQueuedQcEventPayload(legacyRequest))
    expect(nextReplay.idempotencyKey).toBe(legacyReplay.idempotencyKey)
    expect(nextReplay.persistedPayload).toBeNull()
  })
})
