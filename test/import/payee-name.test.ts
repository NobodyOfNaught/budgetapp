import { describe, expect, it } from 'vitest';
import { cleanPayeeName } from '../../src/import/payee-name';

// Every case here is transcribed from the real BECU export this shipped
// against (see docs/plan.md's PR 9 notes) — this file IS the spec for the
// heuristic, the same discipline as test/domain/ledger.test.ts.

describe('cleanPayeeName', () => {
  it('strips a leading auth number and cuts before a mid-string address number', () => {
    expect(cleanPayeeName('160000101207 GIANT FOOD INC #152 13 COLESVILLE   MDUS')).toBe('GIANT FOOD INC #152');
  });

  it('keeps only "MERCHANT *SUBMERCHANT" for a card-network descriptor', () => {
    expect(cleanPayeeName('UBER *TRIP HELP.UBER.C 1455 Market Street     8005928996   C')).toBe('UBER *TRIP');
    expect(cleanPayeeName('GOOGLE *FI G5BXZN 1600 AMPHITHEATRE PKWY MOUNTAIN VIEWCAUS')).toBe('GOOGLE *FI');
    // Same merchant, different auth code between months — normalizes to the same name.
    expect(cleanPayeeName('GOOGLE *FI 53874P 1600 AMPHITHEATRE PKWY MOUNTAIN VIEWCAUS')).toBe('GOOGLE *FI');
  });

  it('cuts before a standalone street-address number', () => {
    expect(cleanPayeeName('PSYCHOLOGY TODAY 927 E 8th Street Ste 11SIOUX FALLS  SDUS')).toBe('PSYCHOLOGY TODAY');
    expect(cleanPayeeName('0012356996112  AMERICAN 4000 E SKY HARBOR BL   United States')).toBe('AMERICAN');
  });

  it('cuts at an isolated " - " separator', () => {
    expect(cleanPayeeName('CHASE CREDIT CRD  - AUTOPAY')).toBe('CHASE CREDIT CRD');
    expect(cleanPayeeName('VENMO  - PAYMENT')).toBe('VENMO');
    expect(cleanPayeeName('AMERICANAIRLINES DIRECT DEPOSIT - PAYROLL')).toBe('AMERICANAIRLINES DIRECT DEPOSIT');
  });

  it('strips a trailing phone number with no separator before it', () => {
    expect(cleanPayeeName('Zelle KATHERINE ATWILL (800)233-2328')).toBe('Zelle KATHERINE ATWILL');
    expect(cleanPayeeName('Zelle Terry Sandt (800)233-2328')).toBe('Zelle Terry Sandt');
  });

  it('cuts at a " - " separator that happens to precede a phone number too', () => {
    expect(cleanPayeeName('Zelle MOLDOVER - (800)233-2328')).toBe('Zelle MOLDOVER');
  });

  it('picks the LEFTMOST cut trigger, not a fixed rule-type priority', () => {
    // A standalone number ("86711325310921") appears later in the string
    // than an isolated " - " separator — the earlier trigger must win, or
    // this would produce "WEB - KRISTINE SANDT" instead of "WEB".
    expect(
      cleanPayeeName('WEB - KRISTINE SANDT 86711325310921 - TINE SANDT  KRISTINE SANDT From Kristine Sandt Via WISE'),
    ).toBe('WEB');
  });

  it('known-imperfect: no standalone number to cut at, so the city/state tail survives — a rule fixes this', () => {
    expect(cleanPayeeName('043054510 TRADER JOE S #652      SILVER SPRINGMDUS')).toBe('TRADER JOE S #652 SILVER SPRINGMDUS');
  });

  it('does not truncate a genuine trailing number with nothing after it', () => {
    expect(cleanPayeeName('Studio 54')).toBe('Studio 54');
  });

  it('leaves a description with no digits or separators untouched', () => {
    expect(cleanPayeeName('Dividend/Interest')).toBe('Dividend/Interest');
  });

  it('is a no-op on already-clean names — safe to run over every provider, including Wise', () => {
    expect(cleanPayeeName('Taste of Europe')).toBe('Taste of Europe');
    expect(cleanPayeeName('Dance Jam')).toBe('Dance Jam');
  });
});
