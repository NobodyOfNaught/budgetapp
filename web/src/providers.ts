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
  { value: 'vancity', label: 'Vancity' },
];
