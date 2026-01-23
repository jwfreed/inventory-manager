import { Alert, Button } from '@shared/ui'

export default function OnboardingTip({
  title,
  message,
  onDismiss,
}: {
  title: string
  message: string
  onDismiss: () => void
}) {
  return (
    <Alert
      variant="info"
      title={title}
      message={message}
      action={
        <Button size="sm" variant="secondary" onClick={onDismiss}>
          Got it
        </Button>
      }
    />
  )
}
