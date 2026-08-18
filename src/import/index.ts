// Provider registry. Adding a second bank/service is a new file plus one
// line here — nothing else in the app knows which providers exist.

import type { StatementParser } from './types';
import { parseWiseCsv, suggestedCategoryName as wiseSuggestion } from './wise';

export const IMPORT_PROVIDERS = ['wise'] as const;
export type ImportProvider = (typeof IMPORT_PROVIDERS)[number];

const PARSERS: Record<ImportProvider, StatementParser> = {
  wise: parseWiseCsv,
};

/** Maps a provider's own category label onto a seeded category NAME, or null when there's no confident match. */
const CATEGORY_SUGGESTERS: Record<ImportProvider, (providerCategory: string | null) => string | null> = {
  wise: wiseSuggestion,
};

export function isImportProvider(value: string): value is ImportProvider {
  return (IMPORT_PROVIDERS as readonly string[]).includes(value);
}

export function parseStatement(provider: ImportProvider, csvText: string) {
  return PARSERS[provider](csvText);
}

export function suggestCategoryName(provider: ImportProvider, providerCategory: string | null): string | null {
  return CATEGORY_SUGGESTERS[provider](providerCategory);
}

export type { ParsedOrdinary, ParsedRow, ParsedTransfer, ParseResult, SkippedRow } from './types';
