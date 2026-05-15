import { cn } from '../../../lib/utils'

type SectionLink = {
  id: string
  label: string
}

type Props = {
  sections: readonly SectionLink[]
  activeSection: string
  onSectionChange: (id: string) => void
}

export function ItemSectionNav({ sections, activeSection, onSectionChange }: Props) {
  return (
    <nav
      aria-label="Item page sections"
      role="tablist"
      className="sticky top-4 z-20 overflow-x-auto rounded-2xl border border-slate-200 bg-white/90 px-2 py-2 shadow-sm shadow-slate-950/5 backdrop-blur"
    >
      <div className="flex min-w-max gap-2">
        {sections.map((section) => (
          <button
            key={section.id}
            type="button"
            role="tab"
            aria-selected={section.id === activeSection}
            onClick={() => onSectionChange(section.id)}
            className={cn(
              'rounded-xl px-3 py-2 text-sm font-medium transition',
              section.id === activeSection
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
            )}
          >
            {section.label}
          </button>
        ))}
      </div>
    </nav>
  )
}
