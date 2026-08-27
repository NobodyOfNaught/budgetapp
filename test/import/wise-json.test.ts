import { describe, expect, it } from 'vitest';
import { checkStatementBalance, parseWiseJson, suggestedCategoryName } from '../../src/import/wise-json';
import type { ParsedOrdinary } from '../../src/import/types';

// Every row below is transcribed VERBATIM from a real Wise API statement
// (profile 9886004, balances 25777502 CAD and 27339669 USD, September 2025
// to August 2026), narrowed to the transactions that exercise a distinct
// behaviour. Nothing is synthesised — the awkward cases here are awkward
// because Wise really emits them, and a hand-written fixture would have
// invented tidier data than the format actually produces.
//
// What each statement covers:
//
//   CAD  CARD-4193630446     an ordinary card purchase, FX-funded
//        CARD-4145111585     the CAD leg of a purchase split across two
//                            balances: -15.77 CAD funding 11.18 USD of a
//                            34.50 USD purchase
//        TRANSFER-2270774033 a top-up (MONEY_ADDED) — the exact row the CSV
//                            parser once misread as an internal conversion
//
//   USD  CARD-4145111585     the USD leg of that same split purchase
//        CARD-4113574733     an over-authorisation partly refunded:
//                            +11.70 CREDIT and -160.88 DEBIT
//        CARD-4070294539     a tip posting a day after the base charge:
//                            -3.00 and -15.93 of an 18.93 fare
//        TRANSFER-2247430954 a transfer sent and returned eight days later:
//                            -4.95 then +4.95
//        TRANSFER-2246160468 money received from another person (DEPOSIT)
//        TRANSFER-2223856519 a top-up funded from CAD (MONEY_ADDED + FX)

const CAD_STATEMENT = `
{
  "transactions": [
    {
      "type": "DEBIT",
      "date": "2026-08-14T16:36:49.421391Z",
      "amount": {
        "value": -5.62,
        "currency": "CAD",
        "zero": false
      },
      "totalFees": {
        "value": 0.02,
        "currency": "CAD",
        "zero": false
      },
      "details": {
        "type": "CARD",
        "description": "Card transaction of 4.04 USD issued by Usps Po 2384810904 SILVER SPRING",
        "amount": {
          "value": 4.04,
          "currency": "USD",
          "zero": false
        },
        "category": "Postal Services Government Only",
        "merchant": {
          "name": "Usps Po 2384810904",
          "firstLine": null,
          "postCode": null,
          "city": "SILVER SPRING",
          "state": null,
          "country": "US",
          "category": "Postal Services Government Only"
        },
        "cardLastFourDigits": "7601",
        "cardHolderFullName": "Palle Helenius"
      },
      "exchangeDetails": {
        "toAmount": {
          "value": 4.04,
          "currency": "USD",
          "zero": false
        },
        "fromAmount": {
          "value": 5.62,
          "currency": "CAD",
          "zero": false
        },
        "rate": 0.72088
      },
      "runningBalance": {
        "value": 5.96,
        "currency": "CAD",
        "zero": false
      },
      "referenceNumber": "CARD-4193630446",
      "attachment": null,
      "activityAssetAttributions": []
    },
    {
      "type": "DEBIT",
      "date": "2026-08-03T17:11:26.83651Z",
      "amount": {
        "value": -15.77,
        "currency": "CAD",
        "zero": false
      },
      "totalFees": {
        "value": 0.07,
        "currency": "CAD",
        "zero": false
      },
      "details": {
        "type": "CARD",
        "description": "Card transaction of 34.50 USD issued by Taste Of Europe Enterpr GAITHERSBURG",
        "amount": {
          "value": 34.5,
          "currency": "USD",
          "zero": false
        },
        "category": "Grocery Stores, Supermarkets",
        "merchant": {
          "name": "Taste Of Europe Enterpr",
          "firstLine": null,
          "postCode": null,
          "city": "GAITHERSBURG",
          "state": null,
          "country": "US",
          "category": "Grocery Stores, Supermarkets"
        },
        "cardLastFourDigits": "0338",
        "cardHolderFullName": "Palle Helenius"
      },
      "exchangeDetails": {
        "toAmount": {
          "value": 11.18,
          "currency": "USD",
          "zero": false
        },
        "fromAmount": {
          "value": 15.77,
          "currency": "CAD",
          "zero": false
        },
        "rate": 0.7119
      },
      "runningBalance": {
        "value": 165.44,
        "currency": "CAD",
        "zero": false
      },
      "referenceNumber": "CARD-4145111585",
      "attachment": null,
      "activityAssetAttributions": []
    },
    {
      "type": "CREDIT",
      "date": "2026-07-28T10:05:13.771015Z",
      "amount": {
        "value": 1900,
        "currency": "CAD",
        "zero": false
      },
      "totalFees": {
        "value": 0.31,
        "currency": "CAD",
        "zero": false
      },
      "details": {
        "type": "MONEY_ADDED",
        "description": "Topped up account"
      },
      "exchangeDetails": null,
      "runningBalance": {
        "value": 1900,
        "currency": "CAD",
        "zero": false
      },
      "referenceNumber": "TRANSFER-2270774033",
      "attachment": null,
      "activityAssetAttributions": []
    }
  ],
  "startOfStatementBalance": {
    "value": 0,
    "currency": "CAD",
    "zero": true
  },
  "endOfStatementBalance": {
    "value": 1878.61,
    "currency": "CAD",
    "zero": false
  }
}
`;

