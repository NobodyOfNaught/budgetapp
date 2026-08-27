// Wise API read path — statement retrieval only.
//
// Wise exposes the same balance statement its web UI downloads at a REST
// endpoint, in several formats chosen by the URL's file extension rather
// than by an Accept header:
//
//   GET /v1/profiles/{profileId}/balance-statements/{balanceId}/statement.json
//       ?currency=CAD&intervalStart=...&intervalEnd=...&type=COMPACT
//
// Two properties of that endpoint shape everything downstream:
//
// 1. IT IS SCOPED TO ONE BALANCE AND ONE CURRENCY. A Wise account with CAD
//    and USD balances needs one request per balance. That matters here
//    beyond just looping, because src/import/wise.ts groups rows by ID
//    ACROSS currencies to reassemble a single card purchase funded from two
//    balances (see that file's header comment for the worked example). Each
//    per-balance response holds only one leg of such a group, so the
//    responses must be merged before parsing, never parsed independently.
//
// 2. IT MAY BE SCA-PROTECTED. Statement reads sit behind Strong Customer
//    Authentication for profiles registered in the UK/EEA: the first call
//    returns 403 with a one-time token in `x-2fa-approval`, which must be
//    signed with an RSA key whose public half is registered on the Wise
//    account, and the call retried carrying both that token and the
//    signature. Whether it fires for a given profile is a property of where
//    that profile is registered, so it is DETECTED here rather than
//    assumed — see probeWiseApi below.
//
// Pure HTTP: no DB, no Cloudflare bindings. The token is passed in.

import { parseCsvRecords } from './csv';

/** Wise production API. The sandbox (api.sandbox.transferwise.tech) is a separate estate with separate tokens; not used here. */
const WISE_API_BASE = 'https://api.transferwise.com';

/** Wise caps a single statement request at 469 days. */
export const MAX_STATEMENT_DAYS = 469;

export interface WiseProfile {
  id: number;
  type: string;
}

export interface WiseBalance {
  id: number;
  currency: string;
  type: string;
}

/** One raw HTTP exchange, kept unparsed so callers (and the probe) can inspect status and headers rather than only a happy-path body. */
export interface WiseResponse {
  status: number;
  body: string;
  /**
   * The one-time token from `x-2fa-approval` when Wise answered with an SCA
   * challenge, else null. Present only alongside a 403.
   */
  scaChallenge: string | null;
}

export class WiseApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly scaChallenge: string | null,
  ) {
    super(message);
    this.name = 'WiseApiError';
  }
}

/**
 * One authenticated GET against the Wise API.
 *
 * Never throws on a non-2xx — an SCA challenge arrives as a 403 and is a
 * normal, expected step of the flow rather than a failure, so status
 * handling belongs to the caller.
 */
