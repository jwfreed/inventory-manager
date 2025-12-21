const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''

export function buildUrl(path: string) {
  if (path.startsWith('http')) return path

  const normalizedPath = path.startsWith('/') ? path : `/${path}`

  // If no explicit base URL is provided, prefer calling via Vite proxy at /api/*.
  if (!API_BASE_URL) {
    return normalizedPath.startsWith('/api') ? normalizedPath : `/api${normalizedPath}`
  }

  const normalizedBase = API_BASE_URL.endsWith('/') ? API_BASE_URL.slice(0, -1) : API_BASE_URL
  return `${normalizedBase}${normalizedPath}`
}
