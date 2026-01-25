import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HomeIntro } from './Home'

describe('HomeIntro', () => {
  it('does not render the Home title or section label when showTitle is false', () => {
    render(<HomeIntro showTitle={false} role="Planner" userLabel="Jane Doe" tenantLabel="Acme" />)
    expect(screen.queryByRole('heading', { name: 'Home' })).toBeNull()
    expect(screen.queryByText('HOME')).toBeNull()
    expect(screen.getByText('Your work today.')).toBeInTheDocument()
  })
})
