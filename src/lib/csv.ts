export type CsvParseResult = {
  headers: string[];
  rows: string[][];
  delimiter: string;
  truncated: boolean;
};

const DEFAULT_DELIMITERS = [',', '\t', ';'];

function detectDelimiter(line: string): string {
  let best = ',';
  let bestCount = -1;
  for (const delimiter of DEFAULT_DELIMITERS) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        const next = line[i + 1];
        if (inQuotes && next === '"') {
          i += 1;
          continue;
        }
        inQuotes = !inQuotes;
        continue;
      }
      if (!inQuotes && ch === delimiter) {
        count += 1;
      }
    }
    if (count > bestCount) {
      bestCount = count;
      best = delimiter;
    }
  }
  return best;
}

export function parseCsv(text: string, maxRows?: number): CsvParseResult {
  const sanitized = text.replace(/^\uFEFF/, '');
  const firstLineEnd = sanitized.search(/\r?\n/);
  const firstLine = firstLineEnd >= 0 ? sanitized.slice(0, firstLineEnd) : sanitized;
  const delimiter = detectDelimiter(firstLine);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let truncated = false;

  for (let i = 0; i < sanitized.length; i += 1) {
    const ch = sanitized[i];
    const next = sanitized[i + 1];

    if (inQuotes) {
      if (ch === '"') {
        if (next === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === delimiter) {
      row.push(field);
      field = '';
      continue;
    }

    if (ch === '\n') {
      row.push(field);
      field = '';
      const isEmptyRow = row.every((value) => value.trim() === '');
      if (!isEmptyRow) {
        rows.push(row);
        if (maxRows && rows.length >= maxRows) {
          truncated = true;
          break;
        }
      }
      row = [];
      continue;
    }

    if (ch === '\r') {
      continue;
    }

    field += ch;
  }

  if (!truncated && (field.length > 0 || row.length > 0)) {
    row.push(field);
    const isEmptyRow = row.every((value) => value.trim() === '');
    if (!isEmptyRow) {
      rows.push(row);
    }
  }

  const [headerRow, ...dataRows] = rows;
  const headers = (headerRow ?? []).map((h) => h.trim());

  return { headers, rows: dataRows, delimiter, truncated };
}

export function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9]/g, '');
}
