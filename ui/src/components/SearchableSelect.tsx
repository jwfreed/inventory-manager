import { Combobox } from './Combobox'

export type SearchableSelectOption = {
  value: string
  label: string
  keywords?: string
}

type Props = {
  label: string
  value: string
  options: SearchableSelectOption[]
  placeholder?: string
  disabled?: boolean
  onChange: (nextValue: string) => void
}

export function SearchableSelect({
  label,
  value,
  options,
  placeholder,
  disabled,
  onChange,
}: Props) {
  return (
    <Combobox
      label={label}
      value={value}
      options={options.map((option) => ({
        value: option.value,
        label: option.label,
        keywords: option.keywords,
      }))}
      placeholder={placeholder ?? 'Search…'}
      disabled={disabled}
      showSelectedValue
      onChange={onChange}
    />
  )
}