const USD_STATEMENT = `
{
  "transactions": [
    {
      "type": "DEBIT",
      "date": "2026-08-03T17:11:26.777876Z",
      "amount": {
        "value": -23.32,
        "currency": "USD",
        "zero": false
      },
      "totalFees": {
        "value": 0,
        "currency": "USD",
        "zero": true
      },
      "details": {
        "type": "CARD",
        "description": "Card transaction of 34.50 USD issued by Taste Of Europe Enterpr GAITHERSBURG",
        "amount": {
          "value": 34.5,
          "currency": "USD",
          "zero": false
        },
        "category": "Grocery Stores, Supermarkets",
        "merchant": {
          "name": "Taste Of Europe Enterpr",
          "firstLine": null,
          "postCode": null,
          "city": "GAITHERSBURG",
          "state": null,
          "country": "US",
          "category": "Grocery Stores, Supermarkets"
        },
        "cardLastFourDigits": "0338",
        "cardHolderFullName": "Palle Helenius"
      },
      "exchangeDetails": null,
      "runningBalance": {
        "value": 0,
        "currency": "USD",
        "zero": true
      },
      "referenceNumber": "CARD-4145111585",
      "attachment": null,
      "activityAssetAttributions": []
    },
    {
      "type": "CREDIT",
      "date": "2026-07-27T18:26:43.401645Z",
      "amount": {
        "value": 11.7,
        "currency": "USD",
        "zero": false
      },
      "totalFees": {
        "value": 0,
        "currency": "USD",
        "zero": true
      },
      "details": {
        "type": "CARD",
        "description": "Card transaction of 149.18 USD issued by Giant Food 152 800-573-2763",
        "amount": {
          "value": 149.18,
          "currency": "USD",
          "zero": false
        },
        "category": "Grocery Stores, Supermarkets",
        "merchant": {
          "name": "Giant Food 152",
          "firstLine": null,
          "postCode": null,
          "city": "800-573-2763",
          "state": null,
          "country": "US",
          "category": "Grocery Stores, Supermarkets"
        },
        "cardLastFourDigits": "7601",
        "cardHolderFullName": "Palle Helenius"
      },
      "exchangeDetails": null,
      "runningBalance": {
        "value": 146.08,
        "currency": "USD",
        "zero": false
      },
      "referenceNumber": "CARD-4113574733",
      "attachment": null,
      "activityAssetAttributions": []
    },
    {
      "type": "DEBIT",
      "date": "2026-07-27T15:09:01.719382Z",
      "amount": {
        "value": -160.88,
        "currency": "USD",
        "zero": false
      },
      "totalFees": {
        "value": 0,
        "currency": "USD",
        "zero": true
      },
      "details": {
        "type": "CARD",
        "description": "Card transaction of 149.18 USD issued by Giant Food 152 800-573-2763",
        "amount": {
          "value": 149.18,
          "currency": "USD",
          "zero": false
        },
        "category": "Grocery Stores, Supermarkets",
        "merchant": {
          "name": "Giant Food 152",
          "firstLine": null,
          "postCode": null,
          "city": "800-573-2763",
          "state": null,
          "country": "US",
          "category": "Grocery Stores, Supermarkets"
        },
        "cardLastFourDigits": "7601",
        "cardHolderFullName": "Palle Helenius"
      },
      "exchangeDetails": null,
      "runningBalance": {
        "value": 134.38,
        "currency": "USD",
        "zero": false
      },
      "referenceNumber": "CARD-4113574733",
      "attachment": null,
      "activityAssetAttributions": []
    },
    {
      "type": "CREDIT",
      "date": "2026-07-21T07:28:58.621709Z",
      "amount": {
        "value": 4.95,
        "currency": "USD",
        "zero": false
      },
      "totalFees": {
        "value": 1.41,
        "currency": "USD",
        "zero": false
      },
      "details": {
        "type": "TRANSFER",
        "description": "Sent money to Palle Helenius",
        "recipient": {
          "name": "Palle Helenius",
          "bankAccount": "palle@naught.ca"
        },
        "paymentReference": "",
        "creatorTrackingId": null
      },
      "exchangeDetails": {
        "toAmount": {
          "value": 5,
          "currency": "CAD",
          "zero": false
        },
        "fromAmount": {
          "value": 3.54,
          "currency": "USD",
          "zero": false
        },
        "rate": 1.41395
      },
      "runningBalance": {
        "value": 374.88,
        "currency": "USD",
        "zero": false
      },
      "referenceNumber": "TRANSFER-2247430954",
      "attachment": null,
      "activityAssetAttributions": []
    },
    {
      "type": "DEBIT",
      "date": "2026-07-18T16:14:59.964161Z",
      "amount": {
        "value": -3,
        "currency": "USD",
        "zero": false
      },
      "totalFees": {
        "value": 0,
        "currency": "USD",
        "zero": true
      },
      "details": {
        "type": "CARD",
        "description": "Card transaction of 18.93 USD issued by Lyft   *Standard 07-17 LYFT.COM",
        "amount": {
          "value": 18.93,
          "currency": "USD",
          "zero": false
        },
        "category": "Limousines",
        "merchant": {
          "name": "Lyft   *Standard 07-17",
          "firstLine": null,
          "postCode": null,
          "city": "LYFT.COM",
          "state": null,
          "country": "US",
          "category": "Limousines"
        },
        "cardLastFourDigits": "7601",
        "cardHolderFullName": "Palle Helenius"
      },
      "exchangeDetails": null,
      "runningBalance": {
        "value": 438.98,
        "currency": "USD",
        "zero": false
      },
      "referenceNumber": "CARD-4070294539",
      "attachment": null,
      "activityAssetAttributions": []
    },
    {
      "type": "DEBIT",
      "date": "2026-07-17T18:22:34.227868Z",
      "amount": {
        "value": -15.93,
        "currency": "USD",
        "zero": false
      },
      "totalFees": {
        "value": 0,
        "currency": "USD",
        "zero": true
      },
      "details": {
        "type": "CARD",
        "description": "Card transaction of 18.93 USD issued by Lyft   *Standard 07-17 LYFT.COM",
        "amount": {
          "value": 18.93,
          "currency": "USD",
          "zero": false
        },
        "category": "Limousines",
        "merchant": {
          "name": "Lyft   *Standard 07-17",
          "firstLine": null,
          "postCode": null,
          "city": "LYFT.COM",
          "state": null,
          "country": "US",
          "category": "Limousines"
        },
        "cardLastFourDigits": "7601",
        "cardHolderFullName": "Palle Helenius"
      },
      "exchangeDetails": null,
      "runningBalance": {
        "value": 461.98,
        "currency": "USD",
        "zero": false
      },
      "referenceNumber": "CARD-4070294539",
      "attachment": null,
      "activityAssetAttributions": []
    },
    {
      "type": "DEBIT",
      "date": "2026-07-13T15:13:42.197271Z",
      "amount": {
        "value": -4.95,
        "currency": "USD",
        "zero": false
      },
      "totalFees": {
        "value": 1.41,
        "currency": "USD",
        "zero": false
      },
      "details": {
        "type": "TRANSFER",
        "description": "Sent money to Palle Helenius",
        "recipient": {
          "name": "Palle Helenius",
          "bankAccount": "palle@naught.ca"
        },
        "paymentReference": "",
        "creatorTrackingId": null
      },
      "exchangeDetails": {
        "toAmount": {
          "value": 5,
          "currency": "CAD",
          "zero": false
        },
        "fromAmount": {
          "value": 3.54,
          "currency": "USD",
          "zero": false
        },
        "rate": 1.41395
      },
      "runningBalance": {
        "value": 721.23,
        "currency": "USD",
        "zero": false
      },
      "referenceNumber": "TRANSFER-2247430954",
      "attachment": null,
      "activityAssetAttributions": []
    },
    {
      "type": "CREDIT",
      "date": "2026-07-13T02:39:26.338662Z",
      "amount": {
        "value": 600,
        "currency": "USD",
        "zero": false
      },
      "totalFees": {
        "value": 0,
        "currency": "USD",
        "zero": true
      },
      "details": {
        "type": "DEPOSIT",
        "description": "Received money from Kristine Sandt with reference ",
        "senderName": "Kristine Sandt",
        "senderAccount": "Unknown bank account",
        "paymentReference": "",
        "recipientAccountNumber": "",
        "recipientAccountDetailsId": null
      },
      "exchangeDetails": null,
      "runningBalance": {
        "value": 762.18,
        "currency": "USD",
        "zero": false
      },
      "referenceNumber": "TRANSFER-2246160468",
      "attachment": null,
      "activityAssetAttributions": []
    },
    {
      "type": "CREDIT",
      "date": "2026-07-02T10:05:43.227535Z",
      "amount": {
        "value": 800,
        "currency": "USD",
        "zero": false
      },
      "totalFees": {
        "value": 0,
        "currency": "USD",
        "zero": true
      },
      "details": {
        "type": "MONEY_ADDED",
        "description": "Topped up account"
      },
      "exchangeDetails": {
        "toAmount": {
          "value": 800,
          "currency": "USD",
          "zero": false
        },
        "fromAmount": {
          "value": 1136.36,
          "currency": "CAD",
          "zero": false
        },
        "rate": 0.704
      },
      "runningBalance": {
        "value": 1072.78,
        "currency": "USD",
        "zero": false
      },
      "referenceNumber": "TRANSFER-2223856519",
      "attachment": null,
      "activityAssetAttributions": []
    }
  ],
  "startOfStatementBalance": {
    "value": 0,
    "currency": "USD",
    "zero": true
  },
  "endOfStatementBalance": {
    "value": 1208.57,
    "currency": "USD",
    "zero": false
  }
}
`;

