import { describe, expect, it } from 'vitest';
import { parseCsvRecords } from '../../src/import/csv';

describe('UTF-8 BOM', () => {
  it('strips a leading BOM so the first column header is matchable', () => {
    // Vancity's Visa export is BOM'd on disk. Blob.text() strips it
    // before we ever see it, so this guards the paths that don't —
    // where the failure is silent and total: the first header parses as
    // "\ufeffDate", every record['Date'] lookup misses, and a valid file
    // reads as "every row skipped: unrecognized date".
    const records = parseCsvRecords('\ufeff"Date","Amount"\n"2026-08-16","$31.36"\n');
    expect(Object.keys(records[0]!)).toEqual(['Date', 'Amount']);
    expect(records[0]?.['Date']).toBe('2026-08-16');
  });

  it('leaves a BOM-less file exactly as before', () => {
    const records = parseCsvRecords('"Date","Amount"\n"2026-08-16","$31.36"\n');
    expect(records[0]?.['Date']).toBe('2026-08-16');
  });

  it('only strips the BOM at the very start, not a stray one mid-file', () => {
    const records = parseCsvRecords('\ufeff"Date","Note"\n"2026-08-16","a\ufeffb"\n');
    expect(records[0]?.['Note']).toBe('a\ufeffb');
  });
});
