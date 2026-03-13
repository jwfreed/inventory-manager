const DISPLAY_DATE_PATTERN = /^(\d{2})-(\d{2})-(\d{2})$/;

function normalizeYear(twoDigitYear: number) {
  return 2000 + twoDigitYear;
}

export function parseDateInput(value?: string | null): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const match = DISPLAY_DATE_PATTERN.exec(trimmed);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = normalizeYear(Number(match[3]));
    const parsed = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
      return null;
    }
    return parsed;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

export function normalizeDateInputToIso(value?: string | null) {
  const parsed = parseDateInput(value);
  return parsed ? parsed.toISOString() : null;
}

export function formatDateDisplay(value?: string | number | Date | null) {
  if (!value) return ''
  const parsed = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(parsed.getTime())) return ''
  const day = String(parsed.getUTCDate()).padStart(2, '0')
  const month = String(parsed.getUTCMonth() + 1).padStart(2, '0')
  const year = String(parsed.getUTCFullYear()).slice(-2)
  return `${day}-${month}-${year}`
}