/** Every parsed row is ordinary — this parser never emits transfers, by design (see src/import/wise-json.ts point 3). */
function ordinaryRows(fileText: string): ParsedOrdinary[] {
  const result = parseWiseJson(fileText);
  for (const row of result.rows) expect(row.kind).toBe('ordinary');
  return result.rows as ParsedOrdinary[];
}

function byImportId(rows: ParsedOrdinary[], importId: string): ParsedOrdinary {
  const found = rows.find((row) => row.importId === importId);
  if (!found) throw new Error(`no row with importId ${importId}; got ${rows.map((r) => r.importId).join(', ')}`);
  return found;
}

describe('parseWiseJson', () => {
  it('parses an ordinary FX-funded card purchase', () => {
    const rows = ordinaryRows(CAD_STATEMENT);
    const row = byImportId(rows, 'CARD-4193630446:2026-08-14T16:36:49.421391Z');

    expect(row.date).toBe('2026-08-14');
    // -5.62 CAD is the whole balance impact. The 0.02 fee is INSIDE it, so
    // adding totalFees again (as the CSV parser must, for its own format)
    // would overstate the outflow.
    expect(row.amountMinor).toBe(-562);
    expect(row.currencyCode).toBe('CAD');
    expect(row.payeeName).toBe('Usps Po 2384810904');
    expect(row.providerCategory).toBe('Postal Services Government Only');
    expect(row.memo).toBe('incl. 0.02 CAD fee');
  });

  it('keys rows by reference AND timestamp, because a reference alone is not unique', () => {
    const rows = ordinaryRows(USD_STATEMENT);
    const ids = rows.map((row) => row.importId);
    expect(new Set(ids).size).toBe(ids.length);

    // CARD-4070294539 is present twice; only the timestamp separates them.
    const shared = ids.filter((id) => id.startsWith('CARD-4070294539:'));
    expect(shared).toHaveLength(2);
  });

  describe('one reference covering several rows', () => {
    it('keeps a tip as its own row rather than merging it into the base charge', () => {
      const rows = ordinaryRows(USD_STATEMENT);
      const base = byImportId(rows, 'CARD-4070294539:2026-07-17T18:22:34.227868Z');
      const tip = byImportId(rows, 'CARD-4070294539:2026-07-18T16:14:59.964161Z');

      expect(base.amountMinor).toBe(-1593);
      expect(tip.amountMinor).toBe(-300);
      // A day apart, which is exactly why they cannot be recognised by
      // adjacency or by sharing a date.
      expect(base.date).toBe('2026-07-17');
      expect(tip.date).toBe('2026-07-18');
      // Together they are the 18.93 fare Wise reports as details.amount.
      expect(base.amountMinor + tip.amountMinor).toBe(-1893);
    });

    it('keeps both halves of an over-authorisation that was partly refunded', () => {
      const rows = ordinaryRows(USD_STATEMENT);
      const charge = byImportId(rows, 'CARD-4113574733:2026-07-27T15:09:01.719382Z');
      const refund = byImportId(rows, 'CARD-4113574733:2026-07-27T18:26:43.401645Z');

      expect(charge.amountMinor).toBe(-16088);
      expect(refund.amountMinor).toBe(1170);
      expect(charge.amountMinor + refund.amountMinor).toBe(-14918);
    });

    it('keeps a returned transfer as two dated rows instead of netting it to nothing', () => {
      const rows = ordinaryRows(USD_STATEMENT);
      const sent = byImportId(rows, 'TRANSFER-2247430954:2026-07-13T15:13:42.197271Z');
      const returned = byImportId(rows, 'TRANSFER-2247430954:2026-07-21T07:28:58.621709Z');

      expect(sent.amountMinor).toBe(-495);
      expect(returned.amountMinor).toBe(495);

      // The whole point: these net to zero, and netting them at parse time
      // would erase the eight days the money was actually gone — which the
      // daily net-worth report (src/domain/reports.ts) would then report
      // as a balance that never dipped.
      expect(sent.amountMinor + returned.amountMinor).toBe(0);
      expect(sent.date).toBe('2026-07-13');
      expect(returned.date).toBe('2026-07-21');
    });
  });

  describe('a purchase split across two balances', () => {
    it('emits each balance its own share, not the full purchase twice', () => {
      const cadLeg = byImportId(ordinaryRows(CAD_STATEMENT), 'CARD-4145111585:2026-08-03T17:11:26.83651Z');
      const usdLeg = byImportId(ordinaryRows(USD_STATEMENT), 'CARD-4145111585:2026-08-03T17:11:26.777876Z');

      // 34.50 USD of groceries: 23.32 USD straight from the USD balance,
      // the remaining 11.18 USD bought with 15.77 CAD.
      expect(cadLeg.amountMinor).toBe(-1577);
      expect(cadLeg.currencyCode).toBe('CAD');
      expect(usdLeg.amountMinor).toBe(-2332);
      expect(usdLeg.currencyCode).toBe('USD');
    });

    it('says so in the memo, since both rows are described as the full amount', () => {
      const cadLeg = byImportId(ordinaryRows(CAD_STATEMENT), 'CARD-4145111585:2026-08-03T17:11:26.83651Z');
      expect(cadLeg.memo).toContain('Part of 34.5 USD');
      expect(cadLeg.memo).toContain('this balance funded 11.18 USD');
    });
  });

  describe('non-card rows', () => {
    it('reads a top-up as money arriving, not as a conversion out of another balance', () => {
      const row = byImportId(ordinaryRows(CAD_STATEMENT), 'TRANSFER-2270774033:2026-07-28T10:05:13.771015Z');

      // This exact transaction is the one the CSV parser originally got
      // wrong: Wise labels a top-up as direction IN with the user's name on
      // BOTH sides, so matching on names alone made it an internal
      // conversion and emitted 1900.31 CAD LEAVING the balance. details.type
      // is MONEY_ADDED, which admits no such ambiguity.
      expect(row.amountMinor).toBe(190000);
      expect(row.currencyCode).toBe('CAD');
      // No counterparty is invented for "Topped up account".
      expect(row.payeeName).toBeNull();
      expect(row.payeeRaw).toBe('Topped up account');
    });

    it('records the funding currency of a cross-currency top-up in the memo', () => {
      const row = byImportId(ordinaryRows(USD_STATEMENT), 'TRANSFER-2223856519:2026-07-02T10:05:43.227535Z');
      expect(row.amountMinor).toBe(80000);
      expect(row.currencyCode).toBe('USD');
      expect(row.memo).toBe('1136.36 CAD → 800 USD');
    });

    it('lifts a person out of a deposit description', () => {
      const row = byImportId(ordinaryRows(USD_STATEMENT), 'TRANSFER-2246160468:2026-07-13T02:39:26.338662Z');
      expect(row.amountMinor).toBe(60000);
      expect(row.payeeName).toBe('Kristine Sandt');
      // The raw text keeps the trailing "with reference" that the name
      // extraction drops, so a payee_rule can still match on it.
      expect(row.payeeRaw).toBe('Received money from Kristine Sandt with reference ');
    });
  });

  it('reports every currency the statement touches', () => {
    expect(parseWiseJson(CAD_STATEMENT).currencies).toEqual(['CAD']);
    expect(parseWiseJson(USD_STATEMENT).currencies).toEqual(['USD']);
  });

  it('counts every row it was given, including ones it emitted separately', () => {
    const result = parseWiseJson(USD_STATEMENT);
    expect(result.rowCount).toBe(9);
    expect(result.rows).toHaveLength(9);
    expect(result.skipped).toEqual([]);
  });

  it('skips a row missing the fields it is keyed on, rather than inventing them', () => {
    const result = parseWiseJson(
      JSON.stringify({ transactions: [{ type: 'DEBIT', details: { type: 'CARD' }, referenceNumber: 'CARD-1' }] }),
    );
    expect(result.rows).toEqual([]);
    expect(result.skipped).toEqual([{ reference: 'CARD-1', reason: 'missing referenceNumber, date or amount' }]);
    expect(result.rowCount).toBe(1);
  });

  it('rejects a file that is not a Wise statement', () => {
    expect(() => parseWiseJson('not json at all')).toThrow(/not valid JSON/);
    expect(() => parseWiseJson('{"foo":1}')).toThrow(/no `transactions` array/);
  });
});

