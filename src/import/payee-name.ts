// Generic, provider-agnostic payee-name cleanup. Runs at the route layer
// (src/routes/imports.ts) over EVERY provider's output when no payee_rule
// matches — not just BECU's, the format that motivated it — which is what
// makes it different from a parser-local heuristic: a future provider that
// hands back raw, unprocessed text still gets this pass for free.
//
// Deliberately best-effort, not exhaustive — see docs/plan.md's PR 9 notes
// for the two known-imperfect cases on the real BECU sample this shipped
// against ("TRADER JOE S #652      SILVER SPRINGMDUS" keeps its city/state
// tail; "WEB - KRISTINE SANDT 867...WISE" collapses to just "WEB"). That
// imperfection is intentional and is the whole point of pairing this with
// src/import/rules.ts: a hand-tuned regex chasing every real-world
// statement format would grow without bound and still lose to a human
// noticing a name is wrong once and writing a one-line override. Rules
// match the FULL raw description, never this function's output, so nothing
// this heuristic throws away is unrecoverable.
//
// Pure: no I/O, no DB, no Cloudflare imports.

const DIGIT_TOKEN_RE = /^\d{2,}$/;
// A trailing phone number, however it's punctuated — "(800)233-2328",
// "800.233.2328", "800-233-2328" — with an optional space/dash before it.
const PHONE_SUFFIX_RE = /\s*\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}$/;

/**
 * Best-effort merchant name out of a raw statement description. Two passes:
 *
 * 1. A leading auth/reference number ("160000101207 GIANT FOOD…") is never
 *    the merchant name — dropped outright, keeping everything after it.
 * 2. Find the LEFTMOST of three cut triggers in what remains, and truncate
 *    there: a token starting with `*` (card-network "MERCHANT *SUBMERCHANT"
 *    — the merchant name is kept THROUGH this token), an isolated ` - `
 *    separator, or a standalone 2+-digit number that has more tokens after
 *    it (an address/reference number starting — kept only when something
 *    real follows, so a genuine trailing number like "Studio 54" survives).
 *    Leftmost-wins rather than a fixed rule-type priority, because
 *    whichever trigger sits closest to the start of the string is the one
 *    that actually bounds the name — see test/import/payee-name.test.ts's
 *    "WEB - KRISTINE SANDT 867…" case, where a later standalone number
 *    would otherwise win over an earlier, more meaningful ` - ` cut.
 *
 * A trailing phone number is stripped unconditionally at the end (whether
 * or not a cut fired above), and whitespace is collapsed throughout.
 */
export function cleanPayeeName(raw: string): string {
  let tokens = raw.trim().split(/\s+/).filter((t) => t !== '');

  if (tokens.length > 0 && DIGIT_TOKEN_RE.test(tokens[0]!)) {
    tokens = tokens.slice(1);
  }

  let cutAt: number | undefined;
  let keepTrigger = false; // true only for '*token' — the trigger itself is part of the name

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith('*')) {
      cutAt = i;
      keepTrigger = true;
      break;
    }
    if (token === '-') {
      cutAt = i;
      break;
    }
    if (DIGIT_TOKEN_RE.test(token) && i < tokens.length - 1) {
      cutAt = i;
      break;
    }
  }

  if (cutAt !== undefined) {
    tokens = tokens.slice(0, keepTrigger ? cutAt + 1 : cutAt);
  }

  return tokens.join(' ').replace(PHONE_SUFFIX_RE, '').trim();
}
