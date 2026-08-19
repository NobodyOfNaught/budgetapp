import { describe, expect, it } from 'vitest';
import { matchPayeeRule, type PayeeRule } from '../../src/import/rules';

function rule(id: string, matchText: string, payeeName: string, categoryId: string | null = null): PayeeRule {
  return { id, matchText, payeeName, categoryId };
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
