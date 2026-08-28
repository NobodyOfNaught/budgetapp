// Provider registry. Adding a second bank/service is a new file plus one
// line here — nothing else in the app knows which providers exist.

import type { ImportOptions, StatementParser } from './types';
import { parseWiseCsv, suggestedCategoryName as wiseSuggestion } from './wise';
import { parseBecuCsv, suggestedCategoryName as becuSuggestion } from './becu';
import { parseSplitwiseCsv, suggestedCategoryName as splitwiseSuggestion } from './splitwise';
import { parseAacuCsv, suggestedCategoryName as aacuSuggestion } from './aacu';
import { parseNeoCsv, suggestedCategoryName as neoSuggestion } from './neo';
import { parseVancityCsv, suggestedCategoryName as vancitySuggestion } from './vancity';
import { parseSimpliiCsv, suggestedCategoryName as simpliiSuggestion } from './simplii';
import { parseVancityVisaCsv, suggestedCategoryName as vancityVisaSuggestion } from './vancity-visa';
import { parseOfx, suggestedCategoryName as ofxSuggestion } from './ofx';
import { parseWiseJson, suggestedCategoryName as wiseJsonSuggestion } from './wise-json';

// 'ofx' is deliberately the format, not a bank: OFX/QFX/QBO is one shared
// standard, so a single entry serves Chase and any other institution that
// offers it — unlike the CSV entries above, each of which is one bank's
// own layout. See src/import/ofx.ts.
export const IMPORT_PROVIDERS = [
  'wise',
  'becu',
  'splitwise',
  'aacu',
  'neo',
  'vancity',
  'vancity_visa',
  'simplii',
  'ofx',
  // The Wise API's JSON statement — a different format from the 'wise'
  // web-UI CSV above, not a replacement for it. See src/import/wise-json.ts.
  'wise_json',
] as const;
export type ImportProvider = (typeof IMPORT_PROVIDERS)[number];

const PARSERS: Record<ImportProvider, StatementParser> = {
  wise: parseWiseCsv,
  becu: parseBecuCsv,
  splitwise: parseSplitwiseCsv,
  aacu: parseAacuCsv,
  neo: parseNeoCsv,
  vancity: parseVancityCsv,
  vancity_visa: parseVancityVisaCsv,
  simplii: parseSimpliiCsv,
  ofx: parseOfx,
  wise_json: parseWiseJson,
};

/** Maps a provider's own category label onto a seeded category NAME, or null when there's no confident match. */
const CATEGORY_SUGGESTERS: Record<ImportProvider, (providerCategory: string | null) => string | null> = {
  wise: wiseSuggestion,
  becu: becuSuggestion,
  splitwise: splitwiseSuggestion,
  aacu: aacuSuggestion,
  neo: neoSuggestion,
  vancity: vancitySuggestion,
  vancity_visa: vancityVisaSuggestion,
  simplii: simpliiSuggestion,
  ofx: ofxSuggestion,
  wise_json: wiseJsonSuggestion,
};

/**
 * Providers that are the same institution in different clothes, so an
 * account set up under one is the right home for a statement imported
 * under another.
 *
 * Only Wise so far: 'wise' parses the web-UI CSV export and 'wise_json'
 * the API statement, but both describe the same balances. Without this,
 * switching an account to the API format made resolveCurrencyAccount
 * (src/routes/imports.ts) fail to recognise the existing "Wise CAD"
 * account and silently create a duplicate alongside it.
 */
const PROVIDER_FAMILIES: ImportProvider[][] = [['wise', 'wise_json']];

/** Every provider whose accounts should be considered interchangeable with this one, including itself. */
export function providerFamily(provider: ImportProvider): ImportProvider[] {
  return PROVIDER_FAMILIES.find((family) => family.includes(provider)) ?? [provider];
}

export function isImportProvider(value: string): value is ImportProvider {
  return (IMPORT_PROVIDERS as readonly string[]).includes(value);
}

export function parseStatement(provider: ImportProvider, fileText: string, options?: ImportOptions) {
  return PARSERS[provider](fileText, options);
}

export function suggestCategoryName(provider: ImportProvider, providerCategory: string | null): string | null {
  return CATEGORY_SUGGESTERS[provider](providerCategory);
}

export type { ImportOptions, ParsedOrdinary, ParsedRow, ParsedTransfer, ParseResult, SkippedRow } from './types';
