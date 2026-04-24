import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQcEvent } from '../../features/receiving/api/qc'

describe('receiving qc api', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('sends Idempotency-Key for QC event requests', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: 'qc-1',
          eventType: 'accept',
          quantity: 5,
          uom: 'each',
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await createQcEvent(
      {
        purchaseOrderReceiptLineId: 'line-1',
        eventType: 'accept',
        quantity: 5,
        uom: 'each',
        actorType: 'user',
      },
      { idempotencyKey: 'qc-event:accept:line-1:test-key' },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    const headers = init?.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toBe('qc-event:accept:line-1:test-key')
  })

  it('generates an Idempotency-Key when the caller does not provide one', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: 'qc-2',
          eventType: 'hold',
          quantity: 2,
          uom: 'each',
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await createQcEvent({
      purchaseOrderReceiptLineId: 'line-2',
      eventType: 'hold',
      quantity: 2,
      uom: 'each',
      actorType: 'user',
    })

    const [, init] = fetchMock.mock.calls[0]
    const headers = init?.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toMatch(/^qc-event:hold:line-2:/)
  })
})
