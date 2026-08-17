// ULID: 26-char, Crockford base32, lexicographically sortable by time.
// Chosen over UUID because sort order matches insertion order (index-friendly,
// no random page splits) and IDs can be generated client-side later for
// offline-first support without a server round trip.

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford's base32, no I L O U
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number): string {
  let mut = now;
  let str = '';
  for (let i = TIME_LEN; i > 0; i--) {
    const mod = mut % ENCODING_LEN;
    str = ENCODING.charAt(mod) + str;
    mut = (mut - mod) / ENCODING_LEN;
  }
  return str;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(bytes);
  let str = '';
  for (let i = 0; i < RANDOM_LEN; i++) {
    str += ENCODING.charAt((bytes[i] ?? 0) % ENCODING_LEN);
  }
  return str;
}

/** Generates a new ULID using the current time. */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}
