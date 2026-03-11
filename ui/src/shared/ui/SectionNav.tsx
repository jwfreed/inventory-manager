type SectionLink = {
  id: string
  label: string
}

type Props = {
  sections: readonly SectionLink[]
  ariaLabel?: string
}

export function SectionNav({
  sections,
  ariaLabel = 'Page sections',
}: Props) {
  return (
    <nav
      aria-label={ariaLabel}
      className="sticky top-4 z-20 overflow-x-auto rounded-2xl border border-slate-200 bg-white/90 px-2 py-2 shadow-sm shadow-slate-950/5 backdrop-blur"
    >
      <div className="flex min-w-max gap-2">
        {sections.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="rounded-xl px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
          >
            {section.label}
          </a>
        ))}
      </div>
    </nav>
  )
}
