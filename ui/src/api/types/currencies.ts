export type Currency = {
  code: string
  name: string
  symbol: string
  decimalPlaces: number
  active: boolean
  createdAt: string
  updatedAt: string
}

export type ExchangeRate = {
  id: string
  fromCurrency: string
  toCurrency: string
  rate: number
  effectiveDate: string
  source: string | null
  createdAt: string
}

export type CreateExchangeRate = {
  fromCurrency: string
  toCurrency: string
  rate: number
  effectiveDate: string
  source?: string | null
}