export async function wiseRequest(token: string, path: string): Promise<WiseResponse> {
  const response = await fetch(`${WISE_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  return {
    status: response.status,
    body: await response.text(),
    scaChallenge: response.headers.get('x-2fa-approval'),
  };
}

function parseJsonOrThrow<T>(response: WiseResponse, what: string): T {
  if (response.status !== 200) {
    throw new WiseApiError(
      `Wise ${what} returned ${response.status}`,
      response.status,
      response.scaChallenge,
    );
  }
  try {
    return JSON.parse(response.body) as T;
  } catch {
    throw new WiseApiError(`Wise ${what} returned a non-JSON body`, response.status, null);
  }
}

/** Every profile the token can see. A personal Wise account normally has one `personal` profile; a business account adds a `business` one. */
export async function fetchProfiles(token: string): Promise<WiseProfile[]> {
  return parseJsonOrThrow<WiseProfile[]>(await wiseRequest(token, '/v1/profiles'), 'profiles');
}

/** The multi-currency balances held on one profile — one entry per currency, each with the balanceId the statement endpoint needs. */
export async function fetchBalances(token: string, profileId: number): Promise<WiseBalance[]> {
  const path = `/v4/profiles/${profileId}/balances?types=STANDARD`;
  return parseJsonOrThrow<WiseBalance[]>(await wiseRequest(token, path), 'balances');
}

/**
 * Wise wants full ISO-8601 UTC instants, not plain dates. The interval is
 * inclusive at both ends here: start of the first day to the last
 * millisecond of the last, so a caller passing the same date twice gets
 * that whole day rather than an empty window.
 */
export function statementInterval(startDate: string, endDate: string): { start: string; end: string } {
  return { start: `${startDate}T00:00:00.000Z`, end: `${endDate}T23:59:59.999Z` };
}

export type StatementFormat = 'json' | 'csv';

/** Path for one balance's statement in the given format. Exported so the probe can request both formats over an identical interval and compare them. */
export function statementPath(
  profileId: number,
  balanceId: number,
  currency: string,
  startDate: string,
  endDate: string,
  format: StatementFormat,
): string {
  const { start, end } = statementInterval(startDate, endDate);
  const query = new URLSearchParams({
    currency,
    intervalStart: start,
    intervalEnd: end,
    type: 'COMPACT',
  });
  return `/v1/profiles/${profileId}/balance-statements/${balanceId}/statement.${format}?${query.toString()}`;
}

export async function fetchStatement(
  token: string,
  profileId: number,
  balanceId: number,
  currency: string,
  startDate: string,
  endDate: string,
  format: StatementFormat,
): Promise<WiseResponse> {
  return wiseRequest(token, statementPath(profileId, balanceId, currency, startDate, endDate, format));
}

// --- Diagnostics -----------------------------------------------------------
//
// Everything below exists to answer questions about a REAL Wise account
// that cannot be answered from the documentation, before any of the import
// path is built on assumptions about them:
//
//   a) Does this profile's statement read trigger SCA at all?
//   b) Do the JSON and CSV statements agree on transaction ids?
//
// (b) is the one that decides the format. src/import/wise.ts derives
// `importId` from the CSV's `ID` column verbatim, and imported rows dedupe
// on the (account_id, import_id) unique index. If JSON's `referenceNumber`
// is that same string, moving to JSON is free and existing CSV-imported
// history keeps deduping; if it is not, an overlapping re-import would
// silently double every row — the hazard the Simplii CSV -> QFX switch hit.

interface WiseJsonStatement {
  transactions?: { referenceNumber?: string }[];
}

/** What a single format returned for one balance: the ids it reported, or why it could not be read. */
export interface StatementProbe {
  status: number;
  scaRequired: boolean;
  /** Transaction ids in the order the statement listed them. */
  ids: string[];
  /** For CSV, the header line verbatim — the parser binds to these exact column names, so drift is worth seeing. */
  headerLine: string | null;
  error: string | null;
}

export interface BalanceProbe {
  balanceId: number;
  currency: string;
  json: StatementProbe;
  csv: StatementProbe;
  /** True when both formats were read and reported exactly the same ids in the same order. The format decision turns on this. */
  idsMatch: boolean;
}

export interface WiseProbeResult {
  profiles: WiseProfile[];
  balances: BalanceProbe[];
}

function probeJson(response: WiseResponse): StatementProbe {
  const base = { status: response.status, scaRequired: response.scaChallenge !== null, headerLine: null };
  if (response.status !== 200) {
    return { ...base, ids: [], error: response.body.slice(0, 300) };
  }
  try {
    const parsed = JSON.parse(response.body) as WiseJsonStatement;
    const ids = (parsed.transactions ?? []).map((t) => t.referenceNumber ?? '');
    return { ...base, ids, error: null };
  } catch {
    return { ...base, ids: [], error: 'non-JSON body' };
  }
}

function probeCsv(response: WiseResponse): StatementProbe {
  const scaRequired = response.scaChallenge !== null;
  if (response.status !== 200) {
    return { status: response.status, scaRequired, ids: [], headerLine: null, error: response.body.slice(0, 300) };
  }
  const headerLine = response.body.split('\n', 1)[0] ?? null;
  const ids = parseCsvRecords(response.body).map((record) => record['ID'] ?? '');
  return { status: response.status, scaRequired, ids, headerLine, error: null };
}

/**
 * Reads both statement formats for every balance on every profile over one
 * interval and reports what came back, WITHOUT returning transaction
 * amounts, payees or the token — only ids, counts and status, which is
 * everything the format decision needs and nothing more.
 */
export async function probeWiseApi(token: string, startDate: string, endDate: string): Promise<WiseProbeResult> {
  const profiles = await fetchProfiles(token);
  const balances: BalanceProbe[] = [];

  for (const profile of profiles) {
    for (const balance of await fetchBalances(token, profile.id)) {
      // Sequential on purpose: this is a diagnostic run against a rate-limited
      // third-party API, so a handful of extra seconds is worth more than
      // fanning out and risking a 429 that muddies the result.
      const json = probeJson(
        await fetchStatement(token, profile.id, balance.id, balance.currency, startDate, endDate, 'json'),
      );
      const csv = probeCsv(
        await fetchStatement(token, profile.id, balance.id, balance.currency, startDate, endDate, 'csv'),
      );

      const idsMatch =
        json.error === null &&
        csv.error === null &&
        json.ids.length === csv.ids.length &&
        json.ids.every((id, i) => id === csv.ids[i]);

      balances.push({ balanceId: balance.id, currency: balance.currency, json, csv, idsMatch });
    }
  }

  return { profiles, balances };
}
