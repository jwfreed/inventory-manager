import { describe, expect, it, beforeEach, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { WorkCenterForm } from '@features/routings/components/WorkCenterForm'
import { renderWithQueryClient } from '../testUtils'

vi.mock('@features/locations/api/locations', () => ({
  listLocations: vi.fn(),
}))

import { listLocations } from '@features/locations/api/locations'

const mockedListLocations = vi.mocked(listLocations)

function getInputByLabelText(label: string, type: 'input' | 'select' | 'textarea' = 'input') {
  const labelNode = screen.getByText(label)
  const root = labelNode.closest('div')
  if (!root) throw new Error(`Unable to find parent for label: ${label}`)
  const selector = type === 'input' ? 'input' : type === 'select' ? 'select' : 'textarea'
  const field = root.querySelector(selector)
  if (!field) throw new Error(`Unable to find ${selector} for label: ${label}`)
  return field as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
}

describe('WorkCenterForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedListLocations.mockResolvedValue({
      data: [{ id: 'loc-1', code: 'FG', name: 'Finished Goods' } as any],
    })
  })

  it('validates required fields', async () => {
    const onSubmit = vi.fn()

    renderWithQueryClient(<WorkCenterForm onSubmit={onSubmit} onCancel={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Code is required')).toBeInTheDocument()
    expect(screen.getByText('Name is required')).toBeInTheDocument()
    expect(screen.getByText('Receive-to location is required')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('requires location when code and name are provided', async () => {
    const onSubmit = vi.fn()

    renderWithQueryClient(<WorkCenterForm onSubmit={onSubmit} onCancel={vi.fn()} />)

    fireEvent.change(getInputByLabelText('Code') as HTMLInputElement, { target: { value: 'PACK' } })
    fireEvent.change(getInputByLabelText('Production Area Name') as HTMLInputElement, {
      target: { value: 'Packaging' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Receive-to location is required')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('toggles advanced section', async () => {
    renderWithQueryClient(<WorkCenterForm onSubmit={vi.fn()} onCancel={vi.fn()} />)

    const summary = screen.getByText('Advanced')
    const details = summary.closest('details')
    expect(details).toBeTruthy()
    expect(details).not.toHaveAttribute('open')

    fireEvent.click(summary)
    expect(details).toHaveAttribute('open')
    expect(screen.getByText('Hourly Rate (informational only)')).toBeInTheDocument()
    expect(screen.getByText('Capacity (informational only)')).toBeInTheDocument()
  })

  it('submits expected payload', async () => {
    const onSubmit = vi.fn()
    renderWithQueryClient(<WorkCenterForm onSubmit={onSubmit} onCancel={vi.fn()} />)

    expect(await screen.findByText('Finished Goods (FG)')).toBeInTheDocument()

    fireEvent.change(getInputByLabelText('Code') as HTMLInputElement, { target: { value: 'PACK' } })
    fireEvent.change(getInputByLabelText('Production Area Name') as HTMLInputElement, {
      target: { value: 'Packaging' },
    })
    const locationSelect = getInputByLabelText('Location (Receive-to)', 'select') as HTMLSelectElement
    fireEvent.change(locationSelect, {
      target: { value: 'loc-1' },
    })
    expect(locationSelect.value).toBe('loc-1')
    fireEvent.change(getInputByLabelText('Status', 'select') as HTMLSelectElement, {
      target: { value: 'active' },
    })
    fireEvent.change(getInputByLabelText('Description (optional)', 'textarea') as HTMLTextAreaElement, {
      target: { value: 'Optional' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1)
    })
    expect(onSubmit.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        code: 'PACK',
        name: 'Packaging',
        locationId: 'loc-1',
        status: 'active',
        description: 'Optional',
      }),
    )
  })

  it('supports cancel action', async () => {
    const onCancel = vi.fn()
    renderWithQueryClient(<WorkCenterForm onSubmit={vi.fn()} onCancel={onCancel} />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
