import { describe, expect, it } from 'vitest';
import { computeLedger } from '../../src/domain/ledger';
import type { AccountKind, AccountRow, CategoryKind, CategoryMonthRow, CategoryRow, TransactionRow } from '../../src/domain/types';

// Tiny builders so each scenario reads as "what happened", not "how to
// satisfy the type checker". Every golden case below is transcribed from
// docs/plan.md's "The ledger engine" section — this file IS the spec.

function account(id: string, type: AccountKind, onBudget = true): AccountRow {
  return { id, type, onBudget };
}

function category(id: string, kind: CategoryKind = 'spending', linkedAccountId: string | null = null): CategoryRow {
  return { id, kind, linkedAccountId };
}

function assign(categoryId: string, month: string, dollars: number): CategoryMonthRow {
  return { categoryId, month, assignedMinor: dollars * 100 };
}

let txnSeq = 0;
function txn(
  accountId: string,
  date: string,
  dollars: number,
  overrides: Partial<TransactionRow> = {},
): TransactionRow {
  txnSeq++;
  return {
    id: `t${txnSeq}`,
    accountId,
    date,
    budgetAmountMinor: Math.round(dollars * 100),
    categoryId: null,
    transferTransactionId: null,
    parentTransactionId: null,
    deletedAt: null,
    ...overrides,
  };
}

/** A same-transferTransactionId pair, one leg per account. */
function transferPair(
  legA: { accountId: string; date: string; dollars: number; categoryId?: string },
  legB: { accountId: string; date: string; dollars: number; categoryId?: string },
): [TransactionRow, TransactionRow] {
  const id = `xfer${++txnSeq}`;
  return [
    txn(legA.accountId, legA.date, legA.dollars, { transferTransactionId: id, categoryId: legA.categoryId ?? null }),
    txn(legB.accountId, legB.date, legB.dollars, { transferTransactionId: id, categoryId: legB.categoryId ?? null }),
  ];
}

const M1 = '2026-01-01';
const M2 = '2026-02-01';
const M3 = '2026-03-01';
const M4 = '2026-04-01';

describe('rollover of positive balances', () => {
  it('carries a positive available forward unchanged across an untouched month', () => {
    const checking = account('checking', 'checking');
    const groceries = category('groceries');
    const result = computeLedger({
      accounts: [checking],
      categories: [groceries],
      categoryMonths: [assign('groceries', M1, 100)],
      transactions: [txn('checking', M1, 500)], // uncategorized inflow = income
      throughMonth: M2,
    });

    expect(result.months.map((m) => m.month)).toEqual([M1, M2]);
    expect(result.months[0]?.categories.groceries?.available).toBe(10000);
    expect(result.months[0]?.readyToAssign).toBe(40000); // 50000 income - 10000 assigned
    // Nothing happens in month 2: available and RTA both carry forward untouched.
    expect(result.months[1]?.categories.groceries?.available).toBe(10000);
    expect(result.months[1]?.readyToAssign).toBe(40000);
  });

  it('carries a positive available through multiple untouched months', () => {
    const result = computeLedger({
      accounts: [account('checking', 'checking')],
      categories: [category('groceries')],
      categoryMonths: [assign('groceries', M1, 100)],
      transactions: [],
      throughMonth: M4,
    });

    expect(result.months).toHaveLength(4);
    expect(result.months[3]?.categories.groceries?.available).toBe(10000);
  });
});

describe('cash overspending hits next month’s Ready to Assign', () => {
  it('resets the category to 0 and pulls the shortfall from next month’s RTA', () => {
    const result = computeLedger({
      accounts: [account('checking', 'checking')],
      categories: [category('groceries')],
      categoryMonths: [assign('groceries', M1, 50)],
      transactions: [
        txn('checking', M1, 200), // income
        txn('checking', M1, -80, { categoryId: 'groceries' }), // overspends the $50 assigned
      ],
      throughMonth: M2,
    });

    const month1 = result.months[0]!;
    expect(month1.categories.groceries?.available).toBe(-3000); // -$30
    expect(month1.readyToAssign).toBe(15000); // 20000 income - 5000 assigned

    const month2 = result.months[1]!;
    expect(month2.categories.groceries?.available).toBe(0); // reset, not carried negative
    expect(month2.readyToAssign).toBe(12000); // 15000 - 3000 shortfall
  });
});

