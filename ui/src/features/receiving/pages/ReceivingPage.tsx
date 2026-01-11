import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

export default function ReceivingPage() {
  const navigate = useNavigate()

  useEffect(() => {
    // Redirect to the new receipt capture page
    navigate('/receiving/receipt', { replace: true })
  }, [navigate])

  return null
}
