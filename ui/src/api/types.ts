export type ApiError = {
  status: number
  message: string
  details?: unknown
}

export type ApiResult<T> = {
  data?: T
  error?: ApiError
}
