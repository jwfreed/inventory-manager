import { useState, useEffect } from 'react'

type Breakpoint = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'

type BreakpointConfig = {
  isMobile: boolean
  isTablet: boolean
  isDesktop: boolean
  currentBreakpoint: Breakpoint
  isAtLeast: (breakpoint: Breakpoint) => boolean
  isAtMost: (breakpoint: Breakpoint) => boolean
}

const breakpoints = {
  xs: 0,
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1536,
}

function getBreakpoint(width: number): Breakpoint {
  if (width >= breakpoints['2xl']) return '2xl'
  if (width >= breakpoints.xl) return 'xl'
  if (width >= breakpoints.lg) return 'lg'
  if (width >= breakpoints.md) return 'md'
  if (width >= breakpoints.sm) return 'sm'
  return 'xs'
}

export function useResponsive(): BreakpointConfig {
  const [width, setWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1024)

  useEffect(() => {
    const handleResize = () => setWidth(window.innerWidth)
    
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const currentBreakpoint = getBreakpoint(width)
  const isMobile = width < breakpoints.md
  const isTablet = width >= breakpoints.md && width < breakpoints.lg
  const isDesktop = width >= breakpoints.lg

  const isAtLeast = (breakpoint: Breakpoint) => width >= breakpoints[breakpoint]
  const isAtMost = (breakpoint: Breakpoint) => width <= breakpoints[breakpoint]

  return {
    isMobile,
    isTablet,
    isDesktop,
    currentBreakpoint,
    isAtLeast,
    isAtMost,
  }
}

// Hook for collapsible sidebar behavior
export function useCollapsibleSidebar(defaultCollapsed = false) {
  const { isMobile } = useResponsive()
  // Auto-collapse on mobile, respect default otherwise
  const [isCollapsed, setIsCollapsed] = useState(isMobile || defaultCollapsed)
  const [isOpen, setIsOpen] = useState(false)

  const toggle = () => {
    if (isMobile) {
      setIsOpen(!isOpen)
    } else {
      setIsCollapsed(!isCollapsed)
    }
  }

  const close = () => {
    if (isMobile) {
      setIsOpen(false)
    }
  }

  return {
    isMobile,
    isCollapsed,
    isOpen,
    toggle,
    close,
    shouldRenderAsSidebar: !isMobile || isOpen,
  }
}
