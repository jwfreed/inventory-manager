import { useEffect, useState } from 'react'

const SIDEBAR_QUERY = '(min-width: 1024px)'

function getSidebarMatch() {
  if (typeof window === 'undefined') return true
  return window.matchMedia(SIDEBAR_QUERY).matches
}

export function useSidebarVisibility() {
  const [isVisible, setIsVisible] = useState(getSidebarMatch)

  useEffect(() => {
    const media = window.matchMedia(SIDEBAR_QUERY)
    const handleChange = () => setIsVisible(media.matches)

    handleChange()
    if (media.addEventListener) {
      media.addEventListener('change', handleChange)
      return () => media.removeEventListener('change', handleChange)
    }

    media.addListener(handleChange)
    return () => media.removeListener(handleChange)
  }, [])

  return isVisible
}
