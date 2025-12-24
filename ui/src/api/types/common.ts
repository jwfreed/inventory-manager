export type ApiError = {
  status: number
  message: string
  details?: unknown
}

export type ApiResult<T> = {
  data?: T
  error?: ApiError
}

export type ApiNotAvailable = {
  type: 'ApiNotAvailable'
  attemptedEndpoints: string[]
}
