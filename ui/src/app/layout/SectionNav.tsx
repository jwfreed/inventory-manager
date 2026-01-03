import { useState, useEffect } from 'react'
import { NavLink } from 'react-router-dom'
import type { AppNavItem, NavSection } from '@shared/routes'
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline'

interface SectionNavProps {
  navItems: AppNavItem[]
}

interface GroupedNav {
  [key: string]: AppNavItem[]
}

const sectionConfig: Record<NavSection, { label: string; order: number }> = {
  dashboard: { label: 'Dashboard', order: 1 },
  inbound: { label: 'Inbound', order: 2 },
  inventory: { label: 'Inventory', order: 3 },
  production: { label: 'Production', order: 4 },
  outbound: { label: 'Outbound', order: 5 },
  reports: { label: 'Reports', order: 6 },
  'master-data': { label: 'Master Data', order: 7 },
  profile: { label: 'Profile', order: 8 },
}

const EXPANDED_SECTIONS_KEY = 'nav-expanded-sections'

export default function SectionNav({ navItems }: SectionNavProps) {
  // Load expanded sections from localStorage or default to all expanded
  const [expandedSections, setExpandedSections] = useState<Set<NavSection>>(() => {
    const saved = localStorage.getItem(EXPANDED_SECTIONS_KEY)
    if (saved) {
      try {
        return new Set(JSON.parse(saved))
      } catch {
        // If parsing fails, default to all expanded
      }
    }
    // Default: expand all except profile
    return new Set(['dashboard', 'inbound', 'inventory', 'production', 'outbound', 'reports', 'master-data'])
  })

  // Save expanded sections to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem(EXPANDED_SECTIONS_KEY, JSON.stringify(Array.from(expandedSections)))
  }, [expandedSections])

  const toggleSection = (section: NavSection) => {
    setExpandedSections((prev) => {
      const next = new Set(prev)
      if (next.has(section)) {
        next.delete(section)
      } else {
        next.add(section)
      }
      return next
    })
  }

  // Group nav items by section
  const groupedNav = navItems.reduce<GroupedNav>((acc, item) => {
    const section = item.section || 'dashboard'
    if (!acc[section]) {
      acc[section] = []
    }
    acc[section].push(item)
    return acc
  }, {})

  // Sort items within each section by order
  Object.keys(groupedNav).forEach((section) => {
    groupedNav[section].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  })

  // Sort sections by configured order
  const sortedSections = Object.keys(groupedNav).sort((a, b) => {
    const orderA = sectionConfig[a as NavSection]?.order ?? 99
    const orderB = sectionConfig[b as NavSection]?.order ?? 99
    return orderA - orderB
  }) as NavSection[]

  return (
    <nav className="flex-1 space-y-1 px-2 py-4">
      {sortedSections.map((section) => {
        const items = groupedNav[section]
        const config = sectionConfig[section]
        const isExpanded = expandedSections.has(section)
        
        // Dashboard section is special - no collapse, just the link
        if (section === 'dashboard' && items.length === 1) {
          const item = items[0]
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `group flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                  isActive
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900'
                }`
              }
              title={item.description}
            >
              {item.label}
            </NavLink>
          )
        }

        return (
          <div key={section} className="space-y-1">
            {/* Section Header */}
            <button
              onClick={() => toggleSection(section)}
              className="w-full group flex items-center px-3 py-2 text-sm font-semibold text-gray-900 hover:bg-gray-50 rounded-md transition-colors"
            >
              {isExpanded ? (
                <ChevronDownIcon className="mr-2 h-4 w-4 text-gray-500" />
              ) : (
                <ChevronRightIcon className="mr-2 h-4 w-4 text-gray-500" />
              )}
              {config?.label || section}
            </button>

            {/* Section Items */}
            {isExpanded && (
              <div className="space-y-1">
                {items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      `group flex items-center pl-9 pr-3 py-2 text-sm font-normal rounded-md transition-colors ${
                        isActive
                          ? 'bg-blue-50 text-blue-700'
                          : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                      }`
                    }
                    title={item.description}
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </nav>
  )
}