describe('credit overspending stays negative', () => {
  it('does not touch Ready to Assign, unlike cash overspending', () => {
    const card = account('card', 'credit_card');
    const payment = category('payment', 'credit_card_payment', 'card');
    const result = computeLedger({
      accounts: [card],
      categories: [payment],
      categoryMonths: [],
      // Uncategorized card charge — no spending category, no assignment to
      // Payment. Same shape as a starting balance.
      transactions: [txn('card', M1, -50)],
      throughMonth: M2,
    });

    const month1 = result.months[0]!;
    expect(month1.categories.payment?.available).toBe(-5000);
    expect(month1.readyToAssign).toBe(0);

    const month2 = result.months[1]!;
    expect(month2.categories.payment?.available).toBe(-5000); // still negative, unchanged
    expect(month2.readyToAssign).toBe(0); // untouched — this is the whole point
  });
});

describe('credit card purchase moves money to the payment category', () => {
  it('doubles a spending-categorized purchase into the linked payment category', () => {
    const card = account('card', 'credit_card');
    const groceries = category('groceries');
    const payment = category('payment', 'credit_card_payment', 'card');
    const result = computeLedger({
      accounts: [account('checking', 'checking'), card],
      categories: [groceries, payment],
      categoryMonths: [assign('groceries', M1, 50)],
      transactions: [
        txn('checking', M1, 100), // income, so Groceries can be assigned from somewhere real
        txn('card', M1, -50, { categoryId: 'groceries' }),
      ],
      throughMonth: M1,
    });

    const month1 = result.months[0]!;
    expect(month1.categories.groceries?.available).toBe(0); // 5000 assigned - 5000 activity
    expect(month1.categories.payment?.available).toBe(5000); // earmarked to pay the card
  });
});

describe('paying the card drains the payment category', () => {
  it('categorizing the payment transfer’s outflow leg to Payment drains exactly what was owed', () => {
    const card = account('card', 'credit_card');
    const groceries = category('groceries');
    const payment = category('payment', 'credit_card_payment', 'card');
    const [checkingLeg, cardLeg] = transferPair(
      { accountId: 'checking', date: M2, dollars: -50, categoryId: 'payment' },
      { accountId: 'card', date: M2, dollars: 50 }, // uncategorized — see docs/plan.md
    );

    const result = computeLedger({
      accounts: [account('checking', 'checking'), card],
      categories: [groceries, payment],
      categoryMonths: [],
      transactions: [
        txn('card', M1, -50, { categoryId: 'groceries' }), // month 1: $50 charge -> payment earmarked +$50
        checkingLeg,
        cardLeg,
      ],
      throughMonth: M2,
    });

    expect(result.months[0]?.categories.payment?.available).toBe(5000);
    expect(result.months[1]?.categories.payment?.available).toBe(0); // fully drained
  });
});

describe('a refund reverses the earmark', () => {
  it('partially undoes a purchase’s payment-category contribution', () => {
    const card = account('card', 'credit_card');
    const groceries = category('groceries');
    const payment = category('payment', 'credit_card_payment', 'card');
    const result = computeLedger({
      accounts: [card],
      categories: [groceries, payment],
      categoryMonths: [],
      transactions: [
        txn('card', M1, -50, { categoryId: 'groceries' }), // purchase
        txn('card', M1, 20, { categoryId: 'groceries' }), // partial refund
      ],
      throughMonth: M1,
    });

    const month1 = result.months[0]!;
    expect(month1.categories.groceries?.activity).toBe(-3000); // net $30 actually spent
    expect(month1.categories.payment?.available).toBe(3000); // only $30 left to earmark
  });
});

