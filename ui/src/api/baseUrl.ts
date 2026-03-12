const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''

function getDefaultDevApiBaseUrl() {
  if (!import.meta.env.DEV || typeof window === 'undefined') {
    return ''
  }

  return `${window.location.protocol}//${window.location.hostname}:3100`
}

function getResolvedApiBaseUrl() {
  if (!API_BASE_URL) {
    return getDefaultDevApiBaseUrl()
  }

  if (
    import.meta.env.DEV
    && typeof window !== 'undefined'
    && /^https?:\/\/(localhost|127\.0\.0\.1):3000\/?$/i.test(API_BASE_URL)
  ) {
    return getDefaultDevApiBaseUrl()
  }

  return API_BASE_URL
}

export function buildUrl(path: string) {
  if (path.startsWith('http')) return path

  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const resolvedApiBaseUrl = getResolvedApiBaseUrl()

  // If no explicit base URL is provided outside dev, prefer calling via Vite proxy at /api/*.
  if (!resolvedApiBaseUrl) {
    return normalizedPath.startsWith('/api') ? normalizedPath : `/api${normalizedPath}`
  }

  const normalizedBase = resolvedApiBaseUrl.endsWith('/')
    ? resolvedApiBaseUrl.slice(0, -1)
    : resolvedApiBaseUrl
  return `${normalizedBase}${normalizedPath}`
}
