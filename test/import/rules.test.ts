import { describe, expect, it } from 'vitest';
import { matchPayeeRule, type PayeeRule } from '../../src/import/rules';

function rule(
  id: string,
  matchText: string,
  payeeName: string,
  categoryId: string | null = null,
  band: { min?: number; max?: number; multiple?: number } = {},
): PayeeRule {
  return {
    id,
    matchText,
    payeeName,
    categoryId,
    amountMinMinor: band.min ?? null,
    amountMaxMinor: band.max ?? null,
    amountMultipleMinor: band.multiple ?? null,
  };
}

describe('matchPayeeRule', () => {
  it('matches case-insensitively, substring anywhere in the description', () => {
    const rules = [rule('r1', 'giant food inc', 'Giant Food')];
    expect(
      matchPayeeRule(rules, '160000101207 GIANT FOOD INC #152 13 COLESVILLE   MDUS - Card Ending In 1658')?.payeeName,
    ).toBe('Giant Food');
    expect(matchPayeeRule(rules, '160000101207 GIANT FOOD INC #152')?.payeeName).toBe('Giant Food');
  });

  it('returns null when nothing matches', () => {
    expect(matchPayeeRule([rule('r1', 'costco', 'Costco')], 'TRADER JOE S #652')).toBeNull();
    expect(matchPayeeRule([], 'anything')).toBeNull();
  });

  it('picks the longest matching rule, not the first or last', () => {
    const rules = [
      rule('r1', 'GIANT FOOD', 'Giant Food (generic)'),
      rule('r2', 'GIANT FOOD INC', 'Giant Food'),
    ];
    expect(matchPayeeRule(rules, 'GIANT FOOD INC #152')?.id).toBe('r2');
    // Order in the input shouldn't matter for the longest-wins outcome.
    expect(matchPayeeRule([rules[1]!, rules[0]!], 'GIANT FOOD INC #152')?.id).toBe('r2');
  });

  it('breaks a length tie by keeping the earliest rule in the input (the caller sorts oldest-first)', () => {
    const rules = [rule('older', 'ZELLE', 'First'), rule('newer', 'ZELLE', 'Second')];
    expect(matchPayeeRule(rules, 'Transfer Withdrawal - Zelle KATHERINE ATWILL')?.id).toBe('older');
  });

  it('ignores a rule with empty match text rather than matching everything', () => {
    expect(matchPayeeRule([rule('r1', '', 'Anything')], 'some description')).toBeNull();
  });
});

describe('matchPayeeRule — price bands', () => {
  // The owner's real case: one dance studio, two meanings. Weekly class nights
  // are $20-$40 (and about CAD 56-57 on the Canadian card, i.e. ~$41);
  // events are several times that. "class" is the banded rule, "event" the
  // plain fallback behind it.
  const classNight = rule('class', 'DANCE JAM', 'Dance Jam', 'hollywood', { max: 5000 });
  const event = rule('event', 'DANCE JAM', 'Dance Jam', 'events');
  const raw = 'DANCE JAM PRODUCTIONS 17801 Bowie Mill Rd    DERWOOD      MD';

  it('sends the small charges to the banded rule and the large ones to the fallback', () => {
    const rules = [classNight, event];
    // Real amounts from the owner's statements, in budget (USD) minor units.
    for (const cents of [2000, 4000, 3000]) expect(matchPayeeRule(rules, raw, cents)?.id).toBe('class');
    for (const cents of [11509, 5807, 8560]) expect(matchPayeeRule(rules, raw, cents)?.id).toBe('event');
  });

  it('does not depend on the order the rules are listed in', () => {
    expect(matchPayeeRule([event, classNight], raw, 4000)?.id).toBe('class');
    expect(matchPayeeRule([event, classNight], raw, 11509)?.id).toBe('event');
  });

  it('includes both ends of the band', () => {
    const r = rule('r', 'X', 'X', null, { min: 2000, max: 4000 });
    expect(matchPayeeRule([r], 'X', 1999)).toBeNull();
    expect(matchPayeeRule([r], 'X', 2000)?.id).toBe('r');
    expect(matchPayeeRule([r], 'X', 4000)?.id).toBe('r');
    expect(matchPayeeRule([r], 'X', 4001)).toBeNull();
  });

  it('judges the size, not the sign — a refund falls in the same band as the charge', () => {
    expect(matchPayeeRule([classNight], raw, -4000)?.id).toBe('class');
    expect(matchPayeeRule([classNight], raw, 4000)?.id).toBe('class');
  });

  it('skips a banded rule when the amount is unknown, rather than guessing a price', () => {
    expect(matchPayeeRule([classNight], raw)).toBeNull();
    // ...while an unbanded rule still matches without one, so nothing that
    // worked before the bands existed stops working.
    expect(matchPayeeRule([event], raw)?.id).toBe('event');
  });

  it('lets a longer match text beat a banded rule — text specificity still comes first', () => {
    const specific = rule('specific', 'DANCE JAM PRODUCTIONS', 'Dance Jam Productions', 'other');
    expect(matchPayeeRule([classNight, specific], raw, 4000)?.id).toBe('specific');
  });

  it('prefers the narrower of two overlapping bands', () => {
    const wide = rule('wide', 'DANCE JAM', 'Dance Jam', null, { max: 10000 });
    const narrow = rule('narrow', 'DANCE JAM', 'Dance Jam', null, { min: 3000, max: 5000 });
    expect(matchPayeeRule([wide, narrow], raw, 4000)?.id).toBe('narrow');
    expect(matchPayeeRule([wide, narrow], raw, 8000)?.id).toBe('wide');
  });

  it('treats an open-ended band as unbounded on that side', () => {
    const big = rule('big', 'X', 'X', null, { min: 5000 });
    expect(matchPayeeRule([big], 'X', 4999)).toBeNull();
    expect(matchPayeeRule([big], 'X', 9999999)?.id).toBe('big');
  });

  it('leaves every rule without a band behaving exactly as before', () => {
    const plain = [rule('r1', 'GIANT FOOD', 'A'), rule('r2', 'GIANT FOOD INC', 'B')];
    expect(matchPayeeRule(plain, 'GIANT FOOD INC #152', 12345)?.id).toBe('r2');
    expect(matchPayeeRule(plain, 'GIANT FOOD INC #152')?.id).toBe('r2');
  });
});