describe('checkStatementBalance', () => {
  it('confirms the parsed movement reproduces the balance Wise reports', () => {
    expect(checkStatementBalance(CAD_STATEMENT)).toBeNull();
    expect(checkStatementBalance(USD_STATEMENT)).toBeNull();
  });

  it('reports a discrepancy rather than staying silent', () => {
    const tampered = JSON.parse(CAD_STATEMENT) as { endOfStatementBalance: { value: number } };
    tampered.endOfStatementBalance.value += 10;
    expect(checkStatementBalance(JSON.stringify(tampered))).toMatch(/does not balance/);
  });
});

describe('suggestedCategoryName', () => {
  it('matches by prefix, because Wise truncates long MCC descriptions', () => {
    // Verbatim from the real statements — note both are cut mid-word.
    expect(suggestedCategoryName('Service Stations (with or withou')).toBe('Transportation');
    expect(suggestedCategoryName('Grocery Stores, Supermarkets')).toBe('Groceries');
    expect(suggestedCategoryName('Eating Places, Restaurants')).toBe('Dining Out');
  });

  it('offers nothing rather than guessing when there is no confident match', () => {
    expect(suggestedCategoryName('Postal Services Government Only')).toBeNull();
    expect(suggestedCategoryName(null)).toBeNull();
  });
});
