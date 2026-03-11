import { SectionNav } from '@shared/ui'

type SectionLink = {
  id: string
  label: string
}

type Props = {
  sections: SectionLink[]
}

export function ItemSectionNav({ sections }: Props) {
  return <SectionNav sections={sections} ariaLabel="Item page sections" />
}
