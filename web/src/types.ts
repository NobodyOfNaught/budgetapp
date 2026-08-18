// Mirrors the JSON shapes src/routes/auth.ts and src/routes/budgets.ts
// return. Kept as plain types here rather than imported from src/ — the
// Worker and the SPA are typechecked as separate programs (see
// tsconfig.web.json / tsconfig.worker.json) and only ever talk over HTTP.

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string | null;
}

export interface BudgetSummary {
  id: string;
  name: string;
  currencyCode: string;
  role: 'owner' | 'editor' | 'viewer';
}

export interface MeResponse {
  user: CurrentUser;
  budgets: BudgetSummary[];
}

export type ConsumeResponse =
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'needs_confirmation' }
  | { status: 'signed_in'; user: CurrentUser; budgetId: string };

export type AccountType =
  | 'checking'
  | 'savings'
  | 'cash'
  | 'credit_card'
  | 'line_of_credit'
  | 'tracking_asset'
  | 'tracking_liability';

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  onBudget: boolean;
  currencyCode: string;
  note: string | null;
  closedAt: number | null;
  sortOrder: number;
}

export type CategoryKind = 'spending' | 'credit_card_payment' | 'income';

export interface Category {
  id: string;
  groupId: string;
  name: string;
  kind: CategoryKind;
  linkedAccountId: string | null;
  hiddenAt: number | null;
}

export interface CategoryGroup {
  id: string;
  name: string;
  isSystem: boolean;
  categories: Category[];
}

export interface Payee {
  id: string;
  name: string;
  transferAccountId: string | null;
}

export type ClearedStatus = 'uncleared' | 'cleared' | 'reconciled';

export interface RegisterTransaction {
  id: string;
  date: string;
  amountMinor: number;
  categoryId: string | null;
  memo: string | null;
  cleared: ClearedStatus;
  payeeId: string | null;
  payeeName: string | null;
  transferAccountId: string | null;
  isSplit: boolean;
  balance: number;
}

export interface RegisterResponse {
  accountBalance: number;
  clearedBalance: number;
  total: number;
  transactions: RegisterTransaction[];
}
