// Provider registry. Adding a second bank/service is a new file plus one
// line here — nothing else in the app knows which providers exist.

import type { ImportOptions, StatementParser } from './types';
import { parseWiseCsv, suggestedCategoryName as wiseSuggestion } from './wise';
import { parseBecuCsv, suggestedCategoryName as becuSuggestion } from './becu';
import { parseSplitwiseCsv, suggestedCategoryName as splitwiseSuggestion } from './splitwise';
import { parseAacuCsv, suggestedCategoryName as aacuSuggestion } from './aacu';

export const IMPORT_PROVIDERS = ['wise', 'becu', 'splitwise', 'aacu'] as const;
export type ImportProvider = (typeof IMPORT_PROVIDERS)[number];

const PARSERS: Record<ImportProvider, StatementParser> = {
  wise: parseWiseCsv,
  becu: parseBecuCsv,
  splitwise: parseSplitwiseCsv,
  aacu: parseAacuCsv,
};

/** Maps a provider's own category label onto a seeded category NAME, or null when there's no confident match. */
const CATEGORY_SUGGESTERS: Record<ImportProvider, (providerCategory: string | null) => string | null> = {
  wise: wiseSuggestion,
  becu: becuSuggestion,
  splitwise: splitwiseSuggestion,
  aacu: aacuSuggestion,
};

export function isImportProvider(value: string): value is ImportProvider {
  return (IMPORT_PROVIDERS as readonly string[]).includes(value);
}

export function parseStatement(provider: ImportProvider, csvText: string, options?: ImportOptions) {
  return PARSERS[provider](csvText, options);
}

export function suggestCategoryName(provider: ImportProvider, providerCategory: string | null): string | null {
  return CATEGORY_SUGGESTERS[provider](providerCategory);
}

export type { ImportOptions, ParsedOrdinary, ParsedRow, ParsedTransfer, ParseResult, SkippedRow } from './types';
