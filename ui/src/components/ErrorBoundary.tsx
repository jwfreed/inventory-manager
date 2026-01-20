import type { ReactNode } from 'react'
import { Component } from 'react'
import { logAppError } from '../utils/logAppError'

type ErrorBoundaryState = {
  hasError: boolean
  errorId: string
  error?: unknown
  componentStack?: string
}

type ErrorBoundaryProps = {
  children: ReactNode
  fallbackRender?: (state: ErrorBoundaryState) => ReactNode
}

function generateErrorId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `err_${Math.random().toString(36).slice(2, 10)}`
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private hasLogged = false

  state: ErrorBoundaryState = {
    hasError: false,
    errorId: '',
    error: undefined,
    componentStack: undefined,
  }

  static getDerivedStateFromError(error: unknown) {
    return { hasError: true, error }
  }

  componentDidCatch(error: unknown, info: { componentStack?: string }) {
    if (this.hasLogged) return
    const errorId = this.state.errorId || generateErrorId()
    const componentStack = info?.componentStack
    const payload = {
      errorId,
      name: error instanceof Error ? error.name : undefined,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      componentStack,
      url: window.location.href,
      userAgent: navigator.userAgent,
      timestamp: new Date().toISOString(),
    }
    logAppError(payload)
    this.hasLogged = true
    if (!this.state.errorId || this.state.componentStack !== componentStack) {
      this.setState({ errorId, componentStack })
    }
  }

  render() {
    const { hasError } = this.state
    if (!hasError) {
      return this.props.children
    }
    if (this.props.fallbackRender) {
      return this.props.fallbackRender(this.state)
    }
    return null
  }
}
