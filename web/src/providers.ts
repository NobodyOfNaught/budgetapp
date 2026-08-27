/**
 * Every statement parser the UI offers, mirroring IMPORT_PROVIDERS in
 * src/import/index.ts. Single source of truth for the three places a
 * provider is picked — creating an account (AccountForm), editing one
 * (AccountSettings), and running an import (ImportForm) — since a provider
 * added to only some of those is a silent gap: the import still "works",
 * it just runs the wrong parser (see docs/plan.md's note on the Neo file
 * being skipped wholesale by Wise's parser).
 */
export const IMPORT_PROVIDER_OPTIONS: { value: string; label: string }[] = [
  { value: 'wise', label: 'Wise' },
  { value: 'becu', label: 'BECU' },
  { value: 'splitwise', label: 'Splitwise' },
  { value: 'aacu', label: 'AACU' },
  { value: 'neo', label: 'Neo Mastercard' },
  { value: 'vancity', label: 'Vancity (chequing)' },
  { value: 'vancity_visa', label: 'Vancity Visa' },
  { value: 'simplii', label: 'Simplii' },
  // The one entry that names a FORMAT rather than a bank — OFX/QFX/QBO is
  // a shared standard, so this covers Chase and anything else offering it.
  // See src/import/ofx.ts.
  { value: 'ofx', label: 'OFX / QFX / QBO (Chase and others)' },
  // Wise's API statement, which is a different format from the 'wise'
  // web-UI CSV above rather than a replacement for it — both parsers exist
  // because both files exist. See src/import/wise-json.ts.
  { value: 'wise_json', label: 'Wise (API statement JSON)' },
];
