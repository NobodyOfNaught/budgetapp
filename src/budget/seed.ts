import { categories, categoryGroups } from '../db/schema';
import { ulid } from '../lib/ids';
import type { Db } from '../db/client';

const DEFAULT_GROUPS: { name: string; categories: string[] }[] = [
  { name: 'Immediate Obligations', categories: ['Rent/Mortgage', 'Groceries', 'Utilities', 'Transportation'] },
  { name: 'True Expenses', categories: ['Auto Maintenance', 'Home Maintenance', 'Gifts & Donations'] },
  { name: 'Quality of Life', categories: ['Dining Out', 'Fun Money', 'Subscriptions'] },
];

/**
 * Seeds a starter category set on budget creation — "a sensible default
 * set" per docs/plan.md's MVP scope. Purely a starting point: every group
 * and category here is ordinary (isSystem: false) and freely
 * renameable/deletable by the user. The one group NOT seeded here is
 * "Credit Card Payments" — that's created lazily, only once the user
 * actually adds a credit account. See src/budget/payment-categories.ts.
 */
export async function seedDefaultCategories(db: Db, budgetId: string, now: number): Promise<void> {
  let groupSort = 0;
  for (const group of DEFAULT_GROUPS) {
    const groupId = ulid(now);
    await db.insert(categoryGroups).values({
      id: groupId,
      budgetId,
      name: group.name,
      sortOrder: groupSort++,
      isSystem: false,
      createdAt: now,
      updatedAt: now,
    });

    let catSort = 0;
    for (const name of group.categories) {
      await db.insert(categories).values({
        id: ulid(now),
        budgetId,
        groupId,
        name,
        kind: 'spending',
        sortOrder: catSort++,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
}
