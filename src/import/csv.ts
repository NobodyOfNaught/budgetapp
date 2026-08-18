// A small RFC4180-ish CSV reader. Deliberately not a dependency: statement
// exports are plain comma-separated text with quoted fields, and the whole
// grammar that matters is "quotes protect commas and newlines, and a
// doubled quote inside a quoted field is a literal quote".
//
// Pure string handling, no I/O — same discipline as src/domain/.

/** Splits CSV text into rows of raw string cells. Blank lines are dropped (exports routinely end with one). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  // Normalise line endings up front rather than branching on \r everywhere.
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    // Drop rows that are entirely empty — a trailing newline would
    // otherwise produce a phantom [''] row on every file.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const char = src[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (src[i + 1] === '"') {
          field += '"'; // escaped quote
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (char === ',') {
      endField();
      i++;
      continue;
    }
    if (char === '\n') {
      endRow();
      i++;
      continue;
    }
    field += char;
    i++;
  }

  // Whatever is buffered when the text runs out is the last row, unless the
  // file ended on a newline (in which case there's nothing pending).
  if (field !== '' || row.length > 0) endRow();

  return rows;
}

/**
 * Parses CSV text into record objects keyed by the header row's column
 * names. Headers are trimmed; duplicate headers keep the last occurrence.
 * Returns an empty array for text with no data rows.
 */
export function parseCsvRecords(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) return [];

  const columns = header.map((h) => h.trim());
  return rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    columns.forEach((name, index) => {
      record[name] = (row[index] ?? '').trim();
    });
    return record;
  });
}
