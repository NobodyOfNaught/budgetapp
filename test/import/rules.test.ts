import { describe, expect, it } from 'vitest';
import { matchPayeeRule, type PayeeRule } from '../../src/import/rules';

function rule(
  id: string,
  matchText: string,
  payeeName: string,
  categoryId: string | null = null,
  band: { min?: number; max?: number } = {},
): PayeeRule {
  return { id, matchText, payeeName, categoryId, amountMinMinor: band.min ?? null, amountMaxMinor: band.max ?? null };
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
