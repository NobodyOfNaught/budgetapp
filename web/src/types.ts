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
