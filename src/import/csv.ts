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

  // Normalise line endings up front rather than branching on \r everywhere,
  // and drop a leading UTF-8 BOM.
  //
  // The BOM strip is defensive, not a fix for an observed break: real
  // exports do carry one (Vancity's Visa history is UTF-8-with-BOM), but
  // the browser upload path decodes via Blob.text(), and "UTF-8 decode"
  // per the Encoding Standard already removes it — so today it never
  // reaches here. It is guarded anyway because the failure mode is
  // silent and total rather than loud: a surviving BOM sits before the
  // first field's opening quote, so the first column's HEADER parses as
  // "\ufeffDate", every `record['Date']` lookup misses, and a perfectly
  // good file reads as "every row skipped: unrecognized date" with no
  // hint why. Any path that doesn't go through Blob.text() (a
  // server-side read, a different client, a raw fetch) would hit exactly
  // that. Cheap here, and a file-level artifact rather than any one
  // bank's quirk, so it belongs in the reader rather than a parser.
  const src = text
    .replace(/^\ufeff/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

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
