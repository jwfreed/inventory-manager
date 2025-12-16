import type { ApiError } from '../api/types'
import { Alert } from './Alert'
import { Button } from './Button'

type Props = {
  error: ApiError
  onRetry?: () => void
}

export function ErrorState({ error, onRetry }: Props) {
  const { status, message } = error

  if (status === 400) {
    return <Alert variant="warning" title="Validation issue" message={message} />
  }

  if (status === 404) {
    return <Alert variant="error" title="Not found" message={message} />
  }

  if (status === 409) {
    return <Alert variant="warning" title="Conflict" message={message} />
  }

  return (
    <Alert
      variant="error"
      title="Something went wrong"
      message={message || 'Unexpected error'}
      action={
        onRetry && (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        )
      }
    />
  )
}