describe('matchPayeeRule — "a multiple of", for flat-rate prices', () => {
  // The owner's rule for the dance studio, as three rules:
  //   flat-rate class nights: a multiple of $20, up to $60   -> Hollywood
  //   anything over $100 is definitely an event               -> Events
  //   everything else in between: named, but NO category, so it is left to confirm.
  const raw = 'DANCE JAM PRODUCTIONS 17801 Bowie Mill Rd    DERWOOD      MD';
  const hollywood = rule('hollywood', 'DANCE JAM', 'Dance Jam', 'hollywood', { multiple: 2000, max: 6000 });
  const events = rule('events', 'DANCE JAM', 'Dance Jam', 'events', { min: 10001 });
  const confirm = rule('confirm', 'DANCE JAM', 'Dance Jam', null);
  const rules = [confirm, hollywood, events]; // deliberately not in specificity order
  const pick = (cents: number, approximate = false) => matchPayeeRule(rules, raw, cents, { approximate })?.id;

  it('sends $20, $40 and $60 to Hollywood', () => {
    for (const cents of [2000, 4000, 6000]) expect(pick(cents)).toBe('hollywood');
  });

  it('sends anything over $100 to Events', () => {
    for (const cents of [10001, 11509, 25000]) expect(pick(cents)).toBe('events');
  });

  it('leaves every other number below $100 for the owner to confirm — named, but with no category', () => {
    // $30 and $45 are not multiples of 20; $80 and $100 are, but sit above
    // the "occasionally 60" ceiling, and $100 is not OVER 100.
    for (const cents of [3000, 4500, 5000, 8000, 9999, 10000]) {
      const match = matchPayeeRule(rules, raw, cents);
      expect(match?.id, `${cents / 100}`).toBe('confirm');
      expect(match?.categoryId).toBeNull();
    }
  });

  it('never treats zero as "a multiple of 20"', () => {
    expect(matchPayeeRule([hollywood], raw, 0)).toBeNull();
  });

  it('is exact for a charge in the budget currency — $41 is not "about $40"', () => {
    expect(pick(4100)).toBe('confirm');
    expect(pick(3999)).toBe('confirm');
  });

  describe('a charge made in another currency (converted, so only an estimate)', () => {
    // Real Neo (CAD) statement lines at the stored rate of 0.73, in USD cents.
    it('still reads the $40 class night as $40: CAD 57.45 converts to $41.94', () => {
      expect(pick(4194, true)).toBe('hollywood');
      expect(pick(4181, true)).toBe('hollywood'); // CAD 57.27
      expect(pick(4177, true)).toBe('hollywood'); // CAD 57.22
      expect(pick(4173, true)).toBe('hollywood'); // CAD 57.16
    });

    it('does NOT read the CAD 79.54 event charge ($58.06) as the $60 class price 3% above it', () => {
      // The skew only ever inflates a converted amount, so a figure BELOW
      // a multiple is not evidence of that multiple. A symmetric tolerance
      // would have filed this under Hollywood.
      expect(pick(5806, true)).toBe('confirm');
    });

    it('reads a converted $60 class (CAD ~86) as $60, but not an exact-currency 62.80 as $60', () => {
      expect(pick(6280, true)).toBe('hollywood');
      expect(pick(6280, false)).toBe('confirm');
    });

    it('does not stretch "over $100" downwards: a converted $85.56 is still for confirmation', () => {
      expect(pick(8556, true)).toBe('confirm');
    });
  });

  it('prefers a rule with a multiple over a plain range at the same text length', () => {
    const range = rule('range', 'DANCE JAM', 'Dance Jam', 'other', { max: 6000 });
    expect(matchPayeeRule([range, hollywood], raw, 4000)?.id).toBe('hollywood');
  });
});
