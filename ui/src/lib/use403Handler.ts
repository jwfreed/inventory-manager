import { useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'

/**
 * Listens for the 'api:forbidden' custom event dispatched by the API
 * client when a 403 response is received. Navigates to /forbidden unless
 * the current path is already /forbidden or /login (prevents redirect loops).
 */
export function use403Handler() {
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    const handleForbidden = () => {
      if (location.pathname !== '/forbidden' && location.pathname !== '/login') {
        navigate('/forbidden', { replace: true })
      }
    }

    window.addEventListener('api:forbidden', handleForbidden)
    return () => window.removeEventListener('api:forbidden', handleForbidden)
  }, [navigate, location.pathname])
}
