import { NextResponse } from 'next/server'

// First CSV export in the codebase — kept deliberately small rather than
// pulling in a CSV library for two export shapes. Escapes per RFC 4180:
// any value containing a comma, quote, or newline gets wrapped in quotes,
// with internal quotes doubled. Values are stringified as-is otherwise
// (numbers/booleans pass through String()), so callers control formatting
// (e.g. toFixed()) before handing rows to this function.
// Leading =, +, -, @, tab, or CR makes Excel/Sheets treat the cell as a
// formula on open rather than literal text — e.g. a credential label of
// `=HYPERLINK("http://evil.example","click")` or a DDE payload. Prefixing
// with a single quote forces spreadsheet apps to render it as plain text;
// RFC 4180 has no opinion on this (it's an application-layer convention,
// not a CSV-format one), so it's applied here rather than folded into the
// quote-wrapping logic below.
const FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/

function escapeCsvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value)
  if (FORMULA_TRIGGER_RE.test(s)) {
    s = `'${s}`
  }
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export interface CsvColumn<T> {
  header: string
  value: (row: T) => unknown
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const headerLine = columns.map(c => escapeCsvCell(c.header)).join(',')
  const lines = rows.map(row => columns.map(c => escapeCsvCell(c.value(row))).join(','))
  // \r\n line endings — the conventional CSV terminator, and what makes
  // Excel (still the most common consumer of an exported CSV) reliably
  // recognize the file rather than occasionally rendering everything as
  // one unbroken row.
  return [headerLine, ...lines].join('\r\n') + '\r\n'
}

// filename should already be a safe, extension-free base name — this just
// appends .csv and today's date so repeat exports don't silently overwrite
// each other in a downloads folder.
export function csvResponse(csv: string, filenameBase: string): NextResponse {
  const date = new Date().toISOString().slice(0, 10)
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filenameBase}-${date}.csv"`,
    },
  })
}