describe('splits', () => {
  it('excludes the parent and attributes activity to each child’s own category', () => {
    const parent = txn('checking', M1, -100); // categoryId null — a split parent, by construction
    const groceriesChild = txn('checking', M1, -60, { categoryId: 'groceries', parentTransactionId: parent.id });
    const householdChild = txn('checking', M1, -40, { categoryId: 'household', parentTransactionId: parent.id });

    const result = computeLedger({
      accounts: [account('checking', 'checking')],
      categories: [category('groceries'), category('household')],
      categoryMonths: [],
      transactions: [parent, groceriesChild, householdChild],
      throughMonth: M1,
    });

    const month1 = result.months[0]!;
    expect(month1.categories.groceries?.activity).toBe(-6000);
    expect(month1.categories.household?.activity).toBe(-4000);
    // If the parent leaked into ledger math as an "uncategorized" -$100 it
    // would show up as -10000 of (wrongly negative) income. It must not.
    expect(month1.readyToAssign).toBe(0);
  });
});

describe('transfers', () => {
  it('an uncategorized transfer between two on-budget accounts produces no category activity', () => {
    const [checkingLeg, savingsLeg] = transferPair(
      { accountId: 'checking', date: M1, dollars: -50 },
      { accountId: 'savings', date: M1, dollars: 50 },
    );
    const result = computeLedger({
      accounts: [account('checking', 'checking'), account('savings', 'savings')],
      categories: [category('groceries')],
      categoryMonths: [],
      transactions: [checkingLeg, savingsLeg],
      throughMonth: M1,
    });

    expect(result.months[0]?.categories.groceries?.available).toBe(0);
    expect(result.months[0]?.readyToAssign).toBe(0);
  });

  it('a transfer to a tracking account produces no category activity either', () => {
    const [checkingLeg, trackingLeg] = transferPair(
      { accountId: 'checking', date: M1, dollars: -50 },
      { accountId: 'investing', date: M1, dollars: 50 },
    );
    const result = computeLedger({
      accounts: [account('checking', 'checking'), account('investing', 'tracking_asset', false)],
      categories: [category('groceries')],
      categoryMonths: [],
      transactions: [checkingLeg, trackingLeg],
      throughMonth: M1,
    });

    expect(result.months[0]?.readyToAssign).toBe(0);
  });

  it('a cross-currency transfer pair still produces no category activity, regardless of the two legs’ magnitudes', () => {
    // Simulates a real FX conversion: the two legs' budgetAmountMinor
    // values deliberately do NOT match (unlike a same-currency transfer).
    // The engine must not try to reconcile them — it just applies the
    // ordinary "uncategorized transfer -> zero" rule to each leg alone.
    const [usdLeg, cadLeg] = transferPair(
      { accountId: 'usd-checking', date: M1, dollars: -100 },
      { accountId: 'cad-savings', date: M1, dollars: 98 },
    );
    const result = computeLedger({
      accounts: [account('usd-checking', 'checking'), account('cad-savings', 'savings')],
      categories: [category('groceries')],
      categoryMonths: [],
      transactions: [usdLeg, cadLeg],
      throughMonth: M1,
    });

    expect(result.months[0]?.readyToAssign).toBe(0);
    expect(result.months[0]?.categories.groceries?.available).toBe(0);
  });
});

describe('starting balances', () => {
  it('a cash account’s starting balance is plain uncategorized income to Ready to Assign', () => {
    const result = computeLedger({
      accounts: [account('checking', 'checking')],
      categories: [],
      categoryMonths: [],
      transactions: [txn('checking', M1, 500)], // uncategorized, not a transfer
      throughMonth: M1,
    });
    expect(result.months[0]?.readyToAssign).toBe(50000);
  });

  it('a credit account’s starting balance is negative available on its payment category, not phantom income', () => {
    const card = account('card', 'credit_card');
    const payment = category('payment', 'credit_card_payment', 'card');
    const result = computeLedger({
      accounts: [card],
      categories: [payment],
      categoryMonths: [],
      transactions: [txn('card', M1, -100)], // you already owed $100 before this budget existed
      throughMonth: M1,
    });
    expect(result.months[0]?.categories.payment?.available).toBe(-10000);
    expect(result.months[0]?.readyToAssign).toBe(0); // must NOT leak into RTA
  });
});

describe('edge cases', () => {
  it('an empty budget viewing any month returns exactly that one month, all zero', () => {
    const result = computeLedger({
      accounts: [],
      categories: [],
      categoryMonths: [],
      transactions: [],
      throughMonth: M3,
    });
    expect(result.months).toEqual([{ month: M3, readyToAssign: 0, categories: {} }]);
  });
});
